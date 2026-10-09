import { describe, expect, it } from 'vitest';
import { crossedRefusal, killAskIn, killMovedLine, killStandLine, pastLine } from './kill.ts';
import { sameMetric, stateOf } from './economics.ts';
import { killToward } from './watch.ts';

// Journey 16: the founder's "replace the kill signal" got a CSV-header ask, then a bet of 15; the refresh moved the line
// to 11 with the reading at 9.5 and said nothing.
describe('the founder moves the kill signal, in code', () => {
  const given = { today: '2026-10-07', labels: ['Price', 'Subscribers', 'Paying subscribers', 'Cash', 'Burn'], signal: { what: 'Paying subscribers drop below 8', by: '2026-10-17' } };
  it('reads journey 16\'s ask, "<9 paying" and "make it 9"', () => {
    expect(killAskIn('Sam, tighten the kill signal: fewer than 9 paying subscribers by 2026-10-17. Replace the old one.', given)).toEqual({ signal: { what: 'Paying subscribers below 9', by: '2026-10-17' }, metric: 'Paying subscribers', line: 9, below: true });
    expect(killAskIn('replace the kill with <9 paying', given)!.signal).toEqual({ what: 'Paying subscribers below 9', by: '2026-10-17' });
    expect(killAskIn('make it 9', { ...given, lastSaid: 'Kill signal: Paying subscribers drop below 8 by 2026-10-17.' })!.signal.what).toBe('Paying subscribers below 9');
    // Not an ask to move it: a question, a verdict ask, "make it 9" with no kill signal in the last words.
    expect(killAskIn('what is the kill signal now?', given)).toBeNull();
    expect(killAskIn('Give me your verdict with a kill signal I can check.', given)).toBeNull();
    expect(killAskIn('make it 9', { ...given, lastSaid: 'Sure, the deck is ready.' })).toBeNull();
  });

  it('says old → new, and raises a reading already past the new line', () => {
    const fresh = { what: 'Paying subscribers below 11', by: '2026-10-17' };
    expect(pastLine(9.5, 11, true)).toBe(true);
    expect(killMovedLine(given.signal, fresh, { value: 9.5, said: 'Paying subscribers is 9.5 (Metrics, 2026-10-07)' }))
      .toBe('Kill signal moved: "Paying subscribers drop below 8" by 2026-10-17 → "Paying subscribers below 11" by 2026-10-17. Paying subscribers is 9.5 (Metrics, 2026-10-07): already past the new line, so the check is in Needs you now.');
    expect(killMovedLine(given.signal, { what: 'Paying subscribers below 9', by: '2026-10-17' }, { value: 9.5, said: 'x' })).toMatch(/It is the check in Needs you on 2026-10-17\.$/);
  });

  it('takes a line at today\'s value and says one lost customer trips it', () => {
    const at = { value: 11, said: 'Paying subscribers is 11 (Company brief)' };
    expect(killMovedLine(undefined, { what: 'paying subscribers below 11', by: '2026-10-17' }, at)).toBe('Kill signal set: "paying subscribers below 11" by 2026-10-17. It is the check in Needs you on 2026-10-17. Paying subscribers is 11 (Company brief), right on the line: losing one trips it.');
    expect(killMovedLine(undefined, { what: 'paying subscribers below 9', by: '2026-10-17' }, at)).toBe('Kill signal set: "paying subscribers below 9" by 2026-10-17. It is the check in Needs you on 2026-10-17.');
  });
});

// Journey 20: "below 7" was taken with 6 paying cafés, since the paying count the state held was the 310 bookings;
// recall said "9, above the line of 7" with 6 that day; "8" on "below 8" was raised as crossed.
describe('the kill line against the paying cafés (journey 20)', () => {
  const FIXSLOT = '- Price: €4 per booking\n- Bookings last month: 310\n- Paying cafés: 6 at €39 a month\n- Cash: €5,400\n- Burn: €1,300 a month';
  const paying = stateOf(FIXSLOT).inputs.paying!;
  const reading = { value: paying.value, said: `${paying.label} is ${paying.value} (Company brief)` };
  it('the state\'s paying count is the cafés, so "below 7" with 6 is refused as crossed', () => {
    expect(sameMetric(paying.label, 'Paying cafés')).toBe(true);
    expect(paying.value).toBe(6);
    expect(crossedRefusal({ what: 'Paying cafés below 7', by: '2026-11-08' }, reading)).toMatch(/^Not set: "Paying cafés below 7" is crossed already \(Paying cafés is 6/);
  });
  it('a line at today\'s number is on the line, not crossed', () => {
    const eight = { value: 8, said: 'Paying cafés is 8 (Metrics, 2026-10-12)' };
    expect(crossedRefusal({ what: 'Paying cafés below 8', by: '2026-11-08' }, eight)).toBeNull();
    expect(killStandLine({ what: 'Paying cafés below 8', by: '2026-11-08' }, eight)).toContain('right on the line, not past it');
    expect(killToward(9, 8, 8, true)).toMatchObject({ crossed: false, share: 1 });
    expect(killToward(9, 7, 8, true)).toMatchObject({ crossed: true });
  });
  it('every turn carries today\'s reading against the line', () => {
    expect(killStandLine({ what: 'Paying cafés below 7', by: '2026-11-08' }, { value: 6, said: 'Paying cafés is 6 (Metrics, 2026-10-12)' }))
      .toBe('Kill line now: "Paying cafés below 7" by 2026-11-08. Today\'s number against it: Paying cafés is 6 (Metrics, 2026-10-12), past the line: the kill line is crossed. Quote this reading, never an older one.');
  });
});
