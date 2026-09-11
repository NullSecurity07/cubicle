import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, UnsafePathError, updateJob, createStream, listJobs } from '@cubicle/core';
import { type Llm } from '@cubicle/harness';
import { Daemon, defaultConfig } from '../src/index.js';

const root = path.resolve(__dirname, '../../..');
let dir: string; let vault: Vault;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-tick-iso-')); vault = (await scaffoldVault(dir)).vault;
  createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev', error_budget: 4 }, 'product_manager');
  // A company that has already run: requestHeartbeat's first-run gate is satisfied, and the elapsed-hours
  // trigger is due.
  vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' }, ts: new Date(Date.now() - 72 * 3600_000).toISOString() });
});
afterEach(() => { vi.restoreAllMocks(); vault.close(); rmSync(dir, { recursive: true, force: true }); });

/** Never called: the worker pool needs a model to construct. */
const idleLlm: Llm = {
  async chat() { return { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'cheap', downgraded: false, parsedToolCalls: [] }; },
  promptBudget: () => 6000,
};

const daemonFor = () => new Daemon(
  defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 60_000, maxConcurrentJobs: 1, providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml') }),
  { llm: idleLlm, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined },
);

/**
 * Make one sweep throw the way a model-controlled path does.
 *
 * `enqueueExperimentReviews` is the sweep chosen because it runs early, so everything the assertions care about
 * — the later sweeps and the heartbeat trigger — comes after it. The failure injected is the real one:
 * `UnsafePathError` out of a vault path call, which is what a `..` in any model-written path produces. The point
 * under test is the isolation, not which sweep happens to be the vector this week.
 */
function poisonExperimentSweep(v: Vault): void {
  const realList = v.list.bind(v);
  vi.spyOn(v, 'list').mockImplementation((dirRel: string, opts?: Parameters<Vault['list']>[1]) => {
    if (String(dirRel) === 'Experiments') throw new UnsafePathError('Experiments/../../etc');
    return realList(dirRel, opts);
  });
}

describe('one bad value costs one sweep, never the tick (fix wave item 4 / C2)', () => {
  it('a sweep that throws still lets the heartbeat trigger run, and says which sweep failed', async () => {
    const d = daemonFor();
    await d.start();
    try {
      // The daemon's start-up already ran a tick; clear the ground so the assertions are about this one.
      for (const j of listJobs(d.vault).filter((j) => j.type === 'ceo.heartbeat')) updateJob(d.vault, j.id, { status: 'done' }, 'daemon');
      poisonExperimentSweep(d.vault);
      const before = d.vault.events.query({ types: ['daemon.warning'] }).length;

      await d.runTick('test');

      const warnings = d.vault.events.query({ types: ['daemon.warning'] }).slice(before);
      expect(warnings.length).toBeGreaterThan(0);
      // Named per sweep, not the whole-tick catch: that is what proves the isolation.
      expect(warnings.map((w) => String(w.payload.where))).toContain('tick:experiment-reviews');
      expect(warnings.map((w) => String(w.payload.where))).not.toContain('tick');
      // And the sweeps after it, heartbeat trigger included, still ran.
      expect(listJobs(d.vault, { status: ['queued', 'running', 'blocked'] }).some((j) => j.type === 'ceo.heartbeat')).toBe(true);
    } finally { await d.stop(); }
  }, 30_000);

  it('the same poison on every tick never stops the heartbeat, tick after tick', async () => {
    const d = daemonFor();
    await d.start();
    try {
      poisonExperimentSweep(d.vault);
      for (let i = 0; i < 3; i++) {
        for (const j of listJobs(d.vault).filter((j) => j.type === 'ceo.heartbeat')) updateJob(d.vault, j.id, { status: 'done' }, 'daemon');
        d.vault.events.emit({ type: 'heartbeat.completed', payload: { id: `seed-${i}` }, ts: new Date(Date.now() - 72 * 3600_000).toISOString() });
        await d.runTick(`test-${i}`);
        expect(listJobs(d.vault, { status: ['queued', 'running', 'blocked'] }).some((j) => j.type === 'ceo.heartbeat'), `tick ${i}`).toBe(true);
      }
    } finally { await d.stop(); }
  }, 30_000);
});
