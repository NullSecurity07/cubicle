/**
 * Shutdown signals: SIGTERM/SIGINT, and logind's PrepareForSleep over D-Bus (system bus, or
 * CUBICLE_DBUS_ADDRESS for a private test bus). Takes a delay inhibitor so logind waits (default cap 5 s).
 */
export interface SleepWatcher { stop(): Promise<void> }

export async function watchSleep(onSleep: () => void, env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => undefined, timeoutMs = 4000): Promise<SleepWatcher | null> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<null>((r) => { timer = setTimeout(() => { log(`dbus connect timed out after ${timeoutMs} ms; sleep detection disabled`); r(null); }, timeoutMs); timer.unref(); });
  const result = await Promise.race([watchSleepInner(onSleep, env, log), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

async function watchSleepInner(onSleep: () => void, env: NodeJS.ProcessEnv, log: (m: string) => void): Promise<SleepWatcher | null> {
  let dbus: typeof import('dbus-next');
  try { dbus = await import('dbus-next'); } catch { log('dbus-next unavailable; sleep detection disabled'); return null; }
  let bus: import('dbus-next').MessageBus;
  try {
    bus = env.CUBICLE_DBUS_ADDRESS ? dbus.sessionBus({ busAddress: env.CUBICLE_DBUS_ADDRESS }) : dbus.systemBus();
  } catch (err) { log(`dbus connect failed: ${(err as Error).message}`); return null; }
  let inhibitFd: import('dbus-next').Variant | unknown = null;
  try {
    const obj = await bus.getProxyObject('org.freedesktop.login1', '/org/freedesktop/login1');
    const mgr = obj.getInterface('org.freedesktop.login1.Manager');
    try {
      inhibitFd = await mgr.Inhibit('sleep', 'cubicle', 'checkpointing running jobs', 'delay');
    } catch (err) { log(`inhibitor not granted: ${(err as Error).message}`); }
    mgr.on('PrepareForSleep', (start: boolean) => { if (start) { log('PrepareForSleep(true) received'); onSleep(); } });
    log('sleep watcher armed (login1.PrepareForSleep)');
  } catch (err) {
    log(`login1 unavailable: ${(err as Error).message}`);
    try { bus.disconnect(); } catch { /* ignore */ }
    return null;
  }
  return {
    async stop() {
      try { if (inhibitFd && typeof (inhibitFd as { close?: () => void }).close === 'function') (inhibitFd as { close: () => void }).close(); } catch { /* ignore */ }
      try { bus.disconnect(); } catch { /* ignore */ }
    },
  };
}

export function onProcessSignals(handler: (signal: string) => void): () => void {
  const h = (s: NodeJS.Signals) => handler(s);
  process.on('SIGTERM', h); process.on('SIGINT', h); process.on('SIGHUP', h);
  return () => { process.off('SIGTERM', h); process.off('SIGINT', h); process.off('SIGHUP', h); };
}
