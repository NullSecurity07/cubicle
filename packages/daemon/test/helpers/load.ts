import { readdirSync, readFileSync, statSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';

/**
 * How the tests that drive a real `Daemon` on real timers decide that they have waited long enough.
 *
 * **They do not measure the machine. They measure progress.** The old shape here read the 1-minute load average
 * *once, at module load*, and scaled a wall-clock ceiling by it. That is precisely backwards under `pnpm -r test`:
 * six package suites start within a second or two of each other, and a 1-minute average at that instant still
 * describes an idle box — so the run that most needed a bigger budget was the run that computed the smallest one.
 * B1 passing alone, failing occasionally in a parallel run, and failing with a timeout rather than a wrong
 * assertion, is that bug and not a slow daemon.
 *
 * A wait now fails only when **nothing has happened in the vault** for `STALL_MS` (scaled by the load read at the
 * moment of the wait, not at import). A machine four times slower simply takes four times longer while events
 * keep arriving; a genuinely hung daemon fails inside the test body, where the `finally` that stops it still runs.
 */

/** The 1-minute load average, read now. `/proc` first: it is the number the kernel keeps, on this box's OS. */
export function oneMinuteLoad(): number {
  try {
    const v = Number(readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)[0]);
    if (Number.isFinite(v) && v >= 0) return v;
  } catch { /* not Linux, or /proc not mounted */ }
  const v = loadavg()[0];
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * 1 to 4, from the load **at the moment it is asked**. Halved because this box has 16 cores and a load of 2 is
 * not contention at all; capped because past a point the honest answer to "it is still not moving" is a failure,
 * not a longer wait.
 */
export function loadScale(): number {
  return Math.max(1, Math.min(4, Math.ceil(oneMinuteLoad() / 2)));
}

/** How long the vault may be completely silent before a wait gives up. Multiplied by `loadScale()` when used. */
export const STALL_MS = 20_000;

/**
 * The per-case ceiling vitest enforces, and the last line of defence rather than the working budget: every wait
 * below fails on a stall long before this. Fixed, because a ceiling that moves with a load read at import is the
 * bug this file exists to fix, and because a case that is still making progress must never be killed between the
 * daemon it started and the teardown that stops it.
 */
export const TEST_MS = 600_000;

/**
 * A reading of "has anything happened in this vault", cheap enough to call every 100 ms: the name and size of the
 * newest file in the event log's JSONL mirror, which `EventLog.emit` appends to synchronously on every single
 * event. Two `stat`s a poll, no vault handle, and it works across processes.
 *
 * `dirOf` is a function because every one of these files creates its vault directory in `beforeEach`.
 */
export function eventProgress(dirOf: () => string): () => string {
  return () => {
    try {
      const d = path.join(dirOf(), '.cubicle', 'events');
      const files = readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort();
      const last = files.at(-1);
      return last ? `${last}:${statSync(path.join(d, last)).size}` : 'empty';
    } catch {
      return 'gone';                                  // before the vault exists, or after the teardown removed it
    }
  };
}

export interface StallWaitOpts {
  /** What counts as progress. `eventProgress(() => dir)` in every caller here. */
  progress: () => string | number;
  /** Silence budget before the wait fails, before scaling. Per call site, because some waits watch quieter work. */
  stallMs?: number;
  /** True once the case's teardown has begun, so a poll loop stops touching a directory that is being removed. */
  torn?: () => boolean;
  /** What the caller was waiting for, for the failure message. */
  what?: string;
}

/**
 * Poll `pred` on real timers until it holds, failing only when the vault has been silent for the stall budget.
 * The budget is computed on every poll, so contention that arrives *during* a wait lengthens it.
 */
/** A wait that keeps seeing progress but never its condition is still a failure; say so within this, not vitest's ceiling. */
export const STALL_TOTAL_MS = 300_000;
export async function waitForProgress(pred: () => boolean, o: StallWaitOpts): Promise<void> {
  let seen = o.progress();
  let lastChange = Date.now();
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > STALL_TOTAL_MS) throw new Error(`waitFor: ${o.what ?? 'a condition'} did not hold after ${STALL_TOTAL_MS} ms although the daemon kept writing (1-min load ${oneMinuteLoad().toFixed(2)})`);
    if (o.torn?.()) throw new Error('waitFor: torn down while still waiting');
    const now = o.progress();
    if (now !== seen) { seen = now; lastChange = Date.now(); }
    else {
      const budget = (o.stallMs ?? STALL_MS) * loadScale();
      const silent = Date.now() - lastChange;
      if (silent > budget) {
        throw new Error(`waitFor: the daemon wrote nothing for ${silent} ms while waiting for ${o.what ?? 'a condition'} (stall budget ${budget} ms, 1-min load ${oneMinuteLoad().toFixed(2)})`);
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
