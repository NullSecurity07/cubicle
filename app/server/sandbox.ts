import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensurePackages, packagesFor, pyodideVersion, readLock, type Lock } from './packages.ts';
import type { ToolContext } from './tools/registry.ts';

export type CodeJob = { language: 'python' | 'javascript'; code: string };
export type CodeResult = { ok: boolean; output: string };
// The person's own tools, as code may reach them: the names it may call, and one call at a time. Whoever knows what a
// person is offered builds this; the sandbox only carries the calls across the pipe it already has.
export type CodeTools = { names: string[]; call(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> };
type Frame = { t: 'call'; id: number; name: string; args?: Record<string, unknown> } | { t: 'done'; output: string; error?: string };

const TIME_LIMIT = 30_000;
const TIME_LIMIT_PACKAGES = 90_000;
let lock: Lock | undefined;
const OUTPUT_CHARS = 8000;
const RECEIPT_ARGS = 120;

// The sandbox itself knows nothing about the tool list, and must not: it is the wall. Whoever does puts a maker here
// once at start, and it is asked for one only when a run carries the person the code belongs to.
let offer: ((context: ToolContext) => CodeTools | null) | null = null;
export const offerToolsToCode = (make: ((context: ToolContext) => CodeTools | null) | null) => { offer = make; };

// Code a person wrote runs in its own Node process under the permission model: it can read Pyodide and the shared
// files folder, write only the shared files folder, and cannot open the network, start programs or spawn workers.
// Even code that breaks out of Python into JavaScript meets the same wall. It gets 30 seconds and 512 MB.
// Python packages from Pyodide's own list (pandas, numpy, matplotlib, scipy…) are fetched by the server on first use,
// checked against their published hashes, and handed to the sandbox from disk. Those runs get 90 seconds and 1 GB.
// `context` is whose code this is. With it, and a maker, the code may call that person's own tools; without either it
// runs exactly as it always did, which is what every other caller of this still gets.
export async function runCode(job: CodeJob, filesDir: string, cacheDir = process.env.STAGE_PY_PACKAGES ?? resolve(import.meta.dirname, '../.cache/pyodide-packages'), context?: ToolContext): Promise<CodeResult> {
  let packages: string[] = [];
  if (job.language === 'python') {
    try {
      lock ??= readLock();
      packages = packagesFor(job.code, lock);
      if (packages.length) await ensurePackages(packages, cacheDir, lock, pyodideVersion());
    } catch (error) { return { ok: false, output: `Error: ${(error as Error).message}` }; }
  }
  return execute(job, filesDir, packages, cacheDir, (context && offer?.(context)) || null);
}

function execute(job: CodeJob, filesDir: string, packages: string[], cacheDir: string, tools: CodeTools | null): Promise<CodeResult> {
  mkdirSync(filesDir, { recursive: true });
  const files = realpathSync(filesDir);
  const child = resolve(import.meta.dirname, 'sandbox-child.mjs');
  const pyodide = realpathSync(resolve(import.meta.dirname, '../node_modules/pyodide'));
  const limit = packages.length ? TIME_LIMIT_PACKAGES : TIME_LIMIT;
  const cache = packages.length ? realpathSync(cacheDir) : '';
  return new Promise((done) => {
    const run = spawn(process.execPath, [
      '--permission', `--allow-fs-read=${child}`, `--allow-fs-read=${pyodide}`, `--allow-fs-read=${files}`, `--allow-fs-write=${files}`, ...(cache ? [`--allow-fs-read=${cache}`] : []),
      `--max-old-space-size=${packages.length ? 1024 : 512}`, '--disable-warning=ExperimentalWarning', child, files, pyodide, cache,
    ], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    let result: { output: string; error?: string } | null = null;
    // The seconds belong to the code, not to a tool the parent is running for it: the clock is held while a call is
    // out there, so a slow search cannot eat the budget the code was promised.
    let left = limit;
    let started = Date.now();
    let timer = setTimeout(() => { run.kill('SIGKILL'); }, left);
    const hold = () => { clearTimeout(timer); left -= Date.now() - started; };
    const resume = () => { started = Date.now(); timer = setTimeout(() => { run.kill('SIGKILL'); }, Math.max(left, 0)); };
    // What the code asked its tools for, so the founder reads it in the receipt even though only what the code printed
    // goes back to the model.
    const receipts: string[] = [];
    // One frame after another, in the order they arrived: a call must be answered before the next one is looked at.
    let queue = Promise.resolve();
    const frame = async (line: string) => {
      const message = JSON.parse(line) as Frame;
      if (message.t === 'done') { result = message; return; }
      hold();
      const answer = tools ? await tools.call(message.name, message.args ?? {}).catch((error: Error) => ({ ok: false, text: `Failed: ${error.message}` })) : { ok: false, text: 'No tools are offered to code here.' };
      resume();
      receipts.push(`- ${message.name} ${JSON.stringify(message.args ?? {}).slice(0, RECEIPT_ARGS)} — ${answer.ok ? 'ok' : 'no'}`);
      if (run.exitCode === null && !run.killed) run.stdin.write(`${JSON.stringify({ t: 'result', id: message.id, ...answer })}\n`);
    };
    run.stdin.on('error', () => {});
    run.stdout.on('data', (chunk) => {
      const lines = (out + chunk).split('\n');
      out = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) queue = queue.then(() => frame(line)).catch(() => {});
    });
    run.stderr.on('data', (chunk) => { if (err.length < 4000) err += chunk; });
    run.on('close', async (code, signal) => {
      clearTimeout(timer);
      await queue;
      const used = receipts.length ? `\nTools you called from the code:\n${receipts.join('\n')}` : '';
      if (signal === 'SIGKILL') return done({ ok: false, output: `Stopped: the code ran longer than ${limit / 1000} seconds.${used}` });
      if (!result) return done({ ok: false, output: `The sandbox failed (exit ${code}). ${err.trim().split('\n').slice(-3).join(' ')}`.trim() });
      // The sandbox has no network, so nothing can be installed: say so once, plainly, instead of Pyodide's install advice.
      const missing = /module '([\w.]+)' is included in the Pyodide distribution|No module named '([\w.]+)'/.exec(result.error ?? '');
      const problem = missing ? `${missing[1] ?? missing[2]} is not available in this sandbox. It has the standard library and the Pyodide packages (pandas, numpy, matplotlib, scipy and others); nothing else can be installed. Rewrite the code without it.` : result.error;
      const text = [result.output, problem ? `Error: ${problem}` : ''].filter(Boolean).join('\n') || '(no output)';
      done({ ok: !result.error, output: `${text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n… (cut)` : text}${used}` });
    });
    // The job goes in as one line and the pipe stays open: a tool call goes out on it and its result comes back.
    run.stdin.write(`${JSON.stringify({ ...job, packages, toolNames: tools?.names ?? [] })}\n`);
  });
}
