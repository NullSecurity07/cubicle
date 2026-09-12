import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, appendEntry, readLedger, listJobs, listInbox, readJob, updateJob, RUNWAY_PATH, type Vault } from '@cubicle/core';
import { Router, QuotaTracker, parseProvidersConfig } from '@cubicle/router';
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
/** The `Needs owner:` fact line the brief carries, which is where `moneyNeedsYou`'s rows have to land. */
const needsOwner = () => latestBrief().split('\n').find((l) => l.startsWith('Needs owner:')) ?? '';
/**
 * A cycle run from the top — so the `money` step genuinely runs, which is the point — and then moved on to its
 * brief by hand. A funded heartbeat blocks on its own `company.plan` job, and driving the planning rounds for
 * real would need a scripted model for the CEO, the board and every division lead; these cases are about what
 * the `brief` step says about money, not about planning, so the checkpoint is written straight to `brief`,
 * skipping `board_premortem`, `owner_verdict` and `division_plans`. `packages/daemon/test/planning.test.ts`
 * is where the fan-out is driven end to end.
 */
const briefAfterFullCycle = async (trigger: string): Promise<string> => {
  const id = createHeartbeatJob(vault, trigger);
  expect((await runHeartbeat(deps(), id)).status).toBe('blocked');
  updateJob(vault, id, { status: 'queued', checkpoint_step: HEARTBEAT_STEPS.indexOf('brief'), blocked_on: undefined }, 'daemon');
  expect((await runHeartbeat(deps(), id)).status).toBe('done');
  return latestBrief();
};

/** A priced providers file, so `writeRunway` and `accrueModelCost` have something real to price against. */
const PRICED = `
cascade: [paid]
providers:
  - id: paid
    base_url: https://example.test/v1
    models:
      - { id: big, tier: strong, tools: native, limits: { rpd: 100 }, price: { input_per_mtok: 300, output_per_mtok: 1500 } }
`;
const withRouter = (): HeartbeatDeps => ({ ...deps(), router: new Router(parseProvidersConfig(PRICED), new QuotaTracker(vault.db), { env: {} }) });

/**
 * Do directory modes actually stop a write here? Root ignores them, and so do some filesystems. One case below
 * makes `Ledger/` unwritable and asserts the append *failed*; where modes are advisory it would assert the
 * opposite of what happens, so it is skipped rather than made vague. Probed once, when this file loads.
 */
