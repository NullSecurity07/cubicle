import { describe, expect, it } from 'vitest';
import { stateOf } from './economics.ts';
import { holdStop, readRefresh, refreshAsk, refreshDue, refreshOpening, refreshText, slipOn, snapshotOfBasis, staleOf, type Held } from './refresh.ts';

const brief = (paying: number, price = 240) => `- Paying offices: ${paying}\n- Price: €${price} a month per office\n- Produce + delivery cost: €41 per box, about €178 a month per office\n- Cash: €12,000\n- Burn: €2,100 a month`;
const OLD: Held = {
  decision: 'keep going', why: 'Three offices pay and none has left.', signal: { what: 'Paying offices below 5', by: '2026-11-12' }, move: 'Call the two pilot offices.',
  at: new Date('2026-10-01T10:00').getTime(), day: '2026-10-01', roomId: 'sam', snapshot: stateOf(brief(3)).snapshot(),
};

describe('the partner refreshes its verdict unasked', () => {
  it('quotes the old call and every input that changed since', () => {
    const now = stateOf(brief(4));
    const due = refreshDue(OLD, now, '2026-10-04')!;
    expect(due.why).toBe('moved');
    expect(due.changed.map((one) => [one.field, one.from?.value, one.to?.value])).toEqual([['paying', 3, 4]]);
    const opening = refreshOpening(OLD, now, due.changed);
    expect(opening).toBe('On 1 Oct I said keep going at 3 paying offices; now break-even is 34 paying offices and the company has 4. Since then: paying offices 3 → 4.');
    expect(refreshAsk(OLD, opening, now.economics(), '2026-10-04', due.why)).toContain('My call: **keep going**.');
    const reply = 'My call: change course\nWhy: break-even is 34 paying offices and we have 4.\nKill signal: paying offices below 8 by 2026-11-15\nThis week: raise the price to €320 for new offices.';
    const fresh = readRefresh({ text: reply }, '2026-10-04', brief(4), now.economics())!;
    expect(fresh.signal).toEqual({ what: 'paying offices below 8', by: '2026-11-15' });
    const text = refreshText(opening, OLD.decision, fresh);
    expect(text).toMatch(/^On 1 Oct I said keep going at 3 paying offices; now break-even is 34 paying offices and the company has 4: now change course\. Since then: paying offices 3 → 4\.\n\nMy call: \*\*change course\*\*\./);
    expect(refreshText(opening, OLD.decision, { ...fresh, decision: 'keep going' })).toContain('the company has 4: still keep going. Since then');
  });

  it('is stale on any input change, says nothing while nothing changed and the week is not out, and looks again on day eight', () => {
    expect(refreshDue(OLD, stateOf(brief(3)), '2026-10-05')).toBeNull();
    // Any change is a change now: €240 to €250 makes the call stale.
    expect(refreshDue(OLD, stateOf(brief(3, 250)), '2026-10-05')?.why).toBe('moved');
    expect(refreshDue(OLD, stateOf(brief(3)), '2026-10-08')).toEqual({ why: 'week', changed: [] });
    expect(refreshDue(undefined, null, '2026-10-20')).toBeNull();
    expect(readRefresh({ text: 'Good morning! Lots going on.' }, '2026-10-08', '', null)).toBeNull();
    // A call kept before the snapshot is read by its monthly figures.
    const older: Held = { ...OLD, snapshot: undefined, basis: { price: 240, cost: 178, fixed: 2100, cash: 12000, paying: 3 } };
    expect(snapshotOfBasis(older.basis!)).toMatchObject({ price: { value: 240, period: 'month' }, paying: { value: 3 } });
    expect(staleOf(older, stateOf(brief(3)))).toEqual([]);
    expect(staleOf(older, stateOf(brief(5))).map((one) => one.field)).toEqual(['paying']);
  });
});

describe('the refresh on the brief\'s goal', () => {
  const goal = { what: '10 paying practices', by: '2026-10-20', said: '20 October 2026', line: 'Goal: 10 paying practices by 20 October 2026.' };
  const call: Held = { ...OLD, day: '2026-10-15', snapshot: undefined };
  it('comes once the goal\'s day passed after the call', () => {
    expect(refreshDue(call, null, '2026-10-20', { goal })).toBeNull();
    expect(refreshDue(call, null, '2026-10-21', { goal })).toMatchObject({ why: 'goal', goal });
    expect(refreshDue({ ...call, day: '2026-10-21' }, null, '2026-10-22', { goal })).toBeNull();
    expect(slipOn(goal, ['Moved: Paying practices went from 3 to 2 (worse).'])).toBe('Moved: Paying practices went from 3 to 2 (worse).');
    const ask = refreshAsk(call, 'On 6 Oct I said keep going.', null, '2026-10-21', { why: 'goal', goal });
    expect(ask).toContain('The Company brief\'s goal, 10 paying practices by 20 October 2026 (2026-10-20), has passed its day.');
    expect(ask).toContain('Never move the goal\'s day yourself');
  });
});

