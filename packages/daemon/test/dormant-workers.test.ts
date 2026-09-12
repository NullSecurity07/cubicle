import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, createJob, createProposal, findInboxById, appendEntry, readLedger, moneyReport, loadOrg, listJobs, stringifyNote, HOUSE, LEDGER_PATH, type Vault } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler, type Llm } from '@cubicle/harness';
import type { ChatMessage, ModelBudget, RoutedChatResult, RouteRequest, ToolSchema } from '@cubicle/router';
import { WorkerPool } from '../src/workers.js';
import { dispatchProposals } from '../src/dispatcher.js';
import { runHeartbeat, createHeartbeatJob, runBoardSession, withCycleBudget } from '../src/heartbeat.js';
import { Daemon, pollCached, DORMANCY_POLL_MS } from '../src/daemon.js';
import { defaultConfig } from '../src/config.js';

let dir: string;
let vault: Vault;
let dormant = false;
let pool: WorkerPool;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-dormant-'));
  vault = (await scaffoldVault(dir)).vault;
  dormant = false;
  pool = new WorkerPool(vault, { harness: {} as never, heartbeat: {} as never, maxConcurrent: 8, dormant: () => dormant });
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('a dormant company starts nothing but its heartbeat (spec §5)', () => {
  it('holds ordinary work back and still starts the heartbeat that will notice the revival', () => {
    const work = createJob(vault, { type: 'engineer.ship', title: 'Ship something', assigned: 'backend_engineer', goal: 'g', team: 'dev', stream: 'checkout', risk: 'low' }, 'dev_manager');
    const beat = createJob(vault, { type: 'ceo.heartbeat', title: 'Heartbeat (test)', assigned: 'ceo', goal: 'g' }, 'daemon');

    expect(pool.nextJob('backend_engineer')).toBe(work);
    expect(pool.nextJob('ceo')).toBe(beat);

    dormant = true;
    expect(pool.nextJob('backend_engineer')).toBeNull();
    expect(pool.nextJob('ceo')).toBe(beat);      // never the heartbeat: it is what sees the capital row arrive

    dormant = false;
    expect(pool.nextJob('backend_engineer')).toBe(work);
  });

  it('holds back a review gate too — a gate is a model call like any other', () => {
    const gate = createJob(vault, { type: 'team:qa.review', title: 'Review the ship', assigned: 'qa_lead', goal: 'g', team: 'dev' }, 'daemon');
    expect(pool.nextJob('qa_lead')).toBe(gate);
    dormant = true;
    expect(pool.nextJob('qa_lead')).toBeNull();
  });

  it('says why the queue is not moving, once per window rather than once per poll', () => {
    createJob(vault, { type: 'engineer.ship', title: 'Ship something', assigned: 'backend_engineer', goal: 'g', team: 'dev', stream: 'checkout', risk: 'low' }, 'dev_manager');
    dormant = true;
    for (let i = 0; i < 5; i++) pool.nextJob('backend_engineer');
    const warnings = vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'dormant');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0].payload.message)).toContain(LEDGER_PATH);
  });

  it('warns again about a second dormancy, rather than staying quiet because the first was minutes ago', () => {
    createJob(vault, { type: 'custom', title: 'x', assigned: 'backend_engineer', goal: 'g' }, 'ceo');
    const dormancyWarnings = () => vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'dormant').length;

    dormant = true;
    pool.nextJob('backend_engineer');
    expect(dormancyWarnings()).toBe(1);

    dormant = false;                       // the owner adds capital; the job runs
    expect(pool.nextJob('backend_engineer')).toBeTruthy();

    dormant = true;                        // and the new capital is gone again, well inside the warning window
    pool.nextJob('backend_engineer');
    expect(dormancyWarnings()).toBe(2);    // a second episode is a second thing to say
  });

  it('a dormancy check that throws never stops the company', () => {
    const work = createJob(vault, { type: 'custom', title: 'x', assigned: 'backend_engineer', goal: 'g' }, 'ceo');
    const angry = new WorkerPool(vault, { harness: {} as never, heartbeat: {} as never, maxConcurrent: 1, dormant: () => { throw new Error('ledger on fire'); } });
    expect(angry.nextJob('backend_engineer')).toBe(work);
  });

  it('asks the ledger at most once a poll, and not at all while the role has nothing queued', () => {
    let asks = 0;
    const counting = new WorkerPool(vault, { harness: {} as never, heartbeat: {} as never, maxConcurrent: 4, dormant: () => { asks++; return true; } });
    expect(counting.nextJob('backend_engineer')).toBeNull();
    expect(asks).toBe(0);                                   // an empty queue costs no ledger read

    for (let i = 0; i < 3; i++) createJob(vault, { type: 'custom', title: `x${i}`, assigned: 'backend_engineer', goal: 'g' }, 'ceo');
    expect(counting.nextJob('backend_engineer')).toBeNull();
    expect(asks).toBe(1);                                   // three candidates, one reading
  });

  it('no `dormant` option at all means nothing is ever held back', () => {
    const work = createJob(vault, { type: 'custom', title: 'x', assigned: 'backend_engineer', goal: 'g' }, 'ceo');
    const plain = new WorkerPool(vault, { harness: {} as never, heartbeat: {} as never, maxConcurrent: 1 });
    expect(plain.nextJob('backend_engineer')).toBe(work);
  });
});

