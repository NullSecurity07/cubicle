/**
 * Acceptance test 1: kill -9 the daemon mid-job after 2 completed tool steps → restart → resumes at step 3,
 * no duplicate side effects. Uses a scripted model (CUBICLE_FAKE_LLM) and the mock outbound tool.
 *
 * Acceptance test 12 (planning fan-out): kill -9 while the first `division.plan` job of a heartbeat is running →
 * restart → the heartbeat completes with exactly 2 `division.plan` jobs (one per division) and no duplicate
 * `engineer.ship` titles — the fan-out resumes, it does not re-plan from scratch. The fan-out happens on the
 * heartbeat after the board's verdict stands, not on the one that wrote the plan.
 *
 * Usage: pnpm test:kill9
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault, listJobs } from '@cubicle/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function child(runner: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx/esm', '--conditions=development', runner, ...args], { cwd: root, env: { ...process.env, CUBICLE_MOCK_TOOLS: '1', ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    p.on('exit', (code) => resolve({ code, out }));
  });
}

/** Spawn the daemon detached (own process group) and wait for `needle` in its stdout, then SIGKILL the group. */
async function runAndKill(runner: string, dir: string, env: NodeJS.ProcessEnv, needle: string): Promise<void> {
  const a = spawn(process.execPath, ['--import', 'tsx/esm', '--conditions=development', runner, 'run', dir], { cwd: root, env: { ...process.env, CUBICLE_MOCK_TOOLS: '1', ...env }, detached: true });
  let aOut = '';
  await new Promise<void>((resolve) => {
    a.stdout.on('data', (d) => { aOut += d; process.stdout.write(d); if (aOut.includes(needle)) resolve(); });
    a.stderr.on('data', (d) => process.stderr.write(d));
    a.on('exit', () => resolve());
  });
  const aExit = new Promise<void>((r) => a.on('exit', () => r()));
  try { process.kill(-a.pid!, 'SIGKILL'); } catch { a.kill('SIGKILL'); }
  await aExit; // reaped: the daemon pid is gone, daemon.json is stale
}

async function scenario1(): Promise<boolean> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-kill9-'));
  const runner = path.join(here, 'lib', 'kill9-child.ts');
  console.log(`vault: ${dir}`);
  await child(runner, ['init', dir]);
  // Phase A: start, run the 4-step job; the child prints "STEP 2 DONE" after checkpointing step 2 and then sleeps
  // detached → own process group, so SIGKILL reaches the real daemon (tsx runs it as a grandchild)
  await runAndKill(runner, dir, { CUBICLE_HANG_AFTER_STEP: '2' }, 'STEP 2 DONE');
  console.log('>>> killed -9 after step 2');
  const keysA = existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl')) ? readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n').length : 0;
  // Phase B: restart and let it finish
  const b = await child(runner, ['run', dir]);
  const keys = readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
  const ok = b.out.includes('RESUMED FROM STEP 2') && b.out.includes('JOB.INTERRUPTED EMITTED') && b.out.includes('stale daemon.json') && b.out.includes('JOB DONE step=4') && keys.length === 2 && new Set(keys).size === 2 && keysA === 1;
  console.log(`\nidempotency keys executed: ${JSON.stringify(keys)} (1 before kill, ${keys.length} total)`);
  console.log(ok ? 'PASS: resumed at step 3, no duplicate side effects' : 'FAIL');
  rmSync(dir, { recursive: true, force: true });
  return ok;
}

async function scenario2(): Promise<boolean> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-kill9-team-'));
  const runner = path.join(here, 'lib', 'kill9-team-child.ts');
  console.log(`\nvault (planning fan-out): ${dir}`);
  await child(runner, ['init', dir]);
  // Phase A: start a heartbeat cycle with the org-shaped scripted model; the child prints "DIVISION_PLAN RUNNING"
  // as soon as the first division.plan job's chat call starts (the job note is already status=running by then) and
  // hangs there — detached → own process group, so SIGKILL reaches the real daemon (tsx runs it as a grandchild)
  await runAndKill(runner, dir, { CUBICLE_HANG_DIVISION_PLAN: '1' }, 'DIVISION_PLAN RUNNING');
  console.log('>>> killed -9 while division.plan running');
  // Phase B: restart and let the heartbeat finish
  const b = await child(runner, ['run', dir]);
  const v = Vault.open(dir);
  const jobs = listJobs(v);
  v.close();
  const divisionPlans = jobs.filter((j) => j.type === 'division.plan');
  const shipTitles = jobs.filter((j) => j.type === 'engineer.ship').map((j) => j.title);
  const ok = b.out.includes('HEARTBEAT COMPLETED') && divisionPlans.length === 2 && new Set(shipTitles).size === shipTitles.length;
  console.log(`\ndivision.plan jobs: ${divisionPlans.length}, engineer.ship titles: ${JSON.stringify(shipTitles)}`);
  console.log(ok ? 'PASS: planning fan-out resumed without duplicate jobs' : 'FAIL');
  rmSync(dir, { recursive: true, force: true });
  return ok;
}

async function main() {
  const ok1 = await scenario1();
  const ok2 = await scenario2();
  process.exit(ok1 && ok2 ? 0 : 1);
}
main();
