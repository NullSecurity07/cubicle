import { describe, expect, it } from 'vitest';
import {
  addMonths, alertLevel, amountIn, cleanRunway, daysBetween, MONTH_DAYS, monthsBetween, parseAmount, planOf, project, readBank, runwayCsv,
  runwayDetail, runwayLine, type Flow, type Runway,
} from './runway';

const flow = (id: string, monthly: number, from: string, extra: Partial<Flow> = {}): Flow => ({ id, label: id, monthly, from, ...extra });
// 120,000 in the bank on the first of September, 10,000 out and 2,000 in a month: 8,000 net, fifteen months exactly.
const simple: Runway = { cash: { amount: 120_000, asOf: '2026-09-01' }, flows: [flow('costs', -10_000, '2026-09', { category: 'people' }), flow('sales', 2_000, '2026-09')], scenarios: [] };

describe('months', () => {
  it('adds and counts months across years', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthsBetween('2026-09', '2027-11')).toBe(14);
    expect(daysBetween('2026-09-01', '2027-12-01')).toBe(456);
  });
});

describe('amountIn', () => {
  it('counts a flow only inside its months, both ends included', () => {
    const rent = flow('rent', -1000, '2026-01', { to: '2026-03' });
    expect(amountIn(rent, '2025-12', '2026-01')).toBe(0);
    expect(amountIn(rent, '2026-03', '2026-01')).toBe(-1000);
    expect(amountIn(rent, '2026-04', '2026-01')).toBe(0);
  });
  it('compounds growth from the later of the start and the cash month, not twice', () => {
    const sales = flow('sales', 1000, '2025-06', { grows: 10 });
    expect(amountIn(sales, '2026-01', '2026-01')).toBe(1000);
    expect(amountIn(sales, '2026-03', '2026-01')).toBeCloseTo(1210, 6);
    const later = flow('later', 1000, '2026-04', { grows: 10 });
    expect(amountIn(later, '2026-05', '2026-01')).toBeCloseTo(1100, 6);
  });
});

describe('project', () => {
  it('runs out on the day the last of the cash is spent', () => {
    const base = project(simple, undefined, '2026-09-01');
    expect(base).toMatchObject({ burn: 10_000, revenue: 2_000, net: 8_000, zero: '2027-12-01', start: '2026-09' });
    expect(base.byCategory).toEqual({ people: 10_000, revenue: 2_000 });
    expect(base.monthsLeft).toBeCloseTo(456 / MONTH_DAYS, 6);
    expect(base.series).toHaveLength(24);
    expect(base.series[0]).toEqual({ month: '2026-09', cash: 112_000 });
    expect(base.series[23]).toEqual({ month: '2028-08', cash: -72_000 });
  });

  it('counts months left from today, not from the day cash was counted', () => {
    const base = project(simple, undefined, '2026-09-25');
    expect(base.monthsLeft).toBeCloseTo(432 / MONTH_DAYS, 6);
  });

  it('spreads a month evenly: a zero part-way through lands on the right day', () => {
    // 10,000 with 5,000 out and 1,000 in growing 10%: -4,000, -3,900, then 2,100 of March's 3,790 lasts 17.18 of 31 days.
    const growing: Runway = { cash: { amount: 10_000, asOf: '2026-01-01' }, flows: [flow('out', -5000, '2026-01'), flow('in', 1000, '2026-01', { grows: 10 })], scenarios: [] };
    const result = project(growing, undefined, '2026-01-01');
    expect(result.series.slice(0, 2).map((point) => Math.round(point.cash))).toEqual([6000, 2100]);
    expect(result.zero).toBe('2026-03-18');
    expect(result.growth).toBe(10);
  });

  it('counts only the rest of the first month when cash was counted part-way through it', () => {
    // 16 September: 15 of 30 days left, so September costs 2,000 of its 4,000.
    const late: Runway = { cash: { amount: 10_000, asOf: '2026-09-16' }, flows: [flow('out', -4000, '2026-01')], scenarios: [] };
    const result = project(late, undefined, '2026-09-16');
    expect(result.series[0].cash).toBe(8000);
    expect(result.zero).toBe('2026-12-01');
  });

  it('says nothing runs out when more comes in than goes out', () => {
    const fine: Runway = { cash: { amount: 5000, asOf: '2026-09-01' }, flows: [flow('in', 3000, '2026-09'), flow('out', -2000, '2026-09')], scenarios: [] };
    expect(project(fine, undefined, '2026-09-01')).toMatchObject({ zero: null, monthsLeft: null });
  });

  it('lays a scenario over Base: a dropped flow, and a one-off raise', () => {
    const plans: Runway = { ...simple, scenarios: [
      { id: 'lost', name: 'Lose the customer', changes: [{ drop: 'sales' }] },
      { id: 'raise', name: 'Raise in October', changes: [{ cash: 80_000, at: '2026-10' }] },
      { id: 'hire', name: 'Hire', changes: [{ add: flow('eng', -4000, '2027-01', { category: 'people' }) }] },
    ] };
    expect(project(plans, 'lost', '2026-09-01').zero).toBe('2027-09-01');
    // 200,000 at 8,000 a month is 25 months: past the 24 drawn, still found.
    const raised = project(plans, 'raise', '2026-09-01');
    expect(raised.zero).toBe('2028-10-01');
    expect(raised.series).toHaveLength(24);
    expect(raised.series[1].cash).toBe(184_000);
    expect(planOf(plans, 'hire').flows.map((one) => one.id)).toEqual(['costs', 'sales', 'eng']);
    // An unknown scenario is Base.
    expect(project(plans, 'nope', '2026-09-01').zero).toBe('2027-12-01');
  });
});

