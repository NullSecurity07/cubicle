import { describe, it, expect } from 'vitest';
import {
  BURN_WINDOW_DAYS, RUNWAY_WARN_DAYS, RUNWAY_COMMENTARY,
  moneyReport, moneyLine, moneyNeedsYou, runwayNote, parseLedger, ledgerTemplate, ledgerRow, LedgerEntry, LEDGER_PATH,
} from '../src/money.js';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** A book from rows, so every case reads like the file an owner would actually have. */
const book = (...rows: { at: string; kind: 'capital' | 'revenue' | 'cost'; cents: number; mode?: 'live' | 'mock'; why?: string }[]) =>
  parseLedger(ledgerTemplate('GBP', day(60)) + rows.map((r) => ledgerRow(LedgerEntry.parse({ mode: 'live', who: 'owner', why: 'x', ref: '', ...r }))).join('\n') + '\n');

describe('cash, burn and runway (spec §2)', () => {
  it('an empty book is a company that has not been funded, not a company that is broke', () => {
    const r = moneyReport(parseLedger(ledgerTemplate()), NOW);
    expect(r).toMatchObject({ cashCents: 0, burnCentsPerDay: 0, runwayDays: null, funded: false, dormant: false, entries: 0 });
    expect(moneyLine(r)).toContain('USD 0.00 cash');
    expect(moneyLine(r)).toContain('not spending');
    expect(moneyNeedsYou(r)).toEqual([]);
  });

  it('cash is capital plus revenue minus cost, and only what really moved', () => {
    const r = moneyReport(book(
      { at: day(20), kind: 'capital', cents: 25000 },
      { at: day(10), kind: 'revenue', cents: 4000 },
      { at: day(5), kind: 'cost', cents: 1500 },
      { at: day(4), kind: 'revenue', cents: 99999, mode: 'mock' },
      { at: day(3), kind: 'cost', cents: 88888, mode: 'mock' },
    ), NOW);
    expect(r.cashCents).toBe(25000 + 4000 - 1500);
    expect(r.mockRevenueCents).toBe(99999);
    expect(r.currency).toBe('GBP');
    expect(moneyLine(r)).toContain('GBP 275.00 cash');
    expect(moneyLine(r)).toContain('simulated revenue, which is not cash');
    // Every field an owner-facing message downstream prints verbatim (task-8's dormancy/revival messages read
    // inCents/outCents; other consumers read mockCostCents/firstAt/lastAt): pin all of them, not just cash.
    expect(r).toMatchObject({ inCents: 29000, outCents: 1500, mockCostCents: 88888 });
    expect(r.firstAt).toBe(day(20));
    expect(r.lastAt).toBe(day(3));
  });

  it('a mock row older than every live row does not stretch the burn window and flatter it', () => {
    const r = moneyReport(book(
      { at: day(59), kind: 'revenue', cents: 500000, mode: 'mock' },
      { at: day(1), kind: 'capital', cents: 10000 },
      { at: day(0), kind: 'cost', cents: 300 },
    ), NOW);
    // Without the fix this reads windowDays 30 / burn 10 — the mock row must not be allowed to say the
    // company has existed for 30 days when it has only been spending real money for one.
    expect(r.windowDays).toBe(1);
    expect(r.burnCentsPerDay).toBe(300);
  });

  it('a real spend never rounds down to a burn of 0', () => {
    const r = moneyReport(book({ at: day(30), kind: 'capital', cents: 10000 }, { at: day(29), kind: 'cost', cents: 14 }), NOW);
    expect(r.windowOutCents).toBe(14);
    expect(r.windowDays).toBe(30);
    // 14 / 30 rounds to 0 — the floor keeps it a nonzero, honest "something is costing money".
    expect(r.burnCentsPerDay).toBe(1);
    expect(r.runwayDays).not.toBeNull();
    expect(moneyLine(r)).not.toContain('not spending');
  });

  it('burn is the window the company has actually existed for, not a flat 30 days', () => {
    const young = moneyReport(book({ at: day(1), kind: 'capital', cents: 10000 }, { at: day(0), kind: 'cost', cents: 300 }), NOW);
    expect(young.windowDays).toBe(1);
    expect(young.burnCentsPerDay).toBe(300);          // spent 3.00 yesterday → 3.00 a day, not 0.10
    const old = moneyReport(book({ at: day(59), kind: 'capital', cents: 100000 }, { at: day(2), kind: 'cost', cents: 3000 }), NOW);
    expect(old.windowDays).toBe(BURN_WINDOW_DAYS);
    expect(old.burnCentsPerDay).toBe(100);            // 30.00 over the 30-day window
  });

  it('a cost older than the window does not count towards burn, but still counts against cash', () => {
    const r = moneyReport(book(
      { at: day(59), kind: 'capital', cents: 100000 },
      { at: day(45), kind: 'cost', cents: 60000 },
      { at: day(1), kind: 'cost', cents: 300 },
    ), NOW);
    expect(r.cashCents).toBe(100000 - 60000 - 300);
    expect(r.windowOutCents).toBe(300);
    expect(r.burnCentsPerDay).toBe(10);
  });

  it('runway is cash over burn in whole days, and null — never infinity — when nothing is spent', () => {
    expect(moneyReport(book({ at: day(10), kind: 'capital', cents: 100000 }), NOW).runwayDays).toBeNull();
    const r = moneyReport(book({ at: day(30), kind: 'capital', cents: 100000 }, { at: day(1), kind: 'cost', cents: 30000 }), NOW);
    expect(r.burnCentsPerDay).toBe(1000);
    expect(r.runwayDays).toBe(70);
    expect(moneyLine(r)).toContain('runway 70 days');
    expect(moneyNeedsYou(r)).toEqual([]);
  });

  it('warns the owner below the warning line, and never below zero', () => {
    const r = moneyReport(book({ at: day(30), kind: 'capital', cents: 10000 }, { at: day(1), kind: 'cost', cents: 30000 }), NOW);
    expect(r.cashCents).toBe(-20000);
    expect(r.runwayDays).toBe(0);
    expect(RUNWAY_WARN_DAYS).toBe(14);
    const thin = moneyReport(book({ at: day(30), kind: 'capital', cents: 40000 }, { at: day(1), kind: 'cost', cents: 30000 }), NOW);
    expect(thin.runwayDays).toBe(10);
    expect(moneyNeedsYou(thin)[0]).toContain('Runway is 10 days');
  });

  it('dormant means funded and spent out — never merely "no money yet"', () => {
    const neverFunded = moneyReport(book({ at: day(1), kind: 'revenue', cents: 0, mode: 'mock' }), NOW);
    expect(neverFunded.funded).toBe(false);
    expect(neverFunded.dormant).toBe(false);
    const spentOut = moneyReport(book({ at: day(20), kind: 'capital', cents: 25000 }, { at: day(2), kind: 'cost', cents: 25000 }), NOW);
    expect(spentOut).toMatchObject({ funded: true, cashCents: 0, dormant: true });
    expect(spentOut.lastLiveAt).toBe(day(2));
    expect(moneyLine(spentOut)).toContain('the company is dormant');
    expect(moneyNeedsYou(spentOut)[0]).toContain('dormant');
    expect(moneyNeedsYou(spentOut)[0]).toContain(LEDGER_PATH);
  });

  it('reports the rows nobody can read, with the line to fix', () => {
    const l = parseLedger(ledgerTemplate() + '| 2026-09-12T08:00:00.000Z | capital | lots | live | owner | Typo | |\n');
    const r = moneyReport(l, NOW);
    expect(r.problems).toHaveLength(1);
    expect(moneyNeedsYou(r).at(-1)).toContain('cannot be read');
    expect(moneyNeedsYou(r).at(-1)).toContain('1 row in');
    expect(moneyNeedsYou(r).at(-1)).toContain('line 15');
    // The runway note's "Rows that do not parse" section must actually render a bad row, not only the empty case.
    expect(runwayNote(r, { calls: 0, paidCalls: 0, shadowCents: 0, priced: false, quotas: [] })).toContain('- line 15');
  });

  it('pluralises "row"/"line" for more than one unreadable row', () => {
    const l = parseLedger(ledgerTemplate()
      + '| 2026-09-12T08:00:00.000Z | capital | lots | live | owner | Typo one | |\n'
      + '| 2026-09-12T09:00:00.000Z | capital | more lots | live | owner | Typo two | |\n');
    const r = moneyReport(l, NOW);
    expect(r.problems).toHaveLength(2);
    const msg = moneyNeedsYou(r).at(-1)!;
    expect(msg).toContain('2 rows in');
    expect(msg).toContain('lines 15, 16');
  });
});