// Journey 16: ShiftMeals, €59 per week per subscriber, 14 subscribers of whom 11 pay, €6,000 cash, €1,900 burn. The
// stored call kept 14 paying and a monthly price; the next morning said "stop, assess winding down", and after a 15%
// price rise "plan an orderly wind-down", for a company that takes in €912 a month more than it spends.
describe('journey 16: the refresh of a cash-positive company', () => {
  const SHIFTMEALS = (price = '59') => `- Price: €${price} per week per subscriber\n- Subscribers: 14\n- Paying subscribers: 11\n- Cash: €6,000\n- Burn: €1,900 a month\n- Nurses contacted: 120`;
  const day1: Held = { decision: 'keep going', why: 'Break-even is 8 and 11 pay.', signal: { what: 'Paying subscribers below 8', by: '2026-10-17' }, move: 'Ask the 3 who do not pay why.', at: 0, day: '2026-10-06', roomId: 'sam', snapshot: stateOf(SHIFTMEALS()).snapshot() };

  it('makes no refresh the next morning when no input changed', () => {
    expect(refreshDue(day1, stateOf(SHIFTMEALS()), '2026-10-07')).toBeNull();
  });

  it('after a 15% price rise quotes the old call and the price, and may not reach stop or a wind-down', () => {
    const now = stateOf(SHIFTMEALS('67.85'));
    const due = refreshDue(day1, now, '2026-10-08')!;
    const opening = refreshOpening(day1, now, due.changed);
    expect(opening).toBe('On 6 Oct I said keep going at 11 paying subscribers; now break-even is 7 paying subscribers and the company has 11, cash-positive. Since then: price €59 a week → €67.85 a week.');
    const model = { decision: 'stop' as const, why: 'The gap cannot close.', signal: { what: 'Paying subscribers below 11', by: '2026-10-17' }, move: 'Pause operations and plan an orderly wind-down' };
    const held = holdStop(model, now, ['should we keep going, pivot or stop?'], day1.decision);
    expect(held.call.decision).toBe('keep going');
    expect(held.call.move).toBeUndefined();
    expect(held.note).toBe('*Not a stop: the company is cash-positive (€3,234.18 a month comes in against €1,900 of burn), so stopping or winding down is yours to raise, not mine. The move "Pause operations and plan an orderly wind-down" was dropped.*');
    expect(refreshText(opening, day1.decision, held.call)).not.toMatch(/wind|stop\b/i);
    // The founder's own words may ask for it.
    expect(holdStop(model, now, ['I want to wind it down, honestly.'], day1.decision).call.decision).toBe('stop');
    // A company with three months left is not held.
    expect(holdStop(model, stateOf('- Cash: €3,000\n- Burn: €1,000 a month'), [], 'keep going').call.decision).toBe('stop');
  });

  it('is stale once the founder corrects an input, and quotes their words', () => {
    const monthly = '- Price: €59 per subscriber\n- Subscribers: 14\n- Paying subscribers: 14\n- Cash: €6,000\n- Burn: €1,900 a month';
    const call: Held = { ...day1, snapshot: stateOf(monthly).snapshot() };
    const fixed = stateOf(monthly, { fixes: [
      { field: 'paying', value: 11, said: 'No, 14 subscribers is not 14 paying, 11 pay', day: '2026-10-06', over: { value: 14 } },
      { field: 'price', period: 'week', said: '€59 is per week, not per month', day: '2026-10-06', over: { value: 59 } },
    ] });
    const due = refreshDue(call, fixed, '2026-10-07')!;
    expect(refreshOpening(call, fixed, due.changed)).toBe('On 6 Oct I said keep going at 14 paying subscribers; now break-even is 8 paying subscribers and the company has 11, cash-positive. Since then: price €59 a month → €59 a week (founder: "€59 is per week, not per month"); paying subscribers 14 → 11 (founder: "No, 14 subscribers is not 14 paying, 11 pay").');
  });
});
