import { listJobs, type Vault } from '@cubicle/core';
import type { Daemon } from '../../src/index.js';

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

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * A cycle with no owner at the keyboard: wait for the first heartbeat, then keep asking for another until the
 * divisions have planned. Cycle 1 writes the plan and files the verdict note; a later heartbeat, once the switch
 * above has elapsed, lets the board's verdict stand and fans the divisions out. `requestHeartbeat` returns the
 * open heartbeat instead of creating a second one, so polling it is safe.
 */
export async function planUntilFannedOut(d: Daemon, v: Vault, expected: number, ms = 60000): Promise<void> {
  await waitFor(() => v.events.count('heartbeat.completed') >= 1, ms);
  const divisionPlans = () => listJobs(v).filter((j) => j.type === 'division.plan');
  const deadline = Date.now() + ms;
  while (divisionPlans().length < expected) {
    if (Date.now() > deadline) throw new Error(`only ${divisionPlans().length} division plan(s) after ${Math.round(ms / 1000)} s`);
    await new Promise((r) => setTimeout(r, 500));
    d.requestHeartbeat('the board decides');
  }
  await waitFor(() => divisionPlans().every((j) => ['done', 'failed', 'cancelled'].includes(j.status)), ms);
}
