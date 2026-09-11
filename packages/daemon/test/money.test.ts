import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, loadOrg, readLedger, moneyReport, appendEntry, listJobs, listInbox, readJob, updateJob, jobPath,
  createProposal, findInboxById, officeHolder, teamOf, HOUSE, RUNWAY_PATH, type Vault,
} from '@cubicle/core';
import { parseProvidersConfig } from '@cubicle/router';
import {
  BUDGETED_TIERS, dayStartIso, freeCallCapacity, divisionWeights, divisionQuotas, divisionSpend, divisionOfRole,
  budgetRows, budgetForRole, runwayJobId, enqueueRunway, runwayCommentary, writeRunway, accrueModelCost,
  accrueModelCosts, dormancyMark, drawsOnFreePool, moneyMessageId, dormancyMessage, revivalMessage,
} from '../src/money.js';

const SHIPPED = parseProvidersConfig(readFileSync(path.resolve(__dirname, '../../../config/providers.yaml'), 'utf8'));
const PRICED = parseProvidersConfig(`
cascade: [paid]
providers:
  - id: paid
    base_url: https://example.test/v1
    models:
      - { id: big, tier: strong, tools: native, limits: { rpd: 100 }, price: { input_per_mtok: 300, output_per_mtok: 1500 } }
      - { id: gratis, tier: medium, tools: native, limits: { rpd: 400 } }
`);
// The same file after the owner stamps when the prices were checked (M2): the first accrual may not reach
// back past that day, however long the event log is.
const PRICED_STAMPED = parseProvidersConfig(`
prices_verified: "2026-09-11"
cascade: [paid]
providers:
  - id: paid
    base_url: https://example.test/v1
    models:
      - { id: big, tier: strong, tools: native, limits: { rpd: 100 }, price: { input_per_mtok: 300, output_per_mtok: 1500 } }
`);
// `rpd` omitted is `ModelLimits`' default of 0, which every other reader treats as *no daily limit* (I2).
const UNLIMITED = parseProvidersConfig(`
cascade: [wide]
providers:
  - id: wide
    base_url: https://example.test/v1
    models:
      - { id: endless, tier: medium, tools: native, limits: { rpm: 5 } }
`);
// The same unlimited model under an account-wide cap: the account figure is the real capacity.
const UNLIMITED_CAPPED = parseProvidersConfig(`
cascade: [wide]
providers:
  - id: wide
    base_url: https://example.test/v1
    limits: { rpd: 120 }
    models:
      - { id: endless, tier: medium, tools: native, limits: { rpm: 5 } }
`);

const NOW = new Date('2026-09-12T12:00:00.000Z');
let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-daemon-money-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

// A call on a model the shipped file actually describes, one per tier: `divisionSpend` now asks the providers
// file whether a call drew on the free pool, so a fixture on an unknown provider would not exercise the filter.
const FREE_MODEL: Record<string, [string, string]> = {
  strong: ['gemini', 'gemini-3.5-flash'],
  medium: ['gemini', 'gemini-3.5-flash-lite'],
  cheap: ['gemini', 'gemini-3.1-flash-lite'],
  local: ['ollama', 'qwen2.5:7b'],
};

// The timestamp is pinned inside NOW's day: `divisionSpend` measures a calendar day, so a call stamped with
// the real clock would fall outside the window on any day but the one this plan was written.
const call = (agent: string, tier: string, ts = '2026-09-12T09:00:00.000Z') => {
  const [provider, model] = FREE_MODEL[tier];
  return vault.events.emit({ type: 'router.call', agent, ts, payload: { provider, model, tier, tokens: { prompt_tokens: 1000, completion_tokens: 100 } } });
};

/** A call on whatever provider/model the case is about, for the cases that are about the model. */
const callOn = (agent: string, tier: string, provider: string, model: string, ts = '2026-09-12T09:00:00.000Z') =>
  vault.events.emit({ type: 'router.call', agent, ts, payload: { provider, model, tier, tokens: { prompt_tokens: 1000, completion_tokens: 100 } } });