describe('the runway note (spec §2)', () => {
  const base = moneyReport(book({ at: day(20), kind: 'capital', cents: 25000 }), NOW);

  it('carries the figures in frontmatter so nothing has to read the prose', () => {
    const md = runwayNote(base, { calls: 12, paidCalls: 0, shadowCents: 0, priced: false, quotas: [], generatedAt: NOW.toISOString() });
    const fm = md.split('---')[1];
    expect(fm).toContain('cash_cents: 25000');
    expect(fm).toContain('burn_cents_per_day: 0');
    expect(fm).toContain('runway_days: null');
    expect(fm).toContain('currency: GBP');
    expect(md).toContain('**Cash:** GBP 250.00');
    expect(md).toContain('nothing was written by a model');
  });

  it('says plainly that nothing is priced, rather than implying the calls were free by accident', () => {
    expect(runwayNote(base, { calls: 12, paidCalls: 0, shadowCents: 0, priced: false, quotas: [] })).toContain('carries a `price:`');
    expect(runwayNote(base, { calls: 12, paidCalls: 0, shadowCents: 0, priced: true, quotas: [] })).toContain('were on free tiers, so they cost nothing');
    expect(runwayNote(base, { calls: 12, paidCalls: 3, shadowCents: 450, priced: true, quotas: [] })).toContain('3 of 12 model calls today were on a priced model: GBP 4.50');
  });

  it('draws the division quota table, and keeps the CFO\'s words when there are any', () => {
    const md = runwayNote(base, { calls: 1, paidCalls: 0, shadowCents: 0, priced: false, quotas: [{ division: 'technology', used: 40, quota: 600 }, { division: 'house', used: 3, quota: 653 }], commentary: 'Free tiers cover everything we do.\nNo reason to pay for anything yet.' });
    expect(md).toContain('| technology | 40 | 600 |');
    expect(md).toContain('| house | 3 | 653 |');
    expect(md).toContain(RUNWAY_COMMENTARY);
    expect(md).toContain('Free tiers cover everything we do.');
    expect(runwayNote(base, { calls: 1, paidCalls: 0, shadowCents: 0, priced: false, quotas: [] })).toContain('The CFO has not commented yet');
  });

  it('says the company is dormant on the page the owner is most likely to open', () => {
    const spentOut = moneyReport(book({ at: day(20), kind: 'capital', cents: 25000 }, { at: day(2), kind: 'cost', cents: 25000 }), NOW);
    expect(runwayNote(spentOut, { calls: 0, paidCalls: 0, shadowCents: 0, priced: false, quotas: [] })).toContain('**The company is dormant.**');
  });
});
