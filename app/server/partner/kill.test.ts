import { describe, expect, it } from 'vitest';
import { killAskIn, killMovedLine, pastLine } from './kill.ts';

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
});
