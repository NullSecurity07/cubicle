import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, appendEntry, listJobs, listInbox, readJob, updateJob, RUNWAY_PATH, type Vault } from '@cubicle/core';
import { HEARTBEAT_STEPS, createHeartbeatJob, runHeartbeat, type HeartbeatDeps } from '../src/heartbeat.js';

let dir: string;
let vault: Vault;
let calls = 0;
/**
 * The same `Llm` shape `packages/daemon/test/daemon.test.ts`'s `fakeLlm` returns, reduced to what these cases
 * need: a counter. The count is the assertion that matters — a dormant cycle must make **zero** calls.
 */
const llm = {
  async chat() {
    calls++;
    return { content: 'Understood.', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 }, provider: 'fake', model: 'fake', tier: 'strong' as const, downgraded: false, parsedToolCalls: [] };
  },
};
const deps = (): HeartbeatDeps => ({ vault, llm: llm as unknown as HeartbeatDeps['llm'], now: () => new Date('2026-09-12T12:00:00.000Z') });

const seed = (at: string, cents: number, why: string) => appendEntry(vault, { at, kind: 'capital', cents, mode: 'live', who: 'owner', why }, 'owner');
const spend = (at: string, cents: number, why: string) => appendEntry(vault, { at, kind: 'cost', cents, mode: 'live', who: 'daemon', why }, 'daemon');
const latestBrief = () => vault.readText(vault.list('Runs', { ext: '.md' }).sort().at(-1)!);

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-money-step-'));
  vault = (await scaffoldVault(dir)).vault;
  calls = 0;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the money step (spec §5, §6)', () => {
  it('runs second, before anything is planned against the company', () => {
    expect(HEARTBEAT_STEPS[0]).toBe('gather');
    expect(HEARTBEAT_STEPS[1]).toBe('money');
    expect(HEARTBEAT_STEPS.indexOf('money')).toBeLessThan(HEARTBEAT_STEPS.indexOf('company_plan'));
  });

  it('a funded company reads its position, queues the daily runway job, and carries on to plan', async () => {
    seed('2026-09-11T08:00:00.000Z', 25000, 'Seed');
    const id = createHeartbeatJob(vault, 'test');
    // Like every other cycle with nobody at the keyboard, this one blocks on its own company.plan job. The
    // money step has already run by then — that is the whole point of it being second.
    const outcome = await runHeartbeat(deps(), id);
    expect(outcome.status).toBe('blocked');
    const log = readJob(vault, id)!.body;
    expect(log).toContain('step 2 money');
    expect(log).toContain('USD 250.00 cash');
    expect(listJobs(vault).some((j) => j.type === 'finance.runway')).toBe(true);
    expect(listInbox(vault).some((n) => (n.data as { money?: string }).money === 'dormant')).toBe(false);
  });

  it('an unfunded company is not dormant: it plans like any other', async () => {
    const id = createHeartbeatJob(vault, 'test');
    const outcome = await runHeartbeat(deps(), id);
    expect(outcome.status).toBe('blocked');                             // blocked on planning, not stopped
    expect(readJob(vault, id)!.body).toContain('USD 0.00 cash');
    expect(listInbox(vault).some((n) => (n.data as { money?: string }).money === 'dormant')).toBe(false);
    // It is working: it wrote a plan job and parked on it. The heartbeat itself does not call a model to get
    // that far — every step up to `company_plan` delegates or is arithmetic — so the honest assertion about
    // this cycle's own spend is zero, and "it is working" is the queued plan job, not a call count.
    expect(listJobs(vault).some((j) => j.type === 'company.plan')).toBe(true);
    expect(calls).toBe(0);
  });

  it('a company that has spent its capital stops at the money step and makes no model call at all', async () => {
    seed('2026-09-10T08:00:00.000Z', 25000, 'Seed');
    spend('2026-09-11T08:00:00.000Z', 25000, 'All of it');
    const id = createHeartbeatJob(vault, 'test');
    const outcome = await runHeartbeat(deps(), id);
    expect(outcome.status).toBe('done');                                // straight through to the brief
    expect(calls).toBe(0);                                              // not one model call on a dormant cycle
    const log = readJob(vault, id)!.body;
    expect(log).toContain('dormant');
    expect(log).toContain('skipped — the company is dormant');
    expect(listJobs(vault).some((j) => j.type === 'company.plan')).toBe(false);
    expect(listJobs(vault).some((j) => j.type === 'finance.runway')).toBe(false);   // no new work of any kind
    const note = listInbox(vault).find((n) => (n.data as { money?: string }).money === 'dormant')!;
    expect(note.body).toContain('capital');
    expect(latestBrief()).toContain('dormant');
  });

  it('says the same thing on the next dormant cycle without telling the owner twice', async () => {
    seed('2026-09-10T08:00:00.000Z', 25000, 'Seed');
    spend('2026-09-11T08:00:00.000Z', 25000, 'All of it');
    for (const trigger of ['first', 'second']) {
      const id = createHeartbeatJob(vault, trigger);
      expect((await runHeartbeat(deps(), id)).status).toBe('done');
    }
    expect(calls).toBe(0);
    expect(listInbox(vault).filter((n) => (n.data as { money?: string }).money === 'dormant').length).toBe(1);
    expect(readJob(vault, listJobs(vault).filter((j) => j.type === 'ceo.heartbeat').sort((a, b) => a.updated.localeCompare(b.updated)).at(-1)!.id)!.body)
      .toContain('the owner has already been told');
  });

  it('regenerates the runway note only when the router is there to price it', async () => {
    const id = createHeartbeatJob(vault, 'test');
    await runHeartbeat(deps(), id);
    // No router in these deps, so no providers file and no regeneration — and the cycle ran on regardless.
    expect(vault.readText(RUNWAY_PATH)).toContain('after the first heartbeat');
    expect(readJob(vault, id)!.body).toContain('step 2 money');
  });

  it('derives the brief\'s money from the ledger, so losing the cycle\'s state file changes nothing', async () => {
    seed('2026-09-10T08:00:00.000Z', 25000, 'Seed');
    spend('2026-09-11T08:00:00.000Z', 25000, 'All of it');
    const id = createHeartbeatJob(vault, 'test');
    // Park the cycle at the brief and throw the cache away, which is what a kill between the money step and the
    // brief leaves behind. The money line and the dormant guard are read out of the book, never out of the file.
    updateJob(vault, id, { checkpoint_step: HEARTBEAT_STEPS.indexOf('brief') }, 'daemon');
    const stateFile = vault.abs(`.cubicle/jobs/${id}.heartbeat.json`);
    if (existsSync(stateFile)) unlinkSync(stateFile);
    expect((await runHeartbeat(deps(), id)).status).toBe('done');
    expect(calls).toBe(0);                                              // still no draft: the company is stopped
    const brief = latestBrief();
    expect(brief).toContain('USD 0.00 cash');
    expect(brief).toContain('the company is dormant');
    expect(listJobs(vault).some((j) => j.type !== 'ceo.heartbeat')).toBe(false);   // nothing seeded for a stopped company
  });
});
