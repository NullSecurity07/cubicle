/**
 * Shutdown signals: SIGTERM/SIGINT, and logind's PrepareForSleep over D-Bus (system bus, or
 * CUBICLE_DBUS_ADDRESS for a private test bus).
 *
 * The PrepareForSleep subscription is armed first; the delay inhibitor (so logind waits for the checkpoint,
 * default cap 5 s) is best-effort and can never disable detection. On the real system bus the lock is held
 * by a `systemd-inhibit` child: `login1.Inhibit` answers with a unix fd, which dbus-next cannot receive
 * without the native `usocket` build (the call simply never resolves). The child reads our stdin pipe, so it
 * exits — releasing the lock — the moment the daemon dies, even from `kill -9`.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface SleepWatcher { stop(): Promise<void> }

export async function watchSleep(onSleep: () => void, env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => undefined, timeoutMs = 4000): Promise<SleepWatcher | null> {
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => { timedOut = true; log(`dbus connect timed out after ${timeoutMs} ms; sleep detection disabled`); r(null); }, timeoutMs); timer.unref(); });
  const inner = watchSleepInner(onSleep, env, log);
  const result = await Promise.race([inner, timeout]);
  if (timer) clearTimeout(timer);
  if (timedOut) void inner.then((w) => w?.stop()).catch(() => undefined); // a late connection must not leak a bus or an inhibitor
  return result;
}

async function watchSleepInner(onSleep: () => void, env: NodeJS.ProcessEnv, log: (m: string) => void): Promise<SleepWatcher | null> {
  let dbus: typeof import('dbus-next');
  try { dbus = await import('dbus-next'); } catch { log('dbus-next unavailable; sleep detection disabled'); return null; }
  let bus: import('dbus-next').MessageBus;
  try {
    bus = env.CUBICLE_DBUS_ADDRESS ? dbus.sessionBus({ busAddress: env.CUBICLE_DBUS_ADDRESS }) : dbus.systemBus();
  } catch (err) { log(`dbus connect failed: ${(err as Error).message}`); return null; }
  bus.on('error', (err: Error) => log(`dbus error: ${err.message}`));
  let mgr: import('dbus-next').ClientInterface;
  try {
    const obj = await bus.getProxyObject('org.freedesktop.login1', '/org/freedesktop/login1');
    mgr = obj.getInterface('org.freedesktop.login1.Manager');
    mgr.on('PrepareForSleep', (start: boolean) => { if (start) { log('PrepareForSleep(true) received'); onSleep(); } });
    log('sleep watcher armed (login1.PrepareForSleep)');
  } catch (err) {
    log(`login1 unavailable: ${(err as Error).message}`);
    try { bus.disconnect(); } catch { /* ignore */ }
    return null;
  }
  const release = env.CUBICLE_DBUS_ADDRESS ? await inhibitViaBus(mgr, log) : spawnInhibitor(log);
  return {
    async stop() {
      try { release(); } catch { /* ignore */ }
      try { bus.disconnect(); } catch { /* ignore */ }
    },
  };
}

/** Private test bus: the fake login1 answers Inhibit with a plain integer. Time-boxed so a stuck call cannot delay startup. */
async function inhibitViaBus(mgr: import('dbus-next').ClientInterface, log: (m: string) => void, timeoutMs = 1500): Promise<() => void> {
  const call = (mgr.Inhibit('sleep', 'cubicle', 'checkpointing running jobs', 'delay') as Promise<unknown>).then(
    (fd) => ({ fd }),
    (err: Error) => { log(`inhibitor not granted: ${err.message}`); return null; },
  );
  const r = await Promise.race([call, new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), timeoutMs).unref())]);
  if (r === 'timeout') { log('inhibitor call did not return; continuing without a delay lock'); return () => undefined; }
  if (!r) return () => undefined;
  log('delay inhibitor held (login1.Inhibit)');
  const fd = r.fd as { close?: () => void } | null;
  return () => { try { if (fd && typeof fd.close === 'function') fd.close(); } catch { /* ignore */ } };
}

/** Real system bus: hold the delay lock from a child process that lives exactly as long as we do. */
function spawnInhibitor(log: (m: string) => void): () => void {
  let child: ChildProcess;
  let released = false;
  try {
    child = spawn('systemd-inhibit', ['--what=sleep', '--mode=delay', '--who=cubicle', '--why=checkpointing running jobs', 'cat'], { stdio: ['pipe', 'ignore', 'ignore'] });
  } catch (err) { log(`inhibitor not held: ${(err as Error).message}`); return () => undefined; }
  child.on('error', (err) => { if (!released) log(`inhibitor not held: ${err.message}`); });
  child.on('exit', (code, sig) => { if (!released) log(`inhibitor process exited early (${sig ?? code})`); });
  child.unref();
  (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  child.stdin?.on('error', () => undefined);
  log('delay inhibitor held (systemd-inhibit)');
  return () => {
    released = true;
    try { child.stdin?.end(); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  };
}

export function onProcessSignals(handler: (signal: string) => void): () => void {
  const h = (s: NodeJS.Signals) => handler(s);
  process.on('SIGTERM', h); process.on('SIGINT', h); process.on('SIGHUP', h);
  return () => { process.off('SIGTERM', h); process.off('SIGINT', h); process.off('SIGHUP', h); };
}
