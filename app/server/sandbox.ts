import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensurePackages, packagesFor, pyodideVersion, readLock, type Lock } from './packages.ts';

export type CodeJob = { language: 'python' | 'javascript'; code: string };
export type CodeResult = { ok: boolean; output: string };

const TIME_LIMIT = 30_000;
const TIME_LIMIT_PACKAGES = 90_000;
let lock: Lock | undefined;
const OUTPUT_CHARS = 8000;

// Code a person wrote runs in its own Node process under the permission model: it can read Pyodide and the shared
// files folder, write only the shared files folder, and cannot open the network, start programs or spawn workers.
// Even code that breaks out of Python into JavaScript meets the same wall. It gets 30 seconds and 512 MB.
// Python packages from Pyodide's own list (pandas, numpy, matplotlib, scipy…) are fetched by the server on first use,
// checked against their published hashes, and handed to the sandbox from disk. Those runs get 90 seconds and 1 GB.
export async function runCode(job: CodeJob, filesDir: string, cacheDir = process.env.STAGE_PY_PACKAGES ?? resolve(import.meta.dirname, '../.cache/pyodide-packages')): Promise<CodeResult> {
  let packages: string[] = [];
  if (job.language === 'python') {
    try {
      lock ??= readLock();
      packages = packagesFor(job.code, lock);
      if (packages.length) await ensurePackages(packages, cacheDir, lock, pyodideVersion());
    } catch (error) { return { ok: false, output: `Error: ${(error as Error).message}` }; }
  }
  return execute(job, filesDir, packages, cacheDir);
}

function execute(job: CodeJob, filesDir: string, packages: string[], cacheDir: string): Promise<CodeResult> {
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
    const timer = setTimeout(() => { run.kill('SIGKILL'); }, limit);
    run.stdout.on('data', (chunk) => { out += chunk; });
    run.stderr.on('data', (chunk) => { if (err.length < 4000) err += chunk; });
    run.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return done({ ok: false, output: `Stopped: the code ran longer than ${limit / 1000} seconds.` });
      try {
        const result = JSON.parse(out) as { output: string; error?: string };
        // The sandbox has no network, so nothing can be installed: say so once, plainly, instead of Pyodide's install advice.
        const missing = /module '([\w.]+)' is included in the Pyodide distribution|No module named '([\w.]+)'/.exec(result.error ?? '');
        const problem = missing ? `${missing[1] ?? missing[2]} is not available in this sandbox. It has the standard library and the Pyodide packages (pandas, numpy, matplotlib, scipy and others); nothing else can be installed. Rewrite the code without it.` : result.error;
        const text = [result.output, problem ? `Error: ${problem}` : ''].filter(Boolean).join('\n') || '(no output)';
        done({ ok: !result.error, output: text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n… (cut)` : text });
      } catch {
        done({ ok: false, output: `The sandbox failed (exit ${code}). ${err.trim().split('\n').slice(-3).join(' ')}`.trim() });
      }
    });
    run.stdin.end(JSON.stringify({ ...job, packages }));
  });
}
