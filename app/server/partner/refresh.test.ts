import { describe, expect, it } from 'vitest';
import { economicsOf } from './economics.ts';
import { readRefresh, refreshAsk, refreshDue, refreshOpening, refreshText, slipOn, type Held } from './refresh.ts';

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

describe('the refresh on the brief\'s goal', () => {
  const goal = { what: '10 paying practices', by: '2026-10-20', said: '20 October 2026', line: 'Goal: 10 paying practices by 20 October 2026.' };
  const call: Held = { ...OLD, day: '2026-10-15', basis: undefined };
  it('comes once the goal\'s day passed after the call, and once for a slip on it', () => {
    expect(refreshDue(call, undefined, '2026-10-20', { goal })).toBeNull();
    expect(refreshDue(call, undefined, '2026-10-21', { goal })).toMatchObject({ why: 'goal', goal });
    // Made again after the day: the passed goal does not bring it up again.
    expect(refreshDue({ ...call, day: '2026-10-21' }, undefined, '2026-10-22', { goal })).toBeNull();
    const slip = slipOn(goal, ['Late on the board: logo (due 2026-10-06, 1 day late).', 'Slipped: you said you would call 5 practices (due 2026-10-06), now 1 day late.']);
    expect(slip).toBe('Slipped: you said you would call 5 practices (due 2026-10-06), now 1 day late.');
    expect(slipOn(goal, ['Moved: Paying practices went from 3 to 2 (worse).'])).toBe('Moved: Paying practices went from 3 to 2 (worse).');
    expect(slipOn(goal, ['Late on the board: logo (due 2026-10-06, 1 day late).'])).toBeUndefined();
    expect(refreshDue(call, undefined, '2026-10-16', { goal, slip })).toMatchObject({ why: 'slip', slip });
    const ask = refreshAsk(call, 'On 6 Oct I said keep going.', null, '2026-10-21', { why: 'goal', goal });
    expect(ask).toContain('The Company brief\'s goal, 10 paying practices by 20 October 2026 (2026-10-20), has passed its day.');
    expect(ask).toContain('Never move the goal\'s day yourself');
  });
});