describe('alertLevel', () => {
  it('is red under three months, amber under six', () => {
    expect([alertLevel(2.9), alertLevel(5.9), alertLevel(6), alertLevel(null)]).toEqual([3, 6, null, null]);
  });
});

describe('what a person reads', () => {
  const research: Runway = {
    cash: { amount: 182_000, asOf: '2026-09-01' },
    flows: [flow('Team', -11_000, '2026-01', { category: 'people' }), flow('Tools', -1300, '2026-01', { category: 'tools' }), flow('Office', -2000, '2026-01', { category: 'rent' }), flow('Revenue', 3100, '2026-01', { grows: 2 })],
    scenarios: [{ id: 'hire', name: 'Hire in January', changes: [{ add: flow('Engineer', -9000, '2027-01', { category: 'people' }) }] }],
  };
  it('is one compact line, ending with the day it is true on', () => {
    const line = runwayLine(research, '2026-09-25');
    expect(line).toContain('Cash $182,000 on 2026-09-01. Burn $14,300 a month (people $11,000, tools $1,300, rent $2,000). Revenue $3,100 a month growing 2%.');
    expect(line).toMatch(/months left, cash out \d{4}-\d{2}\. Scenario "Hire in January": \d+\.\d months left/);
    expect(line.endsWith('As of 2026-09-25.')).toBe(true);
    expect(line.split('\n')).toHaveLength(1);
  });
  it('says so when growth outruns the burn', () => {
    const growing = { ...research, flows: research.flows.map((one) => (one.id === 'Revenue' ? { ...one, grows: 8 } : one)), scenarios: [] };
    expect(runwayLine(growing, '2026-09-25')).toContain('Cash does not run out within ten years.');
  });
  it('says when the card is still empty', () => {
    expect(runwayLine({ cash: { amount: 0, asOf: '2026-09-25' }, flows: [], scenarios: [] }, '2026-09-25')).toContain('still empty');
  });
  it('reads one plan in detail', () => {
    const detail = runwayDetail(research, 'hire', '2026-09-25');
    expect(detail).toContain('Scenario "Hire in January"');
    expect(detail).toContain('- Engineer: -$9,000 a month from 2027-01 (people)');
    expect(detail).toContain('Other plans: Base.');
  });
});

