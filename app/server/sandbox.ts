import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export type CodeJob = { language: 'python' | 'javascript'; code: string };
export type CodeResult = { ok: boolean; output: string };

const TIME_LIMIT = 30_000;
const OUTPUT_CHARS = 8000;

// Code a person wrote runs in its own Node process under the permission model: it can read Pyodide and the shared
// files folder, write only the shared files folder, and cannot open the network, start programs or spawn workers.
// Even code that breaks out of Python into JavaScript meets the same wall. It gets 30 seconds and 512 MB.
export function runCode(job: CodeJob, filesDir: string): Promise<CodeResult> {
  mkdirSync(filesDir, { recursive: true });
  const files = realpathSync(filesDir);
  const child = resolve(import.meta.dirname, 'sandbox-child.mjs');
  const pyodide = realpathSync(resolve(import.meta.dirname, '../node_modules/pyodide'));
  return new Promise((done) => {
    const run = spawn(process.execPath, [
      '--permission', `--allow-fs-read=${child}`, `--allow-fs-read=${pyodide}`, `--allow-fs-read=${files}`, `--allow-fs-write=${files}`,
      '--max-old-space-size=512', '--disable-warning=ExperimentalWarning', child, files, pyodide,
    ], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { run.kill('SIGKILL'); }, TIME_LIMIT);
    run.stdout.on('data', (chunk) => { out += chunk; });
    run.stderr.on('data', (chunk) => { if (err.length < 4000) err += chunk; });
    run.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return done({ ok: false, output: `Stopped: the code ran longer than ${TIME_LIMIT / 1000} seconds.` });
      try {
        const result = JSON.parse(out) as { output: string; error?: string };
        // The sandbox has no network, so nothing can be installed: say so once, plainly, instead of Pyodide's install advice.
        const missing = /module '([\w.]+)' is included in the Pyodide distribution|No module named '([\w.]+)'/.exec(result.error ?? '');
        const problem = missing ? `${missing[1] ?? missing[2]} is not available. This sandbox has the Python standard library only (csv, json, statistics, math, datetime, re…) and cannot install anything. Rewrite the code without it.` : result.error;
        const text = [result.output, problem ? `Error: ${problem}` : ''].filter(Boolean).join('\n') || '(no output)';
        done({ ok: !result.error, output: text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n… (cut)` : text });
      } catch {
        done({ ok: false, output: `The sandbox failed (exit ${code}). ${err.trim().split('\n').slice(-3).join(' ')}`.trim() });
      }
    });
    run.stdin.end(JSON.stringify(job));
  });
}
