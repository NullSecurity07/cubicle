/**
 * Acceptance test 9: SIGTERM → daemon checkpoints and exits within 5 s; a PrepareForSleep(true) signal from a
 * private dbus-daemon (fake login1) does the same; on restart the interrupted job resumes.
 * Usage: pnpm test:sleep
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const child = path.join(here, 'lib', 'sleep-child.ts');
const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sleep-'));

function startDaemon(env: NodeJS.ProcessEnv) {
  const p = spawn(process.execPath, ['--import', 'tsx/esm', '--conditions=development', child, 'daemon', dir], { cwd: root, env: { ...process.env, ...env } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  p.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
  const exited = new Promise<number | null>((r) => p.on('exit', r));
  return { p, exited, out: () => out };
}

async function waitOut(get: () => string, needle: string, ms: number) {
  const t0 = Date.now();
  while (!get().includes(needle)) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${needle}`); await new Promise((r) => setTimeout(r, 100)); }
}

async function main() {
  spawnSync(process.execPath, ['--import', 'tsx/esm', '--conditions=development', child, 'init', dir], { cwd: root, stdio: 'inherit' });
  let pass = true;

  // --- SIGTERM ---
  const a = startDaemon({});
  await waitOut(a.out, 'STEP 1 DONE', 20000);
  const t0 = Date.now();
  a.p.kill('SIGTERM');
  const codeA = await Promise.race([a.exited, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
  const dtA = Date.now() - t0;
  console.log(`\nSIGTERM → exit ${codeA} in ${dtA} ms`);
  if (codeA !== 0 || dtA > 5000) pass = false;
  if (existsSync(path.join(dir, '.cubicle/daemon.json'))) { console.log('daemon.json not removed'); pass = false; }

  // --- D-Bus PrepareForSleep from a private bus with a fake login1 ---
  const hasDbus = spawnSync('which', ['dbus-daemon']).status === 0;
  if (hasDbus) {
    const bus = spawn('dbus-daemon', ['--session', '--nofork', '--print-address', '--address=unix:tmpdir=' + tmpdir()], { stdio: ['ignore', 'pipe', 'inherit'] });
    const addr: string = await new Promise((r) => bus.stdout.once('data', (d) => r(String(d).trim())));
    const fake = spawn(process.execPath, ['--import', 'tsx/esm', '--conditions=development', child, 'fake-login1'], { cwd: root, env: { ...process.env, CUBICLE_DBUS_ADDRESS: addr }, stdio: ['pipe', 'pipe', 'inherit'] });
    let fakeOut = '';
    fake.stdout.on('data', (d) => { fakeOut += d; });
    await waitOut(() => fakeOut, 'FAKE LOGIN1 READY', 10000);
    const b = startDaemon({ CUBICLE_DBUS_ADDRESS: addr });
    await waitOut(b.out, 'sleep watcher armed', 20000);
    await waitOut(b.out, 'STEP 1 DONE', 20000);
    const t1 = Date.now();
    fake.stdin.write('sleep\n');
    const codeB = await Promise.race([b.exited, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
    const dtB = Date.now() - t1;
    console.log(`\nPrepareForSleep(true) → exit ${codeB} in ${dtB} ms`);
    if (codeB !== 0 || dtB > 5000) pass = false;
    fake.kill(); bus.kill();
  } else {
    console.log('dbus-daemon not installed; skipping the PrepareForSleep half');
  }

  // --- resume ---
  const c = startDaemon({ CUBICLE_FINISH: '1' });
  await waitOut(c.out, 'JOB DONE', 30000);
  c.p.kill('SIGTERM');
  await c.exited;
  const resumed = c.out().includes('RESUMED FROM STEP');
  console.log(`\nresume after restart: ${resumed ? 'yes' : 'NO'}`);
  if (!resumed) pass = false;
  console.log(pass ? '\nPASS: checkpoint + exit < 5 s on SIGTERM and sleep signal; job resumed' : '\nFAIL');
  rmSync(dir, { recursive: true, force: true });
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
