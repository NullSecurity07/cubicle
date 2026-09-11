import { describe, it, expect } from 'vitest';
import { allocateQuota, HOUSE, MIN_DIVISION_CALLS, HOUSE_RESERVE_PCT } from '../src/money.js';

/** The shipped tower: three divisions of very different sizes, plus the house. */
const TOWER = [
  { id: 'technology', people: 14 },
  { id: 'revenue', people: 8 },
  { id: 'operations', people: 8 },
];

const total = (a: Record<string, number>) => Object.values(a).reduce((t, n) => t + n, 0);

describe('the CFO allocates the day (spec §4)', () => {
  it('always sums to exactly the capacity, at every size', () => {
    for (const cap of [0, 1, 3, 59, 60, 61, 100, 2610, 15461]) {
      expect(total(allocateQuota(cap, TOWER)), `capacity ${cap}`).toBe(cap);
    }
  });

  it('reserves the house first, then splits the rest by headcount', () => {
    const a = allocateQuota(2610, TOWER);
    expect(HOUSE_RESERVE_PCT).toBe(0.25);
    const pool = 2610 - Math.ceil(2610 * 0.25);
    expect(a.technology + a.revenue + a.operations).toBe(pool);
    expect(a[HOUSE]).toBe(2610 - pool);
    expect(a.technology).toBeGreaterThan(a.revenue);      // 14 people beats 8
    expect(a.revenue).toBe(a.operations);                  // same headcount, same quota
  });

  it('gives every division a floor, even one nobody works in', () => {
    const a = allocateQuota(2610, [...TOWER, { id: 'skunkworks', people: 0 }]);
    expect(MIN_DIVISION_CALLS).toBe(20);
    expect(a.skunkworks).toBe(MIN_DIVISION_CALLS);
    expect(total(a)).toBe(2610);
  });

  it('drops the floor rather than starving a division when the day is tiny, and never goes negative', () => {
    const small = allocateQuota(60, TOWER);                // pool 45 < 20 × 3, so the floor becomes 1
    expect(Math.min(small.technology, small.revenue, small.operations)).toBeGreaterThanOrEqual(1);
    expect(total(small)).toBe(60);
    const tiny = allocateQuota(3, TOWER);                  // pool 2 < 1 × 3: the house keeps it, nobody is budgeted
    expect(tiny).toEqual({ [HOUSE]: 3, technology: 0, revenue: 0, operations: 0 });
    expect(allocateQuota(0, TOWER)).toEqual({ [HOUSE]: 0, technology: 0, revenue: 0, operations: 0 });
    expect(allocateQuota(-5, TOWER)[HOUSE]).toBe(0);
  });

  it('an org with no divisions gives everything to the house', () => {
    expect(allocateQuota(500, [])).toEqual({ [HOUSE]: 500 });
  });

  it('is deterministic: the same input twice is the same answer', () => {
    const a = allocateQuota(2610, TOWER);
    const b = allocateQuota(2610, [...TOWER].reverse());
    expect(b).toEqual(a);
  });

  it('a division that is budgeted at all gets a positive number', () => {
    const a = allocateQuota(2610, TOWER);
    // A quota of 0 means "unbudgeted", never "stopped": that distinction is `budgetedTier`'s (Task 5), and it
    // needs a positive quota to demote on.
    for (const d of TOWER) expect(a[d.id]).toBeGreaterThan(0);
  });
});