describe('dormancy comes from the ledger, and the owner ends it by adding capital', () => {
  it('starts nothing once the capital is spent, and starts again on the next poll after a `capital` row', () => {
    // The real wiring the daemon uses: derived from the book on every call, never from the heartbeat's state
    // file, so there is nothing to invalidate when the owner writes the row.
    const fromLedger = new WorkerPool(vault, {
      harness: {} as never, heartbeat: {} as never, maxConcurrent: 1,
      dormant: () => moneyReport(readLedger(vault), new Date('2026-09-12T09:00:00.000Z')).dormant,
    });
    const work = createJob(vault, { type: 'custom', title: 'x', assigned: 'backend_engineer', goal: 'g' }, 'ceo');

    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed' }, 'owner');
    expect(fromLedger.nextJob('backend_engineer')).toBe(work);

    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'cost', cents: 25000, mode: 'live', who: 'daemon', why: 'All of it' }, 'daemon');
    expect(fromLedger.nextJob('backend_engineer')).toBeNull();

    appendEntry(vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 10000, mode: 'live', who: 'owner', why: 'More' }, 'owner');
    expect(fromLedger.nextJob('backend_engineer')).toBe(work);
  });
});

describe('a dormant company applies no proposal that spends', () => {
  const root = path.resolve(__dirname, '../../..');
  const NOW = new Date('2026-09-12T09:00:00.000Z');
  const jsonl = () => path.join(dir, '.cubicle/mock-outbound.jsonl');
  // The dispatcher acts on an approval flag only when `vault.isOwnerChanged` says the owner set it, so approving
  // in a test is a raw file edit (the same trick as sp3-proposals.test.ts).
  const approve = (rel: string) => writeFileSync(path.join(dir, rel), readFileSync(path.join(dir, rel), 'utf8').replace(/^approved: .*$/m, 'approved: true'));
  const deps = (isDormant: () => boolean) => ({
    vault, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })),
    toolsConfig: parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8')),
    scheduler: vaultScheduler(vault), env: {} as NodeJS.ProcessEnv, dormant: isDormant,
  });
  /** The real hook the daemon wires: what the book says at `NOW`, not a stub. */
  const fromLedger = () => moneyReport(readLedger(vault), NOW).dormant;
  /** A refused note is retried on the owner's next edit or after ten minutes; this is that wait. */
  const tenMinutesPass = () => vault.db.prepare('UPDATE refusals SET at = ?').run(new Date(Date.now() - 11 * 60_000).toISOString());
  /** An approved `spend` waiting on the daemon, and the role that may make the call. */
  function approvedSpend(): { id: string; path: string } {
    vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const p = createProposal(vault, { kind: 'spend', from: 'cmo', job, title: 'send one', body: 'x', call: { tool: 'mock.outbound', args: { to: 'a@x', body: 'hi' }, idempotency_key: `${job}:1:1`, job, role: 'cmo' } }, 'cmo');
    approve(p.path);
    return p;
  }

  it('holds the call while the book says dormant, writes the note once however long that lasts, and spends it on the capital row', async () => {
    const p = approvedSpend();
    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed' }, 'owner');
    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'cost', cents: 25000, mode: 'live', who: 'daemon', why: 'All of it' }, 'daemon');

    await dispatchProposals(deps(fromLedger));
    expect(existsSync(jsonl())).toBe(false);                                          // nothing was spent
    const held = findInboxById(vault, p.id)!;
    expect(held.data.resolved_at).toBeFalsy();                                        // the approval still stands
    expect(held.data.approved).toBe(true);
    expect(String((held.data as { refused?: string }).refused)).toContain(LEDGER_PATH);
    const sha = vault.currentSha(p.path);

    // Three more sweeps across a dormancy that could run for days: the note is not touched again and the room
    // is not told again. A refusal the owner can fix in seconds may repeat itself; this one may not.
    for (let i = 0; i < 3; i++) { tenMinutesPass(); await dispatchProposals(deps(fromLedger)); }
    expect(vault.currentSha(p.path)).toBe(sha);
    expect(vault.events.query({ types: ['guardrail.blocked'] }).filter((e) => String(e.payload.reason).includes(LEDGER_PATH))).toHaveLength(1);
    expect(existsSync(jsonl())).toBe(false);

    // The owner adds capital. Nothing about the note changed, so the ledger alone is what lets it through, and
    // the approval the owner already gave is the one that applies.
    appendEntry(vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 10000, mode: 'live', who: 'owner', why: 'More' }, 'owner');
    tenMinutesPass();
    await dispatchProposals(deps(fromLedger));
    expect(existsSync(jsonl())).toBe(true);
    expect(findInboxById(vault, p.id)!.data.resolved_at).toBeTruthy();
  });

  it('a `spend` with nothing to execute is resolved once, dormant or not, instead of waiting for money', async () => {
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const p = createProposal(vault, { kind: 'spend', from: 'cmo', job, title: 'send nothing', body: 'x' }, 'cmo');
    approve(p.path);

    await dispatchProposals(deps(() => true));
    const note = findInboxById(vault, p.id)!;
    expect(note.data.resolved_at).toBeTruthy();
    expect(note.body).toContain('no stored call');
  });

  it('a dormancy check that throws spends as usual — the failure mode is a company that keeps working', async () => {
    const p = approvedSpend();
    await dispatchProposals(deps(() => { throw new Error('ledger on fire'); }));
    expect(findInboxById(vault, p.id)!.data.resolved_at).toBeTruthy();
  });
});

