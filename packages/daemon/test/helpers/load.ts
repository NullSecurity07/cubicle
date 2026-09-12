import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';

/**
 * Wall-clock budgets for the tests that drive a real `Daemon` on real timers, scaled by how busy the machine is.
 *
 * These tests poll a condition every 100 ms against a fixed ceiling while a daemon ticks every 300 ms and a cycle
 * makes a few dozen vault writes. Six vitest workers each doing that — or an unrelated build in the next terminal
 * — stretches a heartbeat well past a budget chosen on an idle box, and the failure that produces is a red suite
 * that says nothing about the code. The budget is the one thing here that has to move with the machine; the
 * assertions themselves are conditions, never sleeps.
 *
 * Read **once**, when this module loads: vitest gives each test file its own module registry, so that is once per
 * file, and every case in it then judges itself against the same number rather than against whatever the load
 * happened to be at the moment it started.
 *
 * The scale is the 1-minute load halved and rounded up, capped at 4. Halved because this box has 16 cores and a
 * load of 2 is not contention at all; capped because past a point the honest answer to "it is still not done" is
 * a failure, not a longer wait — an actually hung test has to fail inside its own body, while the daemon it
 * started is still there to be stopped, rather than being killed from outside with the vault half torn down.
 */
const oneMinuteLoad = (): number => {
  try {
    const v = Number(readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)[0]);
    if (Number.isFinite(v) && v >= 0) return v;
  } catch { /* not Linux, or /proc not mounted */ }
  const v = loadavg()[0];
  return Number.isFinite(v) && v >= 0 ? v : 0;
};

export const LOAD_1M = oneMinuteLoad();
export const LOAD_SCALE = Math.max(1, Math.min(4, Math.ceil(LOAD_1M / 2)));

/** How long a `waitFor` may wait for a condition the daemon is working towards. */
export const WAIT_MS = 60_000 * LOAD_SCALE;
/**
 * The per-case budget. Comfortably more than `WAIT_MS` so a stuck case fails inside its own `try`, runs its
 * `finally`, and reports the condition it was waiting for — instead of vitest killing the body between the
 * daemon it started and the teardown that stops it.
 */
export const TEST_MS = 3 * WAIT_MS;