describe('what the free tier is worth in a day (spec §4)', () => {
  it('counts only the scarce tiers, only free models, and respects an account-wide cap', () => {
    expect(BUDGETED_TIERS).toEqual(['strong', 'medium']);
    // gemini 560 + groq 2000 + openrouter 50 (account rpd, not the 200 its four medium models add up to).
    expect(freeCallCapacity(SHIPPED)).toBe(2610);
    // The priced model contributes nothing: paid capacity is not free capacity.
    expect(freeCallCapacity(PRICED)).toBe(400);
  });

  it('reads an omitted rpd as unlimited, the way every other reader does', () => {
    // 0 is the schema default and means "no declared limit" (quota.ts guards on `if (L.rpd && …)`), so an
    // unlimited model is never summed as zero capacity. With nothing finite to add it is left out entirely…
    expect(freeCallCapacity(UNLIMITED)).toBe(0);
    // …and its calls are left out of the usage side too, so `used` cannot climb against a quota it never raised.
    expect(drawsOnFreePool(UNLIMITED, 'wide', 'endless')).toBe(false);
    // …but where the account declares a daily cap, that cap is the real capacity.
    expect(freeCallCapacity(UNLIMITED_CAPPED)).toBe(120);
    expect(drawsOnFreePool(UNLIMITED_CAPPED, 'wide', 'endless')).toBe(true);
  });

  it('agrees with the spend side about which calls are on the free pool', () => {
    expect(drawsOnFreePool(SHIPPED, 'gemini', 'gemini-3.5-flash')).toBe(true);
    expect(drawsOnFreePool(PRICED, 'paid', 'big')).toBe(false);        // priced: the owner pays, not the pool
    expect(drawsOnFreePool(SHIPPED, 'ollama', 'qwen2.5:7b')).toBe(false);  // local: free and unmetered
    expect(drawsOnFreePool(SHIPPED, 'gemini', 'some-model-we-renamed')).toBe(true);  // unknown: counted, never lost
    expect(drawsOnFreePool(null, 'anything', 'at-all')).toBe(true);     // no file to check against
  });

  it('weighs a division by the people actually in it, and quotas sum to the capacity', () => {
    const org = loadOrg(vault);
    const weights = divisionWeights(org);
    expect(weights.map((w) => w.id).sort()).toEqual(['operations', 'revenue', 'technology']);
    expect(weights.find((w) => w.id === 'technology')!.people).toBeGreaterThan(weights.find((w) => w.id === 'revenue')!.people);
    const q = divisionQuotas(SHIPPED, org);
    expect(Object.values(q).reduce((t, n) => t + n, 0)).toBe(2610);
    expect(q[HOUSE]).toBeGreaterThan(0);
  });
});

describe('what a division has spent today (spec §4)', () => {
  it('charges a call to the division of the role that made it, and the rest to the house', () => {
    const org = loadOrg(vault);
    const known = new Set(['technology', 'revenue', 'operations']);
    expect(divisionOfRole(org, 'backend_engineer', known)).toBe('technology');
    expect(divisionOfRole(org, 'cso', known)).toBe('revenue');
    expect(divisionOfRole(org, 'ceo', known)).toBe(HOUSE);          // the executive team is not a division
    expect(divisionOfRole(org, 'nobody_at_all', known)).toBe(HOUSE);
    expect(divisionOfRole(org, null, known)).toBe(HOUSE);
  });

  it('counts the scarce tiers and ignores the floor the division drops to', () => {
    call('backend_engineer', 'strong');
    call('backend_engineer', 'medium');
    call('backend_engineer', 'cheap');       // the floor: never budgeted, never counted
    call('backend_engineer', 'local');
    call('ceo', 'strong');
    const spend = divisionSpend(vault, loadOrg(vault), dayStartIso(NOW));
    expect(spend.technology).toBe(2);
    expect(spend[HOUSE]).toBe(1);
    expect(spend.revenue).toBe(0);
  });

  it('gives a role the budget of its own division, and the office the house budget', () => {
    call('backend_engineer', 'strong');
    const org = loadOrg(vault);
    const tech = budgetForRole(vault, org, SHIPPED, 'backend_engineer', NOW);
    expect(tech.used).toBe(1);
    expect(tech.quota).toBe(divisionQuotas(SHIPPED, org).technology);
    expect(budgetForRole(vault, org, SHIPPED, 'ceo', NOW).quota).toBe(divisionQuotas(SHIPPED, org)[HOUSE]);
    const rows = budgetRows(vault, org, SHIPPED, NOW);
    expect(rows.at(-1)!.division).toBe(HOUSE);                      // the house reads last, after the divisions
    expect(rows.find((r) => r.division === 'technology')).toEqual({ division: 'technology', used: 1, quota: tech.quota });
  });

  it('does not charge the free quota for a call the owner paid for', () => {
    const org = loadOrg(vault);
    callOn('backend_engineer', 'strong', 'paid', 'big');
    // Capacity excludes the priced model, so counting its calls would make `used/quota` overstate every day.
    expect(divisionSpend(vault, org, dayStartIso(NOW), PRICED).technology).toBe(0);
    expect(budgetForRole(vault, org, PRICED, 'backend_engineer', NOW).used).toBe(0);
    // Without a providers file there is nothing to check against, so the tier count stands.
    expect(divisionSpend(vault, org, dayStartIso(NOW)).technology).toBe(1);
  });
});