describe('cleanRunway', () => {
  it('keeps what is sound and refuses what is not', () => {
    const clean = cleanRunway({ cash: { amount: '5000', asOf: 'soon' }, flows: [{ label: ' Rent ', monthly: '-1500', from: 'bad' }], scenarios: [] }, '2026-09-25');
    expect(clean.cash).toEqual({ amount: 5000, asOf: '2026-09-25' });
    expect(clean.flows[0]).toMatchObject({ label: 'Rent', monthly: -1500, from: '2026-09' });
    expect(() => cleanRunway({ flows: [{ label: 'x', monthly: 'lots' }] }, '2026-09-25')).toThrow(/monthly amount/);
    expect(() => cleanRunway({ flows: [{ label: 'x', monthly: 1, from: '2026-09', to: '2026-01' }] }, '2026-09-25')).toThrow(/ends before/);
    expect(() => cleanRunway({ scenarios: [1, 2, 3, 4].map((n) => ({ name: `s${n}` })) }, '2026-09-25')).toThrow(/at most 3/);
  });
  it('drops a scenario change that names a flow that is not in Base', () => {
    const clean = cleanRunway({ flows: [{ id: 'a', label: 'A', monthly: -1, from: '2026-09' }], scenarios: [{ name: 'S', changes: [{ drop: 'a' }, { drop: 'ghost' }] }] }, '2026-09-25');
    expect(clean.scenarios[0].changes).toEqual([{ drop: 'a' }]);
  });
});

describe('runwayCsv', () => {
  it('is one row a month: each flow, the net, and each plan\'s cash', () => {
    const csv = runwayCsv({ ...simple, scenarios: [{ id: 'lost', name: 'Lose the customer', changes: [{ drop: 'sales' }] }] }, '2026-09-01').trim().split('\n');
    expect(csv[0]).toBe('month,costs,sales,net (Base),cash at month end (Base),cash at month end (Lose the customer)');
    expect(csv[1]).toBe('2026-09,-10000,2000,-8000,112000,110000');
    expect(csv).toHaveLength(25);
  });
});

describe('readBank', () => {
  it('reads amounts the way banks write them', () => {
    expect([parseAmount('1,234.56'), parseAmount('-1.234,56'), parseAmount('(120.00)'), parseAmount('$45'), parseAmount('12,50')]).toEqual([1234.56, -1234.56, -120, 45, 12.5]);
  });
  it('groups a statement into candidate flows by payee, a month\'s worth each', () => {
    const csv = ['Date,Description,Amount',
      ...['06', '07', '08'].flatMap((month) => [`2026-${month}-01,AWS EMEA ${month}123,-120.00`, `2026-${month}-28,GUSTO PAYROLL ${month}/28,"-8,000.00"`]),
      '2026-06-15,Stripe transfer,1500', '2026-07-15,Stripe transfer,1700', '2026-08-15,Stripe transfer,1800', '2026-07-03,Corner coffee,-6.00', 'bad row,,'].join('\n');
    const read = readBank(csv);
    expect(read).toMatchObject({ rows: 10, skipped: 1, months: 3 });
    expect(read.candidates.map((one) => [one.monthly, one.category, one.months])).toEqual([[-8000, 'people', 3], [1667, 'revenue', 3], [-120, 'tools', 3], [-2, 'other', 1]]);
  });
  it('reads a European export: semicolons, decimal commas, day-first dates, debit and credit columns', () => {
    const csv = 'Datum;Text;Debit amount;Credit amount\n01.06.2026;Miete Juni;1.200,00;\n01.07.2026;Miete Juli;1.200,00;\n03.07.2026;Kunde AG;;500,00';
    const read = readBank(csv);
    expect(read.months).toBe(2);
    expect(read.candidates.find((one) => one.label.startsWith('Miete'))).toMatchObject({ monthly: -1200, count: 2 });
    expect(read.candidates.find((one) => one.label === 'Kunde AG')).toMatchObject({ monthly: 250, category: 'revenue' });
  });
});

describe('readMonth', () => {
  it('reads a month the way a founder types one', async () => {
    const { readMonth } = await import('./runway');
    expect(['2027-01', '2027-1', '1/2027', '01.2027', 'Jan 2027', 'january 2027', 'Sept 2026', 'Sep. 2026'].map(readMonth)).toEqual(['2027-01', '2027-01', '2027-01', '2027-01', '2027-01', '2027-01', '2026-09', '2026-09']);
    expect(['2027-13', 'soon', 'Janu 2027', ''].map(readMonth)).toEqual([null, null, null, null]);
  });
});
