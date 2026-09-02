/**
 * Acceptance test 1: kill -9 the daemon mid-job after 2 completed tool steps → restart → resumes at step 3,
 * no duplicate side effects. Uses a scripted model (CUBICLE_FAKE_LLM) and the mock outbound tool.
 * Usage: pnpm test:kill9
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-kill9-'));
const runner = path.join(here, 'lib', 'kill9-child.ts');

function child(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--conditions=development', runner, ...args], { cwd: root, env: { ...process.env, CUBICLE_MOCK_TOOLS: '1' } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    p.on('exit', (code) => resolve({ code, out }));
  });
}

async function main() {
  console.log(`vault: ${dir}`);
  await child(['init', dir]);
  // Phase A: start, run the 4-step job; the child prints "STEP 2 DONE" after checkpointing step 2 and then sleeps
  const a = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), '--conditions=development', runner, 'run', dir], { cwd: root, env: { ...process.env, CUBICLE_MOCK_TOOLS: '1', CUBICLE_HANG_AFTER_STEP: '2' } });
  let aOut = '';
  await new Promise<void>((resolve) => {
    a.stdout.on('data', (d) => { aOut += d; process.stdout.write(d); if (aOut.includes('STEP 2 DONE')) resolve(); });
    a.stderr.on('data', (d) => process.stderr.write(d));
    a.on('exit', () => resolve());
  });
  a.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  console.log('>>> killed -9 after step 2');
  const keysA = existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl')) ? readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n').length : 0;
  // Phase B: restart and let it finish
  const b = await child(['run', dir]);
  const keys = readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
  const ok = b.out.includes('RESUMED FROM STEP 2') && b.out.includes('JOB DONE step=4') && keys.length === 2 && new Set(keys).size === 2 && keysA === 1;
  console.log(`\nidempotency keys executed: ${JSON.stringify(keys)} (1 before kill, ${keys.length} total)`);
  console.log(ok ? 'PASS: resumed at step 3, no duplicate side effects' : 'FAIL');
  rmSync(dir, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
main();