describe('the daily runway job (spec §2)', () => {
  it('is queued once a calendar day, by office, with an id derived from the date', () => {
    const org = loadOrg(vault);
    const id = enqueueRunway(vault, org, NOW);
    expect(id).toBe(runwayJobId('2026-09-12'));
    expect(enqueueRunway(vault, org, new Date('2026-09-12T23:59:00.000Z'))).toBeNull();
    const job = readJob(vault, id!)!;
    expect(job.data.type).toBe('finance.runway');
    expect(job.data.assigned).toBe('cfo');       // officeHolder(org, 'finance') in the shipped roster
    expect(job.data.model_tier).toBe('cheap');
    expect(job.body).toContain('USD 0.00');      // the figures are in the goal; the job never computes one
    // The three fields that carry "no literal role id on a routing path": every one resolves through the tree.
    expect(job.data.owner_role).toBe(officeHolder(org, 'finance'));
    expect(job.data.for).toBe(officeHolder(org, 'chief_executive'));
    expect(job.data.team).toBe(teamOf(org, officeHolder(org, 'finance'))!.id);
    expect(enqueueRunway(vault, org, new Date('2026-09-13T00:01:00.000Z'))).toBe(runwayJobId('2026-09-13'));
  });

  it('folds the finished job\'s summary into the note, and writes every figure itself', () => {
    const org = loadOrg(vault);
    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed' }, 'owner');
    call('backend_engineer', 'strong');
    const id = enqueueRunway(vault, org, NOW)!;
    expect(runwayCommentary(vault)).toBe('');
    vault.updateNote(jobPath(id), (n) => ({ data: n.data, body: `${n.body}\n## Result\n\n\`\`\`json\n${JSON.stringify({ status: 'done', summary: 'Free tiers cover everything.\nNothing to pay for yet.' })}\n\`\`\`\n` }), 'cfo');
    updateJob(vault, id, { status: 'done' }, 'cfo');
    expect(runwayCommentary(vault)).toContain('Free tiers cover everything.');
    const r = writeRunway(vault, org, SHIPPED, NOW);
    expect(r.cashCents).toBe(25000);
    const note = vault.readText(RUNWAY_PATH);
    expect(note).toContain('cash_cents: 25000');
    expect(note).toContain('Free tiers cover everything.');
    expect(note).toContain('| technology |');
    expect(note).toContain('carries a `price:`');    // nothing in the shipped file is priced
    // Regenerating is a report, not an edit: the same inputs give the same page, commentary and all.
    writeRunway(vault, org, SHIPPED, NOW);
    expect(vault.readText(RUNWAY_PATH)).toBe(note);
    expect(vault.readText(RUNWAY_PATH)).toContain('Free tiers cover everything.');
  });
});

