import { describe, expect, it } from 'vitest';
import { asksRecall, callRecord, holdFirstLine, logCall } from './calllog.ts';

// Journey 21: "Kill line set then: Paying cafés below 4" when day one's line was "below 6".
describe('the record of calls', () => {
  const day1 = { day: '2026-10-09', at: 1, decision: 'keep going' as const, signal: { what: 'Paying cafés below 6', by: '2026-10-23' } };
  const day2 = { day: '2026-10-10', at: 2, decision: 'keep going' as const, signal: { what: 'Paying cafés below 4', by: '2026-10-23' } };
  it('keeps each new call or line once, in order', () => {
    const log = logCall(logCall(logCall([], day1), { ...day1, at: 5 }), day2);
    expect(log.map((one) => one.signal?.what)).toEqual(['Paying cafés below 6', 'Paying cafés below 4']);
    expect(callRecord(log)).toContain('- 2026-10-09: call "keep going", kill line "Paying cafés below 6" by 2026-10-23');
  });
  it('puts day one\'s own line in a recall, and leaves the line now alone', () => {
    const log = logCall(logCall([], day1), day2);
    expect(asksRecall('Exact recall: what was your day-one call and the kill line you set then?')).toBe(true);
    expect(holdFirstLine('Day-one call: keep going. Kill line set then: Paying cafés below 4. The line now: Paying cafés below 4.', log))
      .toBe('Day-one call: keep going. Kill line set then: Paying cafés below 6. The line now: Paying cafés below 4.');
  });
});
