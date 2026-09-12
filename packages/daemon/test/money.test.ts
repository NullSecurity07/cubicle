import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, loadOrg, readLedger, moneyReport, appendEntry, listJobs, listInbox, readJob, updateJob, jobPath,
  createProposal, findInboxById, officeHolder, teamOf, money, runwayNote, HOUSE, LEDGER_PATH, RUNWAY_PATH, GATE_JOB_TYPES, type Vault,
} from '@cubicle/core';
import { parseProvidersConfig } from '@cubicle/router';
import {
  BUDGETED_TIERS, dayStartIso, freeCallCapacity, divisionWeights, divisionQuotas, divisionSpend, divisionOfRole,
  budgetRows, budgetForRole, runwayJobId, enqueueRunway, runwayCommentary, writeRunway, accrueModelCost,
  accrueModelCosts, callsByDay, dormancyMark, dormancyEpisodes, drawsOnFreePool, moneyMessageId, dormancyMessage, revivalMessage,
  runwayGoal, MAX_ACCRUAL_DAYS,
  LOCKED_RUNWAY, LOCKED_ACCRUAL, STAMP_AHEAD, NOTICES_UNWRITABLE, NOTICES_UNREADABLE, LOCK_STATE_PATH,
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
// One unlimited model beside a finite one, no account cap: the finite one must survive on both sides (N1).
const MIXED = parseProvidersConfig(`
cascade: [both]
providers:
  - id: both
    base_url: https://example.test/v1
    models:
      - { id: endless, tier: medium, tools: native, limits: { rpm: 5 } }
      - { id: counted, tier: strong, tools: native, limits: { rpd: 700 } }
`);
// The same file after the owner switches one model and one whole provider off mid-day (N4).
const DISABLED = parseProvidersConfig(`
cascade: [both, off]
providers:
  - id: both
    base_url: https://example.test/v1
    models:
      - { id: endless, tier: medium, tools: native, limits: { rpm: 5 } }
      - { id: counted, enabled: false, tier: strong, tools: native, limits: { rpd: 700 } }
  - id: off
    enabled: false
    base_url: https://example.test/v1
    models:
      - { id: shelved, tier: strong, tools: native, limits: { rpd: 900 } }
`);
// The same model before and after the owner re-tiers it (F3): the config decides, not the recorded call.
const TIER_BEFORE = parseProvidersConfig(`
cascade: [g]
providers:
  - id: g
    base_url: https://example.test/v1
    models:
      - { id: mover, tier: cheap, tools: native, limits: { rpd: 500 } }
`);
const TIER_AFTER = parseProvidersConfig(`
cascade: [g]
providers:
  - id: g
    base_url: https://example.test/v1
    models:
      - { id: mover, tier: medium, tools: native, limits: { rpd: 500 } }
`);
// A stamp the owner mistyped a year into the future (N2).
const PRICED_FUTURE = parseProvidersConfig(`
prices_verified: "2027-09-11"
cascade: [paid]
providers:
  - id: paid
    base_url: https://example.test/v1
    models:
      - { id: big, tier: strong, tools: native, limits: { rpd: 100 }, price: { input_per_mtok: 300, output_per_mtok: 1500 } }
`);

/**
 * Do directory modes actually stop a write here? Root ignores them, and so do some filesystems (a Docker
 * overlay as root, a `vfat`/`9p` mount). The fault tests below simulate an unwritable `.cubicle/` with
 * `chmod 0555` and assert the write *failed*, so where modes are advisory they would assert the opposite of
 * what happens. Probed once, when this file loads.
 */
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
/** Named so the reason shows up beside a skipped test rather than only in this comment. */
const NEEDS_MODES = 'needs a non-root user on a filesystem that enforces directory modes';

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

/** The same call with the pool it was gated against stamped on it, the way the harness and the heartbeat do. */
const callStamped = (agent: string, tier: string, division: string, ts = '2026-09-12T09:00:00.000Z') => {
  const [provider, model] = FREE_MODEL[tier];
  return vault.events.emit({ type: 'router.call', agent, ts, payload: { provider, model, tier, budget_division: division, tokens: { prompt_tokens: 1000, completion_tokens: 100 } } });
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

  it('decides per model, so one unlimited model does not delete its siblings\' capacity', () => {
    // The unlimited model contributes nothing and draws nothing; the finite one beside it keeps both.
    expect(freeCallCapacity(MIXED)).toBe(700);
    expect(drawsOnFreePool(MIXED, 'both', 'counted')).toBe(true);
    expect(drawsOnFreePool(MIXED, 'both', 'endless')).toBe(false);
  });

  it('drops a model or a provider the owner switched off, on both sides at once', () => {
    // `counted` is off and `off` is off, so neither raises capacity — and neither may raise today's usage.
    expect(freeCallCapacity(DISABLED)).toBe(0);
    expect(drawsOnFreePool(DISABLED, 'both', 'counted')).toBe(false);
    expect(drawsOnFreePool(DISABLED, 'off', 'shelved')).toBe(false);
  });

  it('agrees with the spend side about which calls are on the free pool', () => {
    expect(drawsOnFreePool(SHIPPED, 'gemini', 'gemini-3.5-flash')).toBe(true);
    expect(drawsOnFreePool(PRICED, 'paid', 'big')).toBe(false);        // priced: the owner pays, not the pool
    expect(drawsOnFreePool(SHIPPED, 'ollama', 'qwen2.5:7b')).toBe(false);  // local: free and unmetered
    expect(drawsOnFreePool(SHIPPED, 'gemini', 'gemini-3.1-flash-lite')).toBe(false);  // cheap: not a budgeted tier
    // A model the file no longer describes raises no capacity, so it must ration nobody either.
    expect(drawsOnFreePool(SHIPPED, 'gemini', 'some-model-we-renamed')).toBe(false);
    expect(drawsOnFreePool(SHIPPED, 'a-provider-we-dropped', 'whatever')).toBe(false);
    expect(drawsOnFreePool(null, 'anything', 'at-all')).toBe(true);     // no file to check against
  });

  it('moves a re-tiered model on both sides at once, whatever tier the call was recorded at', () => {
    const org = loadOrg(vault);
    // Recorded as `strong`; the file says `cheap` today, so it contributes nothing and rations nobody.
    callOn('backend_engineer', 'strong', 'g', 'mover');
    expect(freeCallCapacity(TIER_BEFORE)).toBe(0);
    expect(drawsOnFreePool(TIER_BEFORE, 'g', 'mover')).toBe(false);
    expect(divisionSpend(vault, org, dayStartIso(NOW), TIER_BEFORE).technology).toBe(0);
    // The owner promotes it to `medium`: it starts raising quota and usage in the same breath.
    expect(freeCallCapacity(TIER_AFTER)).toBe(500);
    expect(drawsOnFreePool(TIER_AFTER, 'g', 'mover')).toBe(true);
    expect(divisionSpend(vault, org, dayStartIso(NOW), TIER_AFTER).technology).toBe(1);
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

  it('counts a call against the pool that gated it, not the pool its speaker sits in (I4)', () => {
    const org = loadOrg(vault);
    // The case the roster will reach the moment the owner puts a division lead on the board, which is a
    // supported edit: `teamOf` prefers the role's own `team:`, so this speaker resolves to technology, while
    // §4 budgets every voice at that table against the house reserve. Stamped, the two agree.
    const lead = org.teams.technology.lead;
    expect(divisionOfRole(org, lead, new Set(['technology']))).toBe('technology');
    callStamped(lead, 'strong', HOUSE);
    callStamped('backend_engineer', 'strong', 'technology');
    const spend = divisionSpend(vault, org, dayStartIso(NOW));
    expect(spend[HOUSE]).toBe(1);
    expect(spend.technology).toBe(1);
  });

  it('falls back to the speaker\'s division for a row with no stamp, or a stamp that names nothing (I4)', () => {
    const org = loadOrg(vault);
    const lead = org.teams.technology.lead;
    call(lead, 'strong');                                   // written before the field existed
    callStamped(lead, 'strong', 'a_division_that_is_gone'); // an unknown pool is not a pool
    expect(divisionSpend(vault, org, dayStartIso(NOW)).technology).toBe(2);
    expect(divisionSpend(vault, org, dayStartIso(NOW))[HOUSE]).toBe(0);
  });

  it('charges the company\'s gates to the house, even when the security office sits in a division (I4, §4)', () => {
    const ciso = officeHolder(loadOrg(vault), 'security');
    // The owner moves the security office into a division — a gate is still the company's work, and the house
    // reserve is what keeps gates off the divisions' meter.
    vault.updateNote(`Roles/${ciso}.md`, (n) => ({ data: { ...n.data, team: 'technology' }, body: n.body }), 'owner');
    const org = loadOrg(vault);
    expect(teamOf(org, ciso)!.id).toBe('technology');
    const gate = budgetForRole(vault, org, SHIPPED, ciso, NOW, 'office:security.review');
    expect(gate.division).toBe(HOUSE);
    expect(gate.quota).toBe(divisionQuotas(SHIPPED, org)[HOUSE]);
    // And the count follows the stamp the gate was budgeted with, so `used / quota` reads the same pool on both
    // sides — which is the only thing that keeps the gauge from contradicting the gate.
    callStamped(ciso, 'strong', gate.division);
    expect(divisionSpend(vault, org, dayStartIso(NOW))[HOUSE]).toBe(1);
    expect(budgetForRole(vault, org, SHIPPED, ciso, NOW, 'office:security.review').used).toBe(1);
  });

  it('charges only that office\'s gates to the house, never the rest of its holder\'s work (F4)', () => {
    const ciso = officeHolder(loadOrg(vault), 'security');
    vault.updateNote(`Roles/${ciso}.md`, (n) => ({ data: { ...n.data, team: 'technology' }, body: n.body }), 'owner');
    const org = loadOrg(vault);
    // Every gate type is the house's. The reserve exists so a review cannot be starved by the division whose
    // work it is reviewing, and `GATE_JOB_TYPES` is the list of things that are reviews.
    for (const t of GATE_JOB_TYPES) expect(budgetForRole(vault, org, SHIPPED, ciso, NOW, t).division).toBe(HOUSE);
    // Ordinary work by the same person is not. Charging it to the house would take a division's own work off its
    // own meter and spend the reserve the heartbeat and the board depend on, the moment the owner maps the
    // security office to somebody who sits in a division — which this vault has just done.
    for (const t of ['engineer.ship', 'ops.harden', undefined]) {
      const own = budgetForRole(vault, org, SHIPPED, ciso, NOW, t);
      expect(own.division).toBe('technology');
      expect(own.quota).toBe(divisionQuotas(SHIPPED, org).technology);
    }
    // Both kinds of call, each stamped with the pool that gated it: the gauge splits them the same way.
    callStamped(ciso, 'strong', budgetForRole(vault, org, SHIPPED, ciso, NOW, 'office:security.review').division);
    callStamped(ciso, 'strong', budgetForRole(vault, org, SHIPPED, ciso, NOW, 'engineer.ship').division);
    const spend = divisionSpend(vault, org, dayStartIso(NOW));
    expect(spend[HOUSE]).toBe(1);
    expect(spend.technology).toBe(1);
    // An unstamped row has no job on it, so the gauge walks the role's teams and counts it where that lands.
    // Guessing "gate" from the role is the mistake this replaces: it is a fact about the job, not the person.
    call(ciso, 'strong');
    expect(divisionSpend(vault, org, dayStartIso(NOW)).technology).toBe(2);
    expect(divisionSpend(vault, org, dayStartIso(NOW))[HOUSE]).toBe(1);
    // And with the office back in its own top-level team — the shipped roster — every answer is the house's
    // again, gate or not, because `security` is not a division on either side.
    vault.updateNote(`Roles/${ciso}.md`, (n) => ({ data: { ...n.data, team: 'security' }, body: n.body }), 'owner');
    const shipped = loadOrg(vault);
    expect(budgetForRole(vault, shipped, SHIPPED, ciso, NOW, 'office:security.review').division).toBe(HOUSE);
    expect(budgetForRole(vault, shipped, SHIPPED, ciso, NOW, 'engineer.ship').division).toBe(HOUSE);
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
    expect(runwayCommentary(vault)).toEqual({ text: '', date: '' });
    vault.updateNote(jobPath(id), (n) => ({ data: n.data, body: `${n.body}\n## Result\n\n\`\`\`json\n${JSON.stringify({ status: 'done', summary: 'Free tiers cover everything.\nNothing to pay for yet.' })}\n\`\`\`\n` }), 'cfo');
    updateJob(vault, id, { status: 'done' }, 'cfo');
    expect(runwayCommentary(vault).text).toContain('Free tiers cover everything.');
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

  it('dates the CFO\'s opinion when it is not from today, and not when it is (M10)', () => {
    const org = loadOrg(vault);
    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed' }, 'owner');
    const id = enqueueRunway(vault, org, NOW)!;
    vault.updateNote(jobPath(id), (n) => ({ data: n.data, body: `${n.body}\n## Result\n\n\`\`\`json\n${JSON.stringify({ status: 'done', summary: 'Free tiers cover everything.' })}\n\`\`\`\n` }), 'cfo');
    updateJob(vault, id, { status: 'done' }, 'cfo');

    // Written today: the figures and the opinion are the same age, and a date line would be noise.
    writeRunway(vault, org, SHIPPED, NOW);
    expect(vault.readText(RUNWAY_PATH)).not.toContain('read; the figures above are current');

    // Two days later the page is regenerated four times a day and the opinion has not moved. Undated, today's
    // cash sat under a two-day-old view of it with nothing saying so.
    const later = new Date('2026-09-14T09:00:00.000Z');
    writeRunway(vault, org, SHIPPED, later);
    const note = vault.readText(RUNWAY_PATH);
    expect(note).toContain(`_From the CFO's ${String(readJob(vault, id)!.data.updated).slice(0, 10)} read; the figures above are current._`);
    expect(note).toContain('Free tiers cover everything.');
    // And the dateline belongs to the commentary, not to the page: no opinion, no line.
    expect(runwayNote({ ...moneyReport(readLedger(vault), later), bookMissing: false }, { calls: 0, paidCalls: 0, shadowCents: 0, priced: false, quotas: [], commentaryDate: '2026-01-01', generatedAt: later.toISOString() })).not.toContain('read; the figures above are current');
  });

  it('says the company has no declared currency until the book exists (M17)', () => {
    const org = loadOrg(vault);
    // The owner has deleted the book the template ships. Cash is 0 in *a* currency, and the page says whose.
    rmSync(vault.abs(LEDGER_PATH), { force: true });
    const r = moneyReport(readLedger(vault), NOW);
    expect(r.bookMissing).toBe(true);
    expect(r.currency).toBe('USD');
    writeRunway(vault, org, SHIPPED, NOW);
    const note = vault.readText(RUNWAY_PATH);
    expect(note).toContain('no declared currency');
    expect(note).toContain('because something has to be shown');

    // And once there is a book, it is the book's own currency and the sentence goes.
    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed from savings' }, 'owner');
    expect(moneyReport(readLedger(vault), NOW).bookMissing).toBe(false);
    writeRunway(vault, org, SHIPPED, NOW);
    expect(vault.readText(RUNWAY_PATH)).not.toContain('no declared currency');
  });
});

describe('the owner\'s lock on the Ledger folder (spec §7)', () => {
  const lockedRunwayRows = () => vault.events.query({ types: ['daemon.warning'] })
    .filter((e) => (e.payload as { where?: string }).where === LOCKED_RUNWAY);

  it('leaves the runway page exactly as the owner left it, and still computes the figures', () => {
    const org = loadOrg(vault);
    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed' }, 'owner');
    const before = vault.readText(RUNWAY_PATH);
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    // `vault.writeText` would not stop this — the daemon is a privileged actor — so the module asks first.
    const r = writeRunway(vault, org, SHIPPED, NOW);
    expect(r.cashCents).toBe(25000);                        // the figures are still computed
    expect(vault.readText(RUNWAY_PATH)).toBe(before);       // the page is untouched
    const warned = vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === LOCKED_RUNWAY);
    expect(warned).toHaveLength(1);
    expect(String((warned[0].payload as { reason?: string }).reason)).toContain(RUNWAY_PATH);
    expect(String((warned[0].payload as { reason?: string }).reason)).toContain('never_modify');
  });

  it('says so once, not once a cycle, and again only after the lock comes off and goes back on', () => {
    const org = loadOrg(vault);
    const lock = () => vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    const unlock = () => vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify: []\n```\n', 'owner');
    const warnings = () => vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === LOCKED_RUNWAY).length;
    lock();
    for (let i = 0; i < 3; i++) writeRunway(vault, org, SHIPPED, NOW);
    expect(warnings()).toBe(1);                 // three cycles of a decision they made on purpose, said once
    unlock();
    writeRunway(vault, org, SHIPPED, NOW);      // the page is written again; nothing is said
    expect(warnings()).toBe(1);
    lock();
    writeRunway(vault, org, SHIPPED, NOW);      // locked afresh, so it is worth saying again
    expect(warnings()).toBe(2);
  });

  it('is not silenced by an unrelated money.runway failure logged by the heartbeat', () => {
    const org = loadOrg(vault);
    // What `heartbeat.ts` writes when `writeRunway` *throws*: same step, different shape, nothing to do with
    // the owner's list. Keying the notice on the step name alone would let this stand in for it for ever.
    vault.events.emit({ type: 'daemon.warning', payload: { where: 'money.runway', message: 'ENOSPC writing Ledger/runway.md' } });
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    for (let i = 0; i < 3; i++) writeRunway(vault, org, SHIPPED, NOW);
    const locked = vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === LOCKED_RUNWAY);
    expect(locked).toHaveLength(1);
    expect(String((locked[0].payload as { reason?: string }).reason)).toContain('never_modify');
  });

  it('says nothing for five days of locked cycles: once per lock, never on a timer', () => {
    const org = loadOrg(vault);
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    // Five days of heartbeats against a lock the owner has not touched. Nothing about the lock has changed, so
    // nothing the notice is remembered against has changed either, however long the lock stands.
    for (let d = 0; d < 5; d++) writeRunway(vault, org, SHIPPED, new Date(`2026-09-1${2 + d}T12:00:00.000Z`));
    expect(lockedRunwayRows()).toHaveLength(1);
    // What is remembered is the *question* — is this page locked — and not a word of the owner's spelling of
    // it. Written out here rather than taken from `lockSituation`, so this pins the key rather than restating it.
    expect(JSON.parse(readFileSync(path.join(dir, LOCK_STATE_PATH), 'utf8'))[LOCKED_RUNWAY]).toBe(`locked:${RUNWAY_PATH}`);
  });

  it('does not repeat itself because the owner edited the page the lock protects', () => {
    const org = loadOrg(vault);
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(lockedRunwayRows()).toHaveLength(1);
    // Keeping their own runway page by hand is the whole point of locking the folder, so it is not news.
    writeFileSync(path.join(dir, RUNWAY_PATH), `${readFileSync(path.join(dir, RUNWAY_PATH), 'utf8')}\nMy own note.\n`);
    writeRunway(vault, org, SHIPPED, NOW);
    expect(lockedRunwayRows()).toHaveLength(1);
    // Taking the lock off and putting it back is news: it is a decision they made twice.
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify: []\n```\n', 'owner');
    writeRunway(vault, org, SHIPPED, NOW);
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(lockedRunwayRows()).toHaveLength(2);
  });

  it('ignores the rest of the owner\'s never_modify list, and its order', () => {
    const org = loadOrg(vault);
    const constitution = (...entries: string[]) =>
      vault.writeText('Memory/constitution.md', `# Constitution\n\n\`\`\`yaml\nnever_modify:\n${entries.map((e) => `  - ${e}`).join('\n')}\n\`\`\`\n`, 'owner');
    constitution('Ledger/');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(lockedRunwayRows()).toHaveLength(1);
    // Locking something else is a decision about something else. The shipped constitution already carries
    // five entries and `migrateOrg` appends `Teams/` on upgrade, so this is the common case, not a corner.
    constitution('Ledger/', 'Docs/');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(lockedRunwayRows()).toHaveLength(1);
    // And two entries changing places is not a decision at all.
    constitution('Docs/', 'Ledger/');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(lockedRunwayRows()).toHaveLength(1);
    // Nor is tidying away a second entry that covered the same page: it was locked before and is locked after.
    constitution('Docs/', 'Ledger/', 'Ledger/runway.md');
    writeRunway(vault, org, SHIPPED, NOW);
    constitution('Docs/', 'Ledger/');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(lockedRunwayRows()).toHaveLength(1);
    // Nor is rewriting the same entry three ways. `isNeverModifyPath` reads all three as the same lock, and so
    // does the notice — the question is whether the page is covered, never how the owner spelled it.
    for (const spelling of ['./Ledger/', 'Ledger//', 'Ledger/']) {
      constitution(spelling);
      writeRunway(vault, org, SHIPPED, NOW);
    }
    expect(lockedRunwayRows()).toHaveLength(1);
    // Taking *this* entry away and putting it back is: a cycle sees the page writable in between.
    constitution('Docs/');
    writeRunway(vault, org, SHIPPED, NOW);
    constitution('Docs/', 'Ledger/');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(lockedRunwayRows()).toHaveLength(2);
  });

  it('counts an unlock and a re-lock as a new lock without needing a write of its own', () => {
    const org = loadOrg(vault);
    const lock = (on: boolean) => vault.writeText('Memory/constitution.md',
      `# Constitution\n\n\`\`\`yaml\nnever_modify:${on ? '\n  - Ledger/' : ' []'}\n\`\`\`\n`, 'owner');
    const accrualRows = () => vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === LOCKED_ACCRUAL);
    vault.events.emit({ type: 'router.call', agent: 'ceo', ts: '2026-09-11T10:00:00.000Z', payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    lock(true);
    accrueModelCosts(vault, PRICED, NOW);
    expect(accrualRows()).toHaveLength(1);
    // An unlocked cycle on a free providers file writes nothing at all — and must still count as having seen
    // the lock go, or putting it back would be silent.
    lock(false);
    accrueModelCosts(vault, SHIPPED, NOW);
    lock(true);
    accrueModelCosts(vault, PRICED, NOW);
    expect(accrualRows()).toHaveLength(2);
  });

  it('writes no notices file at all until it has a notice to hold back', () => {
    const org = loadOrg(vault);
    const notices = path.join(dir, LOCK_STATE_PATH);
    // A vault nobody has locked anything in: there is nothing to remember, so there is no file to remember it.
    writeRunway(vault, org, SHIPPED, NOW);
    accrueModelCosts(vault, SHIPPED, NOW);
    expect(existsSync(notices)).toBe(false);
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(existsSync(notices)).toBe(true);
    // And it goes again when the lock does: "this file exists" keeps meaning "something is being suppressed".
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify: []\n```\n', 'owner');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(existsSync(notices)).toBe(false);
  });

  it.skipIf(!MODES_ENFORCED)(`remembers in this run when it cannot write, and says so once (${NEEDS_MODES})`, () => {
    const org = loadOrg(vault);
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    mkdirSync(path.join(dir, '.cubicle'), { recursive: true });
    chmodSync(path.join(dir, '.cubicle'), 0o555);
    try {
      const unwritable = () => vault.events.query({ types: ['daemon.warning'] })
        .filter((e) => (e.payload as { where?: string }).where === NOTICES_UNWRITABLE);
      for (let i = 0; i < 3; i++) writeRunway(vault, org, SHIPPED, NOW);
      // The lock notice is still said once — the memory moved into this process rather than disappearing…
      expect(lockedRunwayRows()).toHaveLength(1);
      // …and the owner is told once that it will not survive a restart, not once per cycle.
      expect(unwritable()).toHaveLength(1);
      expect(String((unwritable()[0].payload as { reason?: string }).reason)).toContain('restart');
      expect(existsSync(path.join(dir, LOCK_STATE_PATH))).toBe(false);
      // The fault is fixed. The next cycle tries the file again — the stand-in is for as long as the fault
      // lasts, not for as long as the daemon does — and the notice is still not repeated.
      chmodSync(path.join(dir, '.cubicle'), 0o755);
      writeRunway(vault, org, SHIPPED, NOW);
      expect(existsSync(path.join(dir, LOCK_STATE_PATH))).toBe(true);
      expect(JSON.parse(readFileSync(path.join(dir, LOCK_STATE_PATH), 'utf8'))[LOCKED_RUNWAY]).toBe(`locked:${RUNWAY_PATH}`);
      expect(lockedRunwayRows()).toHaveLength(1);
      expect(unwritable()).toHaveLength(1);
    } finally {
      chmodSync(path.join(dir, '.cubicle'), 0o755);
    }
  });

  it.skipIf(!MODES_ENFORCED)(`still announces a re-lock when it was the clearing write that could not land (${NEEDS_MODES})`, () => {
    const org = loadOrg(vault);
    const cubicle = path.join(dir, '.cubicle');
    const lock = (on: boolean) => vault.writeText('Memory/constitution.md',
      `# Constitution\n\n\`\`\`yaml\nnever_modify:${on ? '\n  - Ledger/' : ' []'}\n\`\`\`\n`, 'owner');
    lock(true);
    writeRunway(vault, org, SHIPPED, NOW);
    expect(lockedRunwayRows()).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(dir, LOCK_STATE_PATH), 'utf8'))[LOCKED_RUNWAY]).toBe(`locked:${RUNWAY_PATH}`);
    mkdirSync(cubicle, { recursive: true });
    chmodSync(cubicle, 0o555);
    try {
      // The fault lands on the *clearing* write: the unlock is decided, but the file keeps the old entry. If
      // that stale entry were allowed to win, the re-lock below would agree with it and be swallowed for good.
      lock(false);
      writeRunway(vault, org, SHIPPED, NOW);
      expect(lockedRunwayRows()).toHaveLength(1);
      // Same path, same situation string, fault still standing — and it is still a second lock.
      lock(true);
      writeRunway(vault, org, SHIPPED, NOW);
      expect(lockedRunwayRows()).toHaveLength(2);
      chmodSync(cubicle, 0o755);
      // And once the file can take a write again it is rewritten from what this process actually decided.
      writeRunway(vault, org, SHIPPED, NOW);
      expect(lockedRunwayRows()).toHaveLength(2);
      expect(JSON.parse(readFileSync(path.join(dir, LOCK_STATE_PATH), 'utf8'))[LOCKED_RUNWAY]).toBe(`locked:${RUNWAY_PATH}`);
    } finally {
      chmodSync(cubicle, 0o755);
    }
  });

  it.skipIf(!MODES_ENFORCED)(`repairs a notices file it could not read, on the first change (${NEEDS_MODES})`, () => {
    const org = loadOrg(vault);
    const notices = path.join(dir, LOCK_STATE_PATH);
    // A previous run left a perfectly good file behind, and the load of *this* run cannot read it.
    mkdirSync(path.join(dir, '.cubicle'), { recursive: true });
    writeFileSync(notices, JSON.stringify({ [LOCKED_RUNWAY]: `locked:${RUNWAY_PATH}` }));
    chmodSync(notices, 0o000);
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    const unreadable = () => vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === NOTICES_UNREADABLE);
    try {
      // It starts with no memory rather than half of one, says so once, and repeats the standing complaint.
      writeRunway(vault, org, SHIPPED, NOW);
      expect(unreadable()).toHaveLength(1);
      expect(lockedRunwayRows()).toHaveLength(1);
      // And the file it could not read has been rewritten from memory, so the next run reads something true.
      expect(JSON.parse(readFileSync(notices, 'utf8'))).toEqual({ [LOCKED_RUNWAY]: `locked:${RUNWAY_PATH}` });
      // A second cycle adds neither sentence: the memory was loaded once and the file is no longer behind.
      writeRunway(vault, org, SHIPPED, NOW);
      expect(unreadable()).toHaveLength(1);
      expect(lockedRunwayRows()).toHaveLength(1);
    } finally {
      if (existsSync(notices)) chmodSync(notices, 0o644);
    }
  });

  it('does not leave a file it distrusted for the next run to believe', () => {
    const org = loadOrg(vault);
    const notices = path.join(dir, LOCK_STATE_PATH);
    // The same shape without needing permissions: a file that parses as nothing takes the same branch as one
    // that cannot be read at all. The owner has since taken the lock off, so this run's only decision is a
    // clear — and a clear of something the memory does not hold used to write nothing, leaving the stale entry
    // for the next run to read back and swallow a re-lock with.
    mkdirSync(path.join(dir, '.cubicle'), { recursive: true });
    writeFileSync(notices, '{ not json');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === NOTICES_UNREADABLE)).toHaveLength(1);
    // Nothing is remembered, so there is nothing to remember — and the file says so too.
    expect(existsSync(notices)).toBe(false);
  });

  it('reads the file once on a fresh run, and honours or distrusts it accordingly', async () => {
    const freshVault = async (notices: string | null) => {
      const root = mkdtempSync(path.join(tmpdir(), 'cubicle-daemon-money-run-'));
      const v = (await scaffoldVault(root)).vault;
      v.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
      if (notices !== null) {
        mkdirSync(path.join(root, '.cubicle'), { recursive: true });
        writeFileSync(path.join(root, LOCK_STATE_PATH), notices);
      }
      return { root, v };
    };
    const rows = (v: Vault, where: string) => v.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === where);

    // A run that starts where the last one left off: the file is read once and believed, so a complaint the
    // previous run already made is not made again.
    const remembered = await freshVault(JSON.stringify({ [LOCKED_RUNWAY]: `locked:${RUNWAY_PATH}` }));
    try {
      writeRunway(remembered.v, loadOrg(remembered.v), SHIPPED, NOW);
      expect(rows(remembered.v, LOCKED_RUNWAY)).toHaveLength(0);
    } finally { remembered.v.close(); rmSync(remembered.root, { recursive: true, force: true }); }

    // A file that makes no sense is not half-believed: the run starts with no memory, says so once, and the
    // standing complaint is made again — noise, which is the direction this is allowed to fail in.
    const broken = await freshVault('{ not json');
    try {
      writeRunway(broken.v, loadOrg(broken.v), SHIPPED, NOW);
      writeRunway(broken.v, loadOrg(broken.v), SHIPPED, NOW);
      expect(rows(broken.v, LOCKED_RUNWAY)).toHaveLength(1);
      expect(rows(broken.v, NOTICES_UNREADABLE)).toHaveLength(1);
      expect(String((rows(broken.v, NOTICES_UNREADABLE)[0].payload as { reason?: string }).reason)).toContain('once more');
    } finally { broken.v.close(); rmSync(broken.root, { recursive: true, force: true }); }
  });

  it('regenerates it again as soon as the owner takes the lock off', () => {
    const org = loadOrg(vault);
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    writeRunway(vault, org, SHIPPED, NOW);
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify: []\n```\n', 'owner');
    writeRunway(vault, org, SHIPPED, NOW);
    expect(vault.readText(RUNWAY_PATH)).toContain('# Runway');
    expect(vault.readText(RUNWAY_PATH)).toContain('| technology |');
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

  it('is not fooled by an agent row keyed near its own, and still books the day (I2, I3)', () => {
    // What `ledger.record` stores for a job that recorded a cost: `<ref>:<kind>`. It is not a `model-<date>` row,
    // so it cannot be mistaken for a charged day — and the daemon's own key for that day is still free. (The tool
    // refuses a `model-` ref outright; this is the other half, at the reader.)
    appendEntry(vault, { at: '2026-09-11T09:00:00.000Z', kind: 'cost', cents: 100, mode: 'live', who: 'cfo', why: 'A real charge the CFO booked', ref: 'model-2026-09-11:cost' }, 'cfo');
    vault.events.emit({ type: 'router.call', agent: 'ceo', ts: '2026-09-11T10:00:00.000Z', payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    const e = accrueModelCost(vault, PRICED, NOW)!;
    expect(e).toMatchObject({ kind: 'cost', cents: 300, ref: 'model-2026-09-11' });
    expect(readLedger(vault).entries.map((x) => x.ref)).toEqual(['model-2026-09-11:cost', 'model-2026-09-11']);
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

  it('complains about a stamp in the future instead of never accruing again', () => {
    vault.events.emit({ type: 'router.call', agent: 'ceo', ts: '2026-09-11T10:00:00.000Z', payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    // `prices_verified: 2027-09-11` would put the start of the walk past its end, so nothing would ever be
    // booked and nothing would ever be left to continue from — paid cost would silently stop reaching the book.
    expect(accrueModelCosts(vault, PRICED_FUTURE, NOW).map((r) => r.ref)).toEqual(['model-2026-09-11']);
    const stampRows = () => vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === STAMP_AHEAD);
    expect(stampRows()).toHaveLength(1);
    expect(String((stampRows()[0].payload as { reason?: string }).reason)).toContain('2027-09-11');
  });

  it('mentions a mistyped stamp once per stamp, whatever day it is read on', () => {
    const stampRows = () => vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === STAMP_AHEAD);
    // Nothing chargeable, so no `model-<date>` row is ever written and every cycle re-reads the stamp — which
    // is precisely the shape that used to fill the log with one sentence.
    for (let i = 0; i < 4; i++) accrueModelCosts(vault, PRICED_FUTURE, NOW);
    expect(stampRows()).toHaveLength(1);
    expect(String((stampRows()[0].payload as { reason?: string }).reason)).toContain('2027-09-11');
    expect((stampRows()[0].payload as { stamp?: string }).stamp).toBe('2027-09-11');
    // The sentence names the day it clamped to, which moves at every UTC midnight. The typo has not moved, so
    // neither has the situation: three more days of cycles are still one row.
    for (const d of ['2026-09-13', '2026-09-14', '2026-09-15']) accrueModelCosts(vault, PRICED_FUTURE, new Date(`${d}T12:00:00.000Z`));
    expect(stampRows()).toHaveLength(1);
    // A *different* typo is a different situation, and worth saying.
    const OTHER = parseProvidersConfig(`
prices_verified: "2028-01-01"
cascade: [paid]
providers:
  - id: paid
    base_url: https://example.test/v1
    models:
      - { id: big, tier: strong, tools: native, limits: { rpd: 100 }, price: { input_per_mtok: 300, output_per_mtok: 1500 } }
`);
    accrueModelCosts(vault, OTHER, NOW);
    accrueModelCosts(vault, OTHER, NOW);
    expect(stampRows()).toHaveLength(2);
    expect(String((stampRows()[1].payload as { reason?: string }).reason)).toContain('2028-01-01');
  });

  it('says it again when a typo the owner fixed comes back', () => {
    const stampRows = () => vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === STAMP_AHEAD);
    accrueModelCosts(vault, PRICED_FUTURE, NOW);
    expect(stampRows()).toHaveLength(1);
    // Fixed: a stamp that is fine again forgets the complaint about the one that was not.
    accrueModelCosts(vault, PRICED_STAMPED, NOW);
    expect(stampRows()).toHaveLength(1);
    // And back — a revert, a restored backup, a bad merge. The same value is news a second time.
    accrueModelCosts(vault, PRICED_FUTURE, NOW);
    expect(stampRows()).toHaveLength(2);
    expect(String((stampRows()[1].payload as { stamp?: string }).stamp)).toBe('2027-09-11');
  });

  it('gives up with one warning when the owner has locked the book, and never throws into the cycle', () => {
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    for (const day of ['2026-09-09', '2026-09-10', '2026-09-11']) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: `${day}T10:00:00.000Z`, payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    }
    // The owner's veto is their decision, not a failure: the walk stops, the book stays untouched, and the
    // heartbeat's money step carries on rather than dying three days deep in an arithmetic loop.
    expect(accrueModelCosts(vault, PRICED, NOW)).toEqual([]);
    expect(accrueModelCost(vault, PRICED, NOW)).toBeNull();
    expect(readLedger(vault).entries).toEqual([]);
    // Once while the lock stands — not once per day of the walk, and not once per cycle either.
    const warned = vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === LOCKED_ACCRUAL);
    expect(warned).toHaveLength(1);                    // two calls above, three days each, one row
    expect(String((warned[0].payload as { reason?: string }).reason)).toContain('Ledger/ledger.md');
    expect(String((warned[0].payload as { reason?: string }).reason)).toContain('never_modify');
    expect(String((warned[0].payload as { reason?: string }).reason)).toContain('2026-09-09 to 2026-09-11');
  });

  it('names the days it is skipping, and says so again when that range moves on', () => {
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/\n```\n', 'owner');
    for (const day of ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12']) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: `${day}T10:00:00.000Z`, payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    }
    const reasons = () => vault.events.query({ types: ['daemon.warning'] })
      .filter((e) => (e.payload as { where?: string }).where === LOCKED_ACCRUAL)
      .map((e) => String((e.payload as { reason?: string }).reason));
    accrueModelCosts(vault, PRICED, NOW);
    accrueModelCosts(vault, PRICED, NOW);                         // same day, same range: said once
    expect(reasons()).toHaveLength(1);
    expect(reasons()[0]).toContain('2026-09-09 to 2026-09-11');
    // A day later the lock still stands, but the range it is skipping has grown — so it says the new one.
    accrueModelCosts(vault, PRICED, new Date('2026-09-13T12:00:00.000Z'));
    expect(reasons()).toHaveLength(2);
    expect(reasons()[1]).toContain('2026-09-09 to 2026-09-12');
    expect(reasons()[1]).not.toBe(reasons()[0]);
  });

  it('still reaches back thirty days when the file says nothing about when its prices appeared', () => {
    for (const day of ['2026-09-01', '2026-09-11']) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: `${day}T10:00:00.000Z`, payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    }
    expect(accrueModelCosts(vault, PRICED, NOW).map((r) => r.ref)).toEqual(['model-2026-09-01', 'model-2026-09-11']);
  });

  it('re-walks a run of free days without asking the log about each one (M11)', () => {
    // Nothing to charge between the two paid days, so no `model-<date>` row marks them charged and the next
    // cycle starts from the same place again. The window is now one query whatever its length, and the days with
    // no calls at all are never visited.
    const queries: unknown[] = [];
    const real = vault.events.query.bind(vault.events);
    vault.events.query = ((q: Parameters<typeof real>[0]) => { queries.push(q); return real(q); }) as typeof real;
    try {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: '2026-08-20T10:00:00.000Z', payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: '2026-09-11T10:00:00.000Z', payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
      queries.length = 0;
      expect(accrueModelCosts(vault, PRICED, NOW).map((r) => r.ref)).toEqual(['model-2026-08-20', 'model-2026-09-11']);
      // 22 days in the window; one query for the calls, and never one per day.
      expect(queries.filter((q) => (q as { types?: string[] }).types?.includes('router.call'))).toHaveLength(1);
    } finally { vault.events.query = real; }
  });

  it('reads a long window in bounded chunks, so no one query can hold a year of the log (F3)', () => {
    const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    const dayOf = (days: number) => ago(days).slice(0, 10);
    // The book's newest accrual row is 90 days old, so the walk's window is 89 days: three chunks of the 30-day
    // accrual lookback. Not one query holding a quarter of the event log, and not 89 queries to find three days.
    appendEntry(vault, { at: ago(90), kind: 'cost', cents: 100, mode: 'live', who: 'daemon', why: 'A charged day', ref: `model-${dayOf(90)}` }, 'daemon');
    for (const days of [80, 45, 2]) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: ago(days), payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    }
    const queries: { types?: string[]; limit?: number }[] = [];
    const real = vault.events.query.bind(vault.events);
    vault.events.query = ((q: Parameters<typeof real>[0]) => { queries.push(q as { types?: string[]; limit?: number }); return real(q); }) as typeof real;
    let refs: string[] = [];
    try { refs = accrueModelCosts(vault, PRICED, NOW).map((r) => r.ref); } finally { vault.events.query = real; }
    // Every paid day in the window is still charged, one row each: the chunking changes how the log is read and
    // nothing at all about what the company owes.
    expect(refs).toEqual([`model-${dayOf(80)}`, `model-${dayOf(45)}`, `model-${dayOf(2)}`]);
    const asked = queries.filter((q) => q.types?.includes('router.call'));
    expect(asked).toHaveLength(3);
    for (const q of asked) expect(typeof q.limit).toBe('number');       // and no query is unbounded in rows either
  });

  it('a chunk the row limit cut is re-asked day by day, so no day is ever charged short (F3)', () => {
    const at = (day: string, hour: number) => `2026-09-${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
    for (const [day, hour] of [['09', 10], ['09', 11], ['10', 10], ['11', 10], ['11', 11]] as [string, number][]) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: at(day, hour), payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1000, completion_tokens: 0 } } });
    }
    const from = '2026-09-09T00:00:00.000Z';
    const to = '2026-09-11T23:59:59.999Z';
    const whole = callsByDay(vault, from, to);
    expect([...whole.keys()].sort()).toEqual(['2026-09-09', '2026-09-10', '2026-09-11']);
    // A limit of three against five rows in one chunk. The limit keeps the *newest* rows, so a chunk taken as-is
    // would leave the oldest day of it short — and an accrual row is written once and never corrected. The walk
    // notices the chunk came back full and asks that stretch a day at a time instead.
    const cut = callsByDay(vault, from, to, 3);
    expect([...cut.keys()].sort()).toEqual([...whole.keys()].sort());
    for (const day of whole.keys()) expect(cut.get(day)!.length).toBe(whole.get(day)!.length);
  });

  it('clamps a walk continuing from an ancient row, so one old accrual cannot turn a cycle into a crawl (M9)', () => {
    expect(MAX_ACCRUAL_DAYS).toBe(370);
    const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    // A book whose newest accrual row is 500 days old: the walk would otherwise start there.
    appendEntry(vault, { at: ago(500), kind: 'cost', cents: 100, mode: 'live', who: 'daemon', why: 'An ancient day of model cost', ref: `model-${ago(500).slice(0, 10)}` }, 'daemon');
    for (const days of [400, 300, 1]) {
      vault.events.emit({ type: 'router.call', agent: 'ceo', ts: ago(days), payload: { provider: 'paid', model: 'big', tier: 'strong', tokens: { prompt_tokens: 1_000_000, completion_tokens: 0 } } });
    }
    const refs = accrueModelCosts(vault, PRICED, NOW).map((r) => r.ref);
    // The 400-day-old call is before the floor and is never charged; everything inside it still is.
    expect(refs).toEqual([`model-${ago(300).slice(0, 10)}`, `model-${ago(1).slice(0, 10)}`]);
    const floor = ago(MAX_ACCRUAL_DAYS).slice(0, 10);
    for (const r of refs) expect(r.slice('model-'.length) >= floor).toBe(true);
  });
});

describe('the CFO\'s brief for the daily runway job (spec §2, decision 5)', () => {
  it('carries every figure, caps the answer at five lines, and forbids deriving a number', () => {
    // The single textual guard behind decision 5: the job's one output is an opinion, and a job that has to
    // derive a figure first is a job that will eventually derive the wrong one.
    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed from savings' }, 'owner');
    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'cost', cents: 1000, mode: 'live', who: 'daemon', why: 'A day of priced calls' }, 'daemon');
    appendEntry(vault, { at: '2026-09-11T09:00:00.000Z', kind: 'revenue', cents: 4000, mode: 'mock', who: 'cso', why: 'A simulated nursery order' }, 'cso');
    const r = moneyReport(readLedger(vault), NOW);
    const goal = runwayGoal(r);
    expect(goal).toContain('USD 240.00');                       // cash
    expect(goal).toContain(`- Burn: ${money(r.burnCentsPerDay, r.currency)} a day`);
    expect(goal).toContain(`- Runway: ${r.runwayDays} days`);
    expect(goal).toContain('USD 40.00');                        // the simulated revenue, named as not cash
    expect(goal).toContain('not cash, nobody paid it');
    expect(goal).toContain('do not recalculate anything');
    expect(goal).toContain('at most five lines');
    expect(goal).toContain(RUNWAY_PATH);
    expect(goal).toContain(LEDGER_PATH);

    // An empty book says "not spending" in words, and never a number: a runway of 0 days and "nothing is being
    // spent" are opposite facts, and this is the one place a model reads them.
    const empty = runwayGoal(moneyReport({ currency: 'USD', entries: [], problems: [] }, NOW));
    expect(empty).toContain('not spending');
    expect(empty).not.toMatch(/Runway: \d/);
    expect(empty).not.toContain('Simulated revenue');
    expect(empty).not.toContain('do not parse');

    // And a book with an unreadable row tells the CFO to say so, rather than leaving the owner to find it.
    const withProblem = runwayGoal(moneyReport({ currency: 'USD', entries: [], problems: [{ line: 12, text: '| junk |', reason: 'not an amount' }] }, NOW));
    expect(withProblem).toContain('1 row(s)');
    expect(withProblem).toContain('say so');
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

  it('is still one note when a past-dated accrual moves the crossing entry and the stamp was lost', () => {
    // Funded 09-10, spent to zero at 09-12T00:30 — the crossing entry, and the mark the note is keyed on.
    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'capital', cents: 30000, mode: 'live', who: 'owner', why: 'Seed' }, 'owner');
    appendEntry(vault, { at: '2026-09-12T00:30:00.000Z', kind: 'cost', cents: 30000, mode: 'live', who: 'daemon', why: 'All of it' }, 'daemon');
    const org = loadOrg(vault);
    const before = dormancyMark(vault);
    expect(before).toBe('2026-09-12T00:30:00.000Z');
    const id = dormancyMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW)!;
    // The crash: the proposal landed, the write that stamps `money`/`mark` on to it did not.
    const rel = findInboxById(vault, id)!.path;
    vault.updateNote(rel, (n) => {
      const { money: _m, mark: _k, ...rest } = n.data as Record<string, unknown>;
      return { data: rest, body: n.body };
    }, 'test');
    // Now a past-dated accrual lands *before* the crossing and takes cash to zero a few hours earlier.
    appendEntry(vault, { at: '2026-09-11T23:59:59.999Z', kind: 'cost', cents: 30000, mode: 'live', who: 'daemon', why: 'Yesterday\'s models', ref: 'model-2026-09-11' }, 'daemon');
    expect(dormancyMark(vault)).toBe('2026-09-11T23:59:59.999Z');   // the crossing really did move
    // The orphan is found by its id shape, repaired, and not written a second time.
    expect(dormancyMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW)).toBeNull();
    const dormant = listInbox(vault).filter((n) => (n.data as { money?: string }).money === 'dormant');
    expect(dormant).toHaveLength(1);
    expect(dormant[0].data.id).toBe(id);
  });

  it('does not let an orphan from an earlier episode silence a later one', () => {
    // The reviewer's repro. Episode 1: funded 09-10, spent to zero 09-11T08:00.
    appendEntry(vault, { at: '2026-09-10T08:00:00.000Z', kind: 'capital', cents: 25000, mode: 'live', who: 'owner', why: 'Seed' }, 'owner');
    appendEntry(vault, { at: '2026-09-11T08:00:00.000Z', kind: 'cost', cents: 25000, mode: 'live', who: 'daemon', why: 'All of it' }, 'daemon');
    const org = loadOrg(vault);
    const one = dormancyMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW)!;
    // The crash: the note landed during episode 1, its `money`/`mark` stamp did not.
    vault.updateNote(findInboxById(vault, one)!.path, (n) => {
      const { money: _m, mark: _k, ...rest } = n.data as Record<string, unknown>;
      return { data: { ...rest, created: '2026-09-11T08:30:00.000Z' }, body: n.body };
    }, 'test');
    // The owner tops up — episode 1 closes with the orphan still sitting unstamped in the inbox…
    appendEntry(vault, { at: '2026-09-11T12:00:00.000Z', kind: 'capital', cents: 10000, mode: 'live', who: 'owner', why: 'More' }, 'owner');
    // …and then the company runs out a second time.
    appendEntry(vault, { at: '2026-09-12T06:00:00.000Z', kind: 'cost', cents: 10000, mode: 'live', who: 'daemon', why: 'And again' }, 'daemon');
    expect(dormancyEpisodes(vault)).toHaveLength(2);
    // The orphan belongs to episode 1 and must not be mistaken for episode 2 having been announced.
    const two = dormancyMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW);
    expect(two).not.toBeNull();
    expect(two).not.toBe(one);
    expect(two).toBe(moneyMessageId('dormant', '2026-09-12T06:00:00.000Z'));
    expect(listInbox(vault).filter((n) => (n.data as { money?: string }).money === 'dormant')).toHaveLength(1);
  });

  it('can still announce a later episode after the owner deletes the revival note', () => {
    fund(); spend();
    const org = loadOrg(vault);
    dormancyMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW);
    appendEntry(vault, { at: '2026-09-12T08:00:00.000Z', kind: 'capital', cents: 10000, mode: 'live', who: 'owner', why: 'More' }, 'owner');
    const revived = revivalMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW)!;
    // The owner files the "Back to work" note away. Open and closed are read off the book, not the inbox, so
    // this costs at most one repeated message — it must never silence the next time the company runs out.
    vault.remove(findInboxById(vault, revived)!.path, 'owner');
    appendEntry(vault, { at: '2026-09-12T09:00:00.000Z', kind: 'cost', cents: 10000, mode: 'live', who: 'daemon', why: 'And again' }, 'daemon');
    const episodes = dormancyEpisodes(vault);
    expect(episodes).toHaveLength(2);
    expect(episodes[0].end).toBe('2026-09-12T08:00:00.000Z');
    expect(episodes[1].end).toBeNull();
    expect(dormancyMessage(vault, org, moneyReport(readLedger(vault), NOW), NOW)).not.toBeNull();
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