describe('what the models cost (spec §3)', () => {
  it('writes nothing at all while everything is free', () => {
    vault.events.emit({ type: 'router.call', agent: 'ceo', ts: '2026-09-11T10:00:00.000Z', payload: { provider: 'gemini', model: 'gemini-3.5-flash', tier: 'strong', tokens: { prompt_tokens: 5000, completion_tokens: 800 } } });
    expect(accrueModelCost(vault, SHIPPED, NOW)).toBeNull();
    expect(readLedger(vault).entries).toEqual([]);   // a row of 0.00 would be noise, not honesty
  });

  it('charges yesterday\'s paid calls once, with a ref that stops a replay charging twice', () => {
    for (const ts of ['2026-09-11T10:00:00.000Z', '2026-09-11T20:00:00.000Z']) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts, payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    }
    const e = accrueModelCost(vault, PRICED, NOW)!;
    expect(e).toMatchObject({ kind: 'cost', cents: 600, mode: 'live', who: 'daemon', ref: 'model-2026-09-11' });
    expect(e.why).toContain('2 model call');
    expect(accrueModelCost(vault, PRICED, NOW)).toBeNull();
    expect(readLedger(vault).entries).toHaveLength(1);
  });

  it('books every day a daemon that was off for three days owes, one row each', () => {
    for (const day of ['2026-09-09', '2026-09-10', '2026-09-11']) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: `${day}T10:00:00.000Z`, payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    }
    const rows = accrueModelCosts(vault, PRICED, NOW);
    expect(rows.map((r) => r.ref)).toEqual(['model-2026-09-09', 'model-2026-09-10', 'model-2026-09-11']);
    expect(rows.every((r) => r.cents === 300)).toBe(true);
    // Today is not over: it is never charged, and nothing is charged twice on the next cycle.
    expect(readLedger(vault).entries.map((x) => x.ref)).toEqual(['model-2026-09-09', 'model-2026-09-10', 'model-2026-09-11']);
    expect(accrueModelCosts(vault, PRICED, NOW)).toEqual([]);
  });

  it('never bills backwards for calls made before the owner added a price', () => {
    for (const day of ['2026-09-01', '2026-09-11']) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: `${day}T10:00:00.000Z`, payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    }
    // `prices_verified: 2026-09-11` — the 09-01 call was made believing it was free, and stays free.
    expect(accrueModelCosts(vault, PRICED_STAMPED, NOW).map((r) => r.ref)).toEqual(['model-2026-09-11']);
    // And it is not swept up later either: the walk now continues from the row it just wrote.
    expect(accrueModelCosts(vault, PRICED_STAMPED, NOW)).toEqual([]);
    expect(readLedger(vault).entries.map((x) => x.ref)).toEqual(['model-2026-09-11']);
  });

  it('still reaches back thirty days when the file says nothing about when its prices appeared', () => {
    for (const day of ['2026-09-01', '2026-09-11']) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: `${day}T10:00:00.000Z`, payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    }
    expect(accrueModelCosts(vault, PRICED, NOW).map((r) => r.ref)).toEqual(['model-2026-09-01', 'model-2026-09-11']);
  });
});

