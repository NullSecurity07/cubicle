import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, createJob, createProposal, findInboxById, appendEntry, readLedger, moneyReport, LEDGER_PATH, type Vault } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler, type Llm } from '@cubicle/harness';
import type { ChatMessage, ModelBudget, RoutedChatResult, RouteRequest, ToolSchema } from '@cubicle/router';
import { WorkerPool } from '../src/workers.js';
import { dispatchProposals } from '../src/dispatcher.js';
import { runHeartbeat, createHeartbeatJob, withCycleBudget } from '../src/heartbeat.js';

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
  // The dispatcher acts on an approval flag only when `vault.isOwnerChanged` says the owner set it, so approving
  // in a test is a raw file edit (the same trick as sp3-proposals.test.ts).
  const approve = (rel: string) => writeFileSync(path.join(dir, rel), readFileSync(path.join(dir, rel), 'utf8').replace(/^approved: .*$/m, 'approved: true'));
  const deps = (isDormant: () => boolean) => ({
    vault, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })),
    toolsConfig: parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8')),
    scheduler: vaultScheduler(vault), env: {} as NodeJS.ProcessEnv, dormant: isDormant,
  });

  it('holds the approved call back while dormant, keeps the approval, and spends it once capital arrives', async () => {
    vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const p = createProposal(vault, { kind: 'spend', from: 'cmo', job, title: 'send one', body: 'x', call: { tool: 'mock.outbound', args: { to: 'a@x', body: 'hi' }, idempotency_key: `${job}:1:1`, job, role: 'cmo' } }, 'cmo');
    approve(p.path);

    await dispatchProposals(deps(() => true));
    expect(existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl'))).toBe(false);   // nothing was spent
    const held = findInboxById(vault, p.id)!;
    expect(held.data.resolved_at).toBeFalsy();                                        // the approval still stands
    expect(String((held.data as { refused?: string }).refused)).toContain(LEDGER_PATH);
    expect(held.data.approved).toBe(true);

    // The owner adds capital. A refused note is retried on the owner's next edit or every ten minutes, and
    // adding capital edits the ledger rather than this note, so the retry is the timed one: backdate the
    // refusal row to stand in for that wait.
    appendEntry(vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 10000, mode: 'live', who: 'owner', why: 'More' }, 'owner');
    vault.db.prepare('UPDATE refusals SET at = ?').run(new Date(Date.now() - 11 * 60_000).toISOString());
    await dispatchProposals(deps(() => false));
    expect(existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl'))).toBe(true);
    expect(findInboxById(vault, p.id)!.data.resolved_at).toBeTruthy();
  });

  it('a dormancy check that throws spends as usual — the failure mode is a company that keeps working', async () => {
    vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const p = createProposal(vault, { kind: 'spend', from: 'cmo', job, title: 'send one', body: 'x', call: { tool: 'mock.outbound', args: { to: 'a@x', body: 'hi' }, idempotency_key: `${job}:1:1`, job, role: 'cmo' } }, 'cmo');
    approve(p.path);

    await dispatchProposals(deps(() => { throw new Error('ledger on fire'); }));
    expect(findInboxById(vault, p.id)!.data.resolved_at).toBeTruthy();
  });
});

describe("the heartbeat's own asks carry a budget, read once a cycle", () => {
  it('reads a role\'s budget once however many times that role speaks, and puts it on every call', async () => {
    const seen: RouteRequest[] = [];
    const asked: string[] = [];
    const llm: Llm = {
      async chat(req: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
        seen.push(req);
        return { content: 'Understood.', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 5, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'strong', downgraded: false, parsedToolCalls: [] };
      },
    };
    const modelBudget = (roleId: string): ModelBudget => { asked.push(roleId); return { used: 2, quota: 20 }; };
    // The owner left something to answer, so the cycle speaks more than once before it blocks.
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'Bookkeeping for tiny shops' }, 'owner');
    await runHeartbeat({ vault, llm, modelBudget }, createHeartbeatJob(vault, 'test'));

    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(r.budget).toEqual({ used: 2, quota: 20 });
    expect(asked).toEqual([...new Set(asked)]);                   // one read per role, not one per call
    expect(new Set(asked)).toEqual(new Set(seen.map((r) => r.roleId)));
  });

  it('withCycleBudget reads each role once and reuses the answer for the rest of the cycle', () => {
    const asked: string[] = [];
    const wrapped = withCycleBudget({ vault, llm: {} as never, modelBudget: (roleId) => { asked.push(roleId); return { used: asked.length, quota: 9 }; } });
    expect(wrapped.modelBudget!('ceo')).toEqual({ used: 1, quota: 9 });
    expect(wrapped.modelBudget!('ceo')).toEqual({ used: 1, quota: 9 });   // the same reading, not a second one
    expect(wrapped.modelBudget!('cto')).toEqual({ used: 2, quota: 9 });   // a different role is its own division
    expect(wrapped.modelBudget!('ceo')).toEqual({ used: 1, quota: 9 });
    expect(asked).toEqual(['ceo', 'cto']);

    // The next cycle gets its own deps object from the worker pool, so it reads afresh.
    expect(withCycleBudget({ vault, llm: {} as never, modelBudget: (r) => { asked.push(r); return null; } }).modelBudget!('ceo')).toBeNull();
    expect(asked).toEqual(['ceo', 'cto', 'ceo']);
  });

  it('no `modelBudget` dep at all is left exactly as it was', () => {
    const deps = { vault, llm: {} as never };
    expect(withCycleBudget(deps)).toBe(deps);
  });
});
