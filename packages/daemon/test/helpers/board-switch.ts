import { listJobs, type Vault } from '@cubicle/core';
import type { Daemon } from '../../src/index.js';
import { loadScale, waitForProgress } from './load.js';

/**
 * `board_decides_after_hours` ships at 0 — the plan waits for the owner for as long as the owner takes — so a
 * headless test with nobody at the keyboard would never see a plan fan out. ≈ 1.1 s: small enough for a test,
 * positive so that the board, and not a hard-coded default, closes the verdict.
 */
export const BOARD_DECIDES_AFTER_HOURS = 0.0003;

/** Hand the board the ruling in a scaffolded vault. Call it in `beforeEach`, before the daemon starts. */
export function letTheBoardDecide(vault: Vault, hours = BOARD_DECIDES_AFTER_HOURS): void {
  vault.writeText('Memory/constitution.md', vault.readText('Memory/constitution.md').replace(/^board_decides_after_hours:.*$/m, `board_decides_after_hours: ${hours}`), 'owner');
}

/** The newest event id: "has anything happened", straight off the live vault handle this helper is given. */
const progressOf = (v: Vault) => () => v.events.query({ limit: 1, order: 'desc' })[0]?.id ?? -1;

/**
 * A cycle with no owner at the keyboard: wait for the first heartbeat, then keep asking for another until the
 * divisions have planned. Cycle 1 writes the plan and files the verdict note; a later heartbeat, once the switch
 * above has elapsed, lets the board's verdict stand and fans the divisions out. `requestHeartbeat` returns the
 * open heartbeat instead of creating a second one, so polling it is safe.
 */
export async function planUntilFannedOut(d: Daemon, v: Vault, expected: number): Promise<void> {
  const progress = progressOf(v);
  await waitForProgress(() => v.events.count('heartbeat.completed') >= 1, { progress, what: 'the first heartbeat' });
  const divisionPlans = () => listJobs(v).filter((j) => j.type === 'division.plan');
  // Keep asking for another heartbeat while we wait. This is the one loop here that cannot be purely
  // stall-driven: asking is itself a write, so the vault is never silent while it runs, and the stall detector
  // would never fire. The ceiling is read from the load *now* rather than at import, which is the flake this
  // helper's budgets used to have.
  const poke = setInterval(() => { if (divisionPlans().length < expected) d.requestHeartbeat('the board decides'); }, 500);
  const deadline = Date.now() + 120_000 * loadScale();
  try {
    while (divisionPlans().length < expected) {
      if (Date.now() > deadline) throw new Error(`only ${divisionPlans().length} division plan(s) of ${expected}, and the company is still working`);
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    clearInterval(poke);
  }
  await waitForProgress(() => divisionPlans().every((j) => ['done', 'failed', 'cancelled'].includes(j.status)), { progress, what: 'the division plans to finish' });
  // And wait for the heartbeat to pick them up. `team.planned` is emitted by the `division_plans` step when the
  // heartbeat *resumes* — one tick after the last plan finishes — so a helper that returned on the job statuses
  // alone handed the caller a vault where the fan-out had happened but the company had not said so yet. That
  // race was invisible while the waits were wall-clock and long; it is a test bug either way. A plan that ended
  // `failed` or `cancelled` never gets an event, so the target is the number that finished `done`.
  const planned = () => divisionPlans().filter((j) => j.status === 'done').length;
  await waitForProgress(() => v.events.count('team.planned') >= planned(), { progress, what: 'the heartbeat to record the division plans' });
}
