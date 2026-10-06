import { describe, expect, it } from 'vitest';
import { economicsOf } from './economics.ts';
import { readRefresh, refreshAsk, refreshDue, refreshOpening, refreshText, type Held } from './refresh.ts';

const brief = (paying: number, price = 240) => `- Paying offices: ${paying}\n- Price: €${price} a month per office\n- Produce + delivery cost: €41 per box, about €178 a month per office\n- Cash: €12,000\n- Burn: €2,100 a month`;
const OLD: Held = {
  decision: 'keep going', why: 'Three offices pay and none has left.', signal: { what: 'Paying offices below 5', by: '2026-11-12' }, move: 'Call the two pilot offices.',
  at: new Date('2026-10-01T10:00').getTime(), day: '2026-10-01', roomId: 'sam', basis: economicsOf(brief(3))!.inputs,
};

describe('the partner refreshes its verdict unasked', () => {
  it('quotes the old call and what changed when the brief moved more than a tenth', () => {
    const now = economicsOf(brief(4))!;
    const due = refreshDue(OLD, now.inputs, '2026-10-04')!;
    expect(due).toEqual({ why: 'moved', moved: [{ field: 'paying', from: 3, to: 4 }] });
    const opening = refreshOpening(OLD, now, due.moved);
    expect(opening).toBe('On 1 Oct I said keep going at 3 paying offices; now 34 needed to break even and 4 paying offices. Since then: paying offices 3 to 4.');
    expect(refreshAsk(OLD, opening, now, '2026-10-04', due.why)).toContain('My call: **keep going**.');
    const reply = 'My call: change course\nWhy: break-even is 34 paying offices and we have 4.\nKill signal: paying offices below 8 by 2026-11-15\nThis week: raise the price to €320 for new offices.';
    const fresh = readRefresh({ text: reply }, '2026-10-04', brief(4), now)!;
    expect(fresh.signal).toEqual({ what: 'paying offices below 8', by: '2026-11-15' });
    const text = refreshText(opening, OLD.decision, fresh);
    expect(text).toMatch(/^On 1 Oct I said keep going at 3 paying offices; now 34 needed to break even and 4 paying offices: now change course\. Since then: paying offices 3 to 4\.\n\nMy call: \*\*change course\*\*\./);
    expect(text).toContain('Kill signal: paying offices below 8 by 2026-11-15.');
    expect(refreshText(opening, OLD.decision, { ...fresh, decision: 'keep going' })).toContain('4 paying offices: still keep going. Since then');
  });

  it('says nothing while the numbers hold and the week is not out, and looks again on day eight', () => {
    expect(refreshDue(OLD, economicsOf(brief(3))!.inputs, '2026-10-05')).toBeNull();
    // A move under a tenth is no move: €240 to €250.
    expect(refreshDue(OLD, economicsOf(brief(3, 250))!.inputs, '2026-10-05')).toBeNull();
    expect(refreshDue(OLD, economicsOf(brief(3))!.inputs, '2026-10-08')).toEqual({ why: 'week', moved: [] });
    expect(refreshOpening(OLD, economicsOf(brief(3)), [])).toBe('On 1 Oct I said keep going at 3 paying offices; now 34 needed to break even and 3 paying offices.');
    // No call, or a reply with no call in it: nothing to refresh, nothing said.
    expect(refreshDue(undefined, undefined, '2026-10-20')).toBeNull();
    expect(readRefresh({ text: 'Good morning! Lots going on.' }, '2026-10-08', '', null)).toBeNull();
  });
});