describe('dormancy and revival (spec §5)', () => {
  const fund = () => appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed' }, 'owner');
  const spend = () => appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'cost', cents: 25000, mode: 'live', who: 'daemon', why: 'All of it' }, 'daemon');

  it('tells the owner once, from the chief executive, and says how to bring the company back', () => {
    fund(); spend();
    const org = loadOrg(vault);
    const r = moneyReport(readLedger(vault), NOW);
    expect(r.dormant).toBe(true);
    const id = dormancyMessage(vault, org, r, NOW)!;
    expect(dormancyMessage(vault, org, r, NOW)).toBeNull();          // once, not once per cycle
    const note = listInbox(vault).find((n) => n.data.id === id)!;
    expect(note.data.kind).toBe('message');
    expect(note.data.from).toBe('ceo');
    expect(note.data.to).toBe('owner');
    expect((note.data as { money?: string }).money).toBe('dormant');
    expect(note.body).toContain('capital');
    expect(note.body).toContain('USD 0.00');
    expect(note.body).toContain('USD 250.00');                       // what was spent, so "where did it go" is answered
  });

  it('says nothing at all about a company that was never funded', () => {
    const r = moneyReport(readLedger(vault), NOW);
    expect(r.dormant).toBe(false);
    expect(dormancyMessage(vault, loadOrg(vault), r, NOW)).toBeNull();
    expect(revivalMessage(vault, loadOrg(vault), r, NOW)).toBeNull();
  });

  it('says it is back, once, when the owner adds capital', () => {
    fund(); spend();
    const org = loadOrg(vault);
    dormancyMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW);
    expect(revivalMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW)).toBeNull();   // still dormant
    appendEntry(vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 10000, mode: 'live', who: 'owner', why: 'More' }, 'owner');
    const back = moneyReport(readLedger(vault), NOW);
    expect(back.dormant).toBe(false);
    const id = revivalMessage(vault, org, back, NOW)!;
    expect(revivalMessage(vault, org, back, NOW)).toBeNull();
    const note = listInbox(vault).find((n) => n.data.id === id)!;
    expect((note.data as { money?: string }).money).toBe('revived');
    expect(note.body).toContain('USD 100.00');
  });

  it('is one message per episode, even when an accrual moves the money afterwards', () => {
    fund(); spend();
    const org = loadOrg(vault);
    const first = dormancyMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW);
    expect(first).toBe(moneyMessageId('dormant', dormancyMark(vault)));
    // The day the company stopped still had paid calls; the next cycle books them as a past-dated `live` cost.
    // `lastLiveAt` moves — but the episode did not restart, and the owner must not be told a second time.
    vault.events.emit({ type: 'router.call', agent: 'ceo', ts: '2026-09-11T10:00:00.000Z', payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    const accrued = accrueModelCost(vault, PRICED, NOW)!;
    const after = moneyReport(readLedger(vault), NOW);
    expect(after.lastLiveAt).toBe(accrued.at);                                   // it really did move
    expect(after.lastLiveAt).not.toBe(dormancyMark(vault));                      // the episode's mark did not
    expect(dormancyMessage(vault, org, after, NOW)).toBeNull();
    expect(listInbox(vault).filter((n) => (n.data as { money?: string }).money === 'dormant')).toHaveLength(1);
    // And the answer to that one episode is one "Back to work", not one per mark it passed through.
    appendEntry(vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 10000, mode: 'live', who: 'owner', why: 'More' }, 'owner');
    const back = moneyReport(readLedger(vault), NOW);
    expect(revivalMessage(vault, org, back, NOW)).not.toBeNull();
    expect(revivalMessage(vault, org, back, NOW)).toBeNull();
    expect(listInbox(vault).filter((n) => (n.data as { money?: string }).money === 'revived')).toHaveLength(1);
  });

  it('starts a fresh episode when the company runs out a second time', () => {
    fund(); spend();
    const org = loadOrg(vault);
    const one = dormancyMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW)!;
    appendEntry(vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 10000, mode: 'live', who: 'owner', why: 'More' }, 'owner');
    expect(revivalMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW)).not.toBeNull();
    appendEntry(vault, { at: '2026-09-12T09:00:00.000Z', kind: 'cost', cents: 10000, mode: 'live', who: 'daemon', why: 'And again' }, 'daemon');
    const two = dormancyMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW);
    expect(two).not.toBeNull();
    expect(two).not.toBe(one);                       // a new episode, keyed on its own crossing entry
    expect(dormancyMark(vault)).toBe('2026-09-12T09:00:00.000Z');
  });

  it('repairs a stamp lost to a crash, so the revival is never silenced', () => {
    fund(); spend();
    const org = loadOrg(vault);
    const r = moneyReport(readLedger(vault), NOW);
    const id = moneyMessageId('dormant', dormancyMark(vault));
    // The crash: `createProposal` landed, the write that stamps `money`/`mark` on to it did not.
    createProposal(vault, { id, kind: 'message', from: 'ceo', to: 'owner', title: 'We have run out of money', body: 'half-written' }, 'ceo');
    expect(dormancyMessage(vault, org, r, NOW)).toBeNull();                       // still said once, not twice
    expect((findInboxById(vault, id)!.data as { money?: string }).money).toBe('dormant');
    appendEntry(vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 10000, mode: 'live', who: 'owner', why: 'More' }, 'owner');
    expect(revivalMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW)).not.toBeNull();
  });
});