describe('a dormant company queues nothing new, so the CEO\'s message stays true (M16)', () => {
  it('skips the tick\'s enqueueing sweeps while stopped, and runs them again once the owner funds it', async () => {
    // The CEO's last message says "Nothing is queued, nobody is working". `nextJob` holds work back, so a job
    // queued here would only sit there — but the sentence has to be true, and a growing queue is the owner's
    // evidence that it is not.
    vault.writeText('Experiments/exp_1.md', stringifyNote({ id: 'exp_1', title: 'Cold email v2', owner: 'cmo', status: 'running', metric: 'replies', review_date: '2026-01-01' }, '## Hypothesis\n\nx\n'), 'cmo');
    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed from savings' }, 'owner');
    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'cost', cents: 25000, mode: 'live', who: 'daemon', why: 'Every penny of it' }, 'daemon');
    expect(moneyReport(readLedger(vault), new Date()).dormant).toBe(true);

    const d = new Daemon(
      defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, { port: 0, tickMs: 60_000, maxConcurrentJobs: 1, providersPath: path.resolve(__dirname, '../../../config/providers.yaml'), toolsPath: path.resolve(__dirname, '../../../config/tools.yaml') }),
      { llm: { async chat() { throw new Error('no model call belongs in this test'); }, promptBudget: () => 6000 }, disableWs: true, disableSleepWatch: true, memory: false, log: () => undefined },
    );
    await d.start();
    try {
      const reviews = () => listJobs(d.vault).filter((j) => j.type === 'office:operations.verify');
      const before = listJobs(d.vault).map((j) => j.id).sort();
      await d.runTick('test');
      expect(reviews()).toEqual([]);
      // Nothing new at all — and the heartbeat, which is what notices the revival, is still the exception the
      // pool starts (asserted at the top of this file).
      expect(listJobs(d.vault).map((j) => j.id).sort()).toEqual(before);

      // The owner tops it up: the same sweep now has work to do.
      appendEntry(d.vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 10000, mode: 'live', who: 'owner', why: 'Topping the company up' }, 'owner');
      await new Promise((r) => setTimeout(r, DORMANCY_POLL_MS + 50));   // the dormancy reading is cached for a beat
      await d.runTick('funded');
      expect(reviews()).toHaveLength(1);
    } finally { await d.stop(); }
  }, 60_000);
});