const NEEDS_MODES = 'needs a filesystem that enforces modes, and not root';
const MODES_ENFORCED: boolean = (() => {
  if (process.getuid?.() === 0) return false;
  const probe = mkdtempSync(path.join(tmpdir(), 'cubicle-mode-probe-'));
  try {
    chmodSync(probe, 0o555);
    try { writeFileSync(path.join(probe, 'probe'), 'x'); return false; } catch { return true; }
  } catch { return false; } finally {
    try { chmodSync(probe, 0o755); } catch { /* best effort */ }
    rmSync(probe, { recursive: true, force: true });
  }
})();

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

  it('jumps to the brief in one write, so a kill mid-jump never lets a stopped company plan', async () => {
    seed('2026-09-10T08:00:00.000Z', 25000, 'Seed');
    spend('2026-09-11T08:00:00.000Z', 25000, 'All of it');
    const id = createHeartbeatJob(vault, 'test');
    // Every checkpoint the cycle is ever *durably* on, sampled from inside the write that puts it there — which
    // is precisely the set a `kill -9` can strand the job at. The dormant path must never leave one between
    // `money` and `brief`: checkpointed at `reconcile_brand`, the resumed cycle does not re-run `money`,
    // nothing re-checks dormancy until the brief, and a stopped company spends a full planning round.
    const seen: string[] = [];
    const off = vault.events.on('vault.wrote', (e) => {
      if (e.payload.path !== `Jobs/${id}.md`) return;
      seen.push(HEARTBEAT_STEPS[readJob(vault, id)?.data.checkpoint_step ?? -1] ?? 'end');
    });
    try { await runHeartbeat(deps(), id); } finally { off(); }
    expect(seen).toContain('money');                                // it did stop at the money step
    expect(seen).toContain('brief');                                // and the next checkpoint is the brief
    for (const step of ['reconcile_brand', 'answer_owner', 'discovery', 'ideas_board', 'meeting', 'company_plan', 'board_premortem', 'owner_verdict', 'division_plans']) {
      expect(seen).not.toContain(step);
    }
    expect(readJob(vault, id)!.body).toContain('step 2 money: dormant');

    // Now the kill: put the job back on the checkpoint the jump wrote, throw the cache away, and resume.
    updateJob(vault, id, { status: 'queued', checkpoint_step: HEARTBEAT_STEPS.indexOf('brief'), blocked_on: undefined }, 'daemon');
    const stateFile = vault.abs(`.cubicle/jobs/${id}.heartbeat.json`);
    if (existsSync(stateFile)) unlinkSync(stateFile);
    calls = 0;
    expect((await runHeartbeat(deps(), id)).status).toBe('done');
    expect(calls).toBe(0);
    expect(listJobs(vault).some((j) => ['company.plan', 'division.plan', 'board.premortem'].includes(j.type))).toBe(false);
  });

  it('puts the runway warning in the brief only when the runway is short', async () => {
    seed('2026-09-11T08:00:00.000Z', 10000, 'Seed');
    spend('2026-09-11T08:00:00.000Z', 9000, 'Hosting');              // USD 10 left against USD 45 a day
    const brief = await briefAfterFullCycle('test');
    expect(brief).toContain('Runway is');                            // not dormant: there is still cash
    expect(needsOwner()).toContain('Runway is');
    expect(needsOwner()).toContain('add capital');
  });

  it('says nothing about money in "what needs you" when nothing does', async () => {
    seed('2026-09-11T08:00:00.000Z', 25000, 'Seed');                 // funded, nothing spent, nothing to say
    await briefAfterFullCycle('test');
    const row = needsOwner();
    expect(row).not.toContain('Runway is');
    expect(row).not.toContain('is dormant');
    expect(row).not.toContain('cannot be read');
    expect(latestBrief()).toContain('USD 250.00 cash');              // the fact line is there every cycle regardless
  });

  it('revives on a capital row: the next cycle says we are back and plans again', async () => {
    seed('2026-09-10T08:00:00.000Z', 25000, 'Seed');
    spend('2026-09-11T08:00:00.000Z', 25000, 'All of it');
    expect((await runHeartbeat(deps(), createHeartbeatJob(vault, 'dormant'))).status).toBe('done');
    seed('2026-09-12T09:00:00.000Z', 10000, 'Topping up');
    const id = createHeartbeatJob(vault, 'revived');
    expect((await runHeartbeat(deps(), id)).status).toBe('blocked');           // planning again
    expect(readJob(vault, id)!.body).toContain('told the owner we are back');
    const back = listInbox(vault).find((n) => (n.data as { money?: string }).money === 'revived')!;
    expect(back.body).toContain('Back to work');
    expect(back.body).toContain('the company is running again');
    expect(listJobs(vault).some((j) => j.type === 'company.plan')).toBe(true);
    expect(listJobs(vault).some((j) => j.type === 'finance.runway')).toBe(true);

    // Out again. This is a *second* dormancy, not the first one still standing, so the owner is told a second
    // time — the silence that keeps two consecutive dormant cycles quiet must not swallow a fresh episode.
    spend('2026-09-12T10:00:00.000Z', 10000, 'All of that too');
    const again = createHeartbeatJob(vault, 'dormant again');
    expect((await runHeartbeat(deps(), again)).status).toBe('done');
    const notes = listInbox(vault).filter((n) => (n.data as { money?: string }).money === 'dormant');
    expect(notes.length).toBe(2);
    expect(new Set(notes.map((n) => n.data.id)).size).toBe(2);        // a distinct note, not the first rewritten
    expect(readJob(vault, again)!.body).toContain('told the owner');
  });

  it('books yesterday\'s paid calls into the ledger before it reads the position', async () => {
    seed('2026-09-11T08:00:00.000Z', 25000, 'Seed');
    // A day's worth of calls on the priced model, dated yesterday: today is never charged, because the day is
    // not over and a part-day charge would be charged again this evening.
    for (const ts of ['2026-09-11T10:00:00.000Z', '2026-09-11T20:00:00.000Z']) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts, payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    }
    const id = createHeartbeatJob(vault, 'test');
    expect((await runHeartbeat(withRouter(), id)).status).toBe('blocked');
    expect(readJob(vault, id)!.body).toContain('accrued USD 6.00 of model cost');
    const row = readLedger(vault).entries.find((e) => e.ref === 'model-2026-09-11')!;
    expect(row).toMatchObject({ kind: 'cost', cents: 600, mode: 'live', who: 'daemon' });
    // Accrued *first*, so the position the cycle reports already has the spend in it.
    expect(readJob(vault, id)!.body).toContain('USD 244.00 cash');
    // And a second cycle the same day charges nothing twice.
    const second = createHeartbeatJob(vault, 'second');
    await runHeartbeat(withRouter(), second);
    expect(readJob(vault, second)!.body).not.toContain('of model cost');
    expect(readLedger(vault).entries.filter((e) => e.ref === 'model-2026-09-11').length).toBe(1);
  });

  it('a token count that is not a number costs nothing, and an accrual that cannot be booked warns instead of killing the cycle (I1)', async () => {
    seed('2026-09-11T08:00:00.000Z', 25000, 'Seed');
    // One `router.call` whose `tokens` payload is a string — a provider that answered without usage, a rebuilt
    // log, a hand-typed row. Before the guard this made `cents: NaN`, which `LedgerEntry.parse` threw on, out of
    // the money step at index 1: no brief, no plan, no money line, and a heartbeat that requeued into the same
    // throw for ever.
    vault.events.emit({ type: 'router.call', agent: 'ceo', ts: '2026-09-11T10:00:00.000Z', payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 'x' } } });
    const id = createHeartbeatJob(vault, 'test');
    expect((await runHeartbeat(withRouter(), id)).status).toBe('blocked');       // planning, not dead
    expect(readJob(vault, id)!.body).toContain('step 2 money');
    expect(readJob(vault, id)!.body).toContain('USD 250.00 cash');
    expect(readLedger(vault).entries.some((e) => e.ref === 'model-2026-09-11')).toBe(false);
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'money.accrual')).toBe(false);
  });

  it.skipIf(!MODES_ENFORCED)(`an accrual the disk refuses warns and the cycle carries on (I1, ${NEEDS_MODES})`, async () => {
    seed('2026-09-11T08:00:00.000Z', 25000, 'Seed');
    vault.events.emit({ type: 'router.call', agent: 'ceo', ts: '2026-09-11T10:00:00.000Z', payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    // `Ledger/` readable but not writable: the book parses, the append cannot land. Not the owner's veto — that
    // is policy and degrades to one notice inside the walk — but a real write failure, which used to be the one
    // unguarded call in the step.
    chmodSync(vault.abs('Ledger'), 0o555);
    try {
      const id = createHeartbeatJob(vault, 'test');
      expect((await runHeartbeat(withRouter(), id)).status).toBe('blocked');
      const warned = vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'money.accrual');
      expect(warned).toHaveLength(1);
      expect(String(warned[0].payload.message)).toMatch(/EACCES|permission/i);
      // The step still finished, and the position it reported is the book's own — one failure, not a silence.
      expect(readJob(vault, id)!.body).toContain('step 2 money');
      expect(readJob(vault, id)!.body).toContain('USD 250.00 cash');
    } finally { chmodSync(vault.abs('Ledger'), 0o755); }
  });

  it('with a router it prices the book into the runway note, and a write that fails warns without stopping the cycle', async () => {
    seed('2026-09-11T08:00:00.000Z', 25000, 'Seed');
    const id = createHeartbeatJob(vault, 'test');
    expect((await runHeartbeat(withRouter(), id)).status).toBe('blocked');
    const note = vault.readText(RUNWAY_PATH);
    expect(note).not.toContain('after the first heartbeat');                   // regenerated, not the scaffold
    expect(note).toContain('**Cash:** USD 250.00');
    expect(note).toContain('## What a paid tier would have cost');
    expect(vault.events.count('daemon.warning')).toBe(0);

    // Now make the write fail the way a disk does, and run another cycle: the note is a report, never the
    // cycle, so the company carries on and the owner gets a warning rather than a stopped heartbeat.
    const abs = vault.abs(RUNWAY_PATH);
    rmSync(abs, { force: true });
    mkdirSync(abs);
    const second = createHeartbeatJob(vault, 'second');
    expect((await runHeartbeat(withRouter(), second)).status).toBe('blocked'); // still planning
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'money.runway')).toBe(true);
    expect(readJob(vault, second)!.body).toContain('step 2 money');
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
