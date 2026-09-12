import { describe, it, expect } from 'vitest';
import { SURFACES, chartBars } from './surfaces.js';
import { bankView } from './content.js';
import { applySnapshot, emptyState, type MoneyView, type Snapshot, type State } from '../state.js';

const quota = [{ provider: 'gemini', model: 'gemini-3.5-flash', rpm_used: 0, rpd_used: 7, tpm_used: 0, cooling_until: null, limits: { rpm: 0, rpd: 100, tpm: 0 } }];

const funded: MoneyView = {
  currency: 'USD', cash_cents: 25000, cash: 'USD 250.00',
  burn_cents_per_day: 1000, burn: 'USD 10.00', runway_days: 25, runway: '25 days',
  dormant: false, mock_revenue_cents: 0, mock_revenue: 'USD 0.00', problems: 0,
  budgets: [{ division: 'technology', used: 40, quota: 882 }, { division: 'house', used: 3, quota: 653 }],
  entries: [{ at: '2026-09-12T08:00:00.000Z', kind: 'capital', amount: 'USD 250.00', mode: 'live', who: 'owner', why: 'Seed from savings' }],
};

/**
 * Through the real snapshot path, not by writing `money` on to a state object: `applySnapshot` is what the live
 * app runs, and taking it out of the loop is how C1 went unnoticed — the screen was tested against a literal
 * nobody produced. The daemon's own `test/snapshot-money.test.ts` asserts that `buildSnapshot` sends exactly
 * this shape; the two tests together are the whole contract.
 */
const wire: Snapshot = {
  op: 'snapshot', at: '2026-09-12T08:00:00.000Z', roles: [], jobs: [], surfaces: [], quota,
  money: null, latestRun: null, plan: '', pendingProposals: 0,
};
const withMoney = (m: MoneyView | null): State => applySnapshot(emptyState(), { ...wire, money: m });

describe('the bank screen (spec §6)', () => {
  it('is fed by the snapshot the daemon sends, field for field', () => {
    // The same list `packages/daemon/test/snapshot-money.test.ts` pins on `buildSnapshot`'s output.
    expect(Object.keys(funded).sort()).toEqual([
      'currency', 'cash_cents', 'cash', 'burn_cents_per_day', 'burn', 'runway_days', 'runway',
      'dormant', 'mock_revenue_cents', 'mock_revenue', 'problems', 'budgets', 'entries',
    ].sort());
    expect(withMoney(funded).money).toEqual(funded);
    // An older daemon omits the field entirely; the screen must still open.
    const older = { ...wire } as Snapshot & { money?: MoneyView | null };
    delete older.money;
    expect(applySnapshot(emptyState(), older).money).toBeNull();
  });

  it('leads with cash, burn and runway once there is a book', () => {
    const html = bankView(withMoney(funded)).html;
    expect(html).toContain('USD 250.00');
    expect(html).toContain('USD 10.00');
    expect(html).toContain('25 days');
    expect(html).toContain('technology');
    expect(html).toContain('40 / 882');
    expect(html).toContain('Seed from savings');
  });

  it('falls back to the free-tier chart before the daemon has sent any money', () => {
    const html = bankView(withMoney(null)).html;
    expect(html).toContain('gemini-3.5-flash');
    expect(html).not.toContain('runway');
  });

  it('shows an unfunded company its zeroes, and never calls "not spending" a number', () => {
    // What a fresh install actually sends: the normal state of this system, not a problem (spec §5).
    const unfunded: MoneyView = { ...funded, cash_cents: 0, cash: 'USD 0.00', burn_cents_per_day: 0, burn: 'USD 0.00', runway_days: null, runway: 'not spending', budgets: [], entries: [] };
    const html = bankView(withMoney(unfunded)).html;
    expect(html).toContain('USD 0.00');
    expect(html).toContain('not spending');
    expect(html).not.toContain('dormant');
    expect(html).toContain('Nothing allocated yet');
    expect(html).toContain('Nothing in the ledger yet');
  });

  it('says the company is dormant, and how to start it again', () => {
    const html = bankView(withMoney({ ...funded, cash_cents: 0, cash: 'USD 0.00', dormant: true, runway_days: 0, runway: '0 days' })).html;
    expect(html).toContain('dormant');
    expect(html).toContain('capital');
    expect(html).toContain('Ledger/ledger.md');
  });

  it('marks a division that has spent its quota, and never calls simulated revenue cash', () => {
    const spent = bankView(withMoney({ ...funded, budgets: [{ division: 'technology', used: 900, quota: 882 }], mock_revenue_cents: 4000, mock_revenue: 'USD 40.00' })).html;
    expect(spent).toContain('cheapest tier');
    expect(spent).toContain('USD 40.00');
    expect(spent).toContain('not cash');
  });

  it('reports rows nobody can read rather than hiding them', () => {
    expect(bankView(withMoney({ ...funded, problems: 2 })).html).toContain('cannot be read');
  });

  it('the in-world chart draws the division quotas, and the model limits before there are any', () => {
    expect(chartBars(SURFACES.bank, withMoney(funded), 7)).toEqual([{ label: 'technology', used: 40, limit: 882 }, { label: 'house', used: 3, limit: 653 }]);
    expect(chartBars(SURFACES.bank, withMoney(null), 7)).toEqual([{ label: 'gemini-3.5-flash', used: 7, limit: 100 }]);
  });

  it('the headline on the wall is the cash, or the call count before there is any', () => {
    expect(SURFACES.bank.headline(withMoney(funded)).head).toBe('USD 250.00');
    expect(SURFACES.bank.headline(withMoney(funded)).lines.join(' ')).toContain('25 days');
    expect(SURFACES.bank.headline(withMoney(null)).head).toContain('calls today');
  });
});