describe('the cycle speaks on the house budget, read once (SP4 §4)', () => {
  const HOUSE_BUDGET: ModelBudget = { used: 3, quota: 30 };
  const recording = (seen: RouteRequest[]): Llm => ({
    async chat(req: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      seen.push(req);
      return { content: 'Understood.', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'strong', downgraded: false, parsedToolCalls: [] };
    },
  });

  it('every voice at the board table runs against the house budget, whichever division they lead', async () => {
    const seen: RouteRequest[] = [];
    let reads = 0;
    const deps = withCycleBudget({ vault, llm: recording(seen), modelBudget: () => { reads++; return HOUSE_BUDGET; } });
    await runBoardSession(deps, loadOrg(vault), 'Ship the first cut');

    expect(seen.length).toBeGreaterThan(1);                                  // the advisors, then the chair
    expect(new Set(seen.map((r) => r.roleId)).size).toBeGreaterThan(1);      // each speaks as themselves…
    for (const r of seen) expect(r.budget).toEqual(HOUSE_BUDGET);            // …and all of them on the house
    // And every one of those calls is *stamped* house, so the bank screen counts them where they were paid for
    // rather than against whichever division an advisor's `team:` field happens to name (I4).
    for (const r of seen) expect(r.budgetDivision).toBe(HOUSE);
    // Non-vacuous: more calls than readings, so removing the memo fails this line.
    expect(seen.length).toBeGreaterThan(reads);
    expect(reads).toBe(1);
  });

  it('a whole cycle reads the budget once and puts it on every ask', async () => {
    const seen: RouteRequest[] = [];
    let reads = 0;
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
    await runHeartbeat({ vault, llm: recording(seen), modelBudget: () => { reads++; return HOUSE_BUDGET; } }, createHeartbeatJob(vault, 'test'));

    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(r.budget).toEqual(HOUSE_BUDGET);
    for (const r of seen) expect(r.budgetDivision).toBe(HOUSE);
    expect(reads).toBe(1);                                                   // `runHeartbeat` wraps its own deps
  });

  it('withCycleBudget reads once and reuses the answer for the rest of the cycle', () => {
    let reads = 0;
    const wrapped = withCycleBudget({ vault, llm: {} as never, modelBudget: () => { reads++; return { used: reads, quota: 9 }; } });
    expect(wrapped.modelBudget!()).toEqual({ used: 1, quota: 9 });
    expect(wrapped.modelBudget!()).toEqual({ used: 1, quota: 9 });           // the same reading, not a second one
    expect(wrapped.modelBudget!()).toEqual({ used: 1, quota: 9 });
    expect(reads).toBe(1);

    // The next cycle gets its own deps object from the worker pool, so it reads afresh — and a null reading is
    // memoised too, rather than being retried on every ask.
    const next = withCycleBudget({ vault, llm: {} as never, modelBudget: () => { reads++; return null; } });
    expect(next.modelBudget!()).toBeNull();
    expect(next.modelBudget!()).toBeNull();
    expect(reads).toBe(2);
  });

  it('no `modelBudget` dep at all is left exactly as it was', () => {
    const deps = { vault, llm: {} as never };
    expect(withCycleBudget(deps)).toBe(deps);
  });
});

describe('pollCached: one parse for a sweep, never a fact held over one', () => {
  it('reuses a reading inside the window and reads again after it', () => {
    let reads = 0;
    let clock = 1000;
    const read = pollCached(() => ++reads, 1000, () => clock);
    expect(read()).toBe(1);
    clock += 999;
    expect(read()).toBe(1);                 // the rest of the sweep pays nothing
    clock += 1;
    expect(read()).toBe(2);                 // the window is over: ask the ledger again
    expect(reads).toBe(2);
  });

  it('DORMANCY_POLL_MS is far shorter than an idle interval, so revival is still seen on the next poll', () => {
    expect(DORMANCY_POLL_MS).toBeLessThan(15_000);
  });
});
