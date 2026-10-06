import { describe, expect, it } from 'vitest';
import { goalDay, goalMoved, goalsIn } from './goal.ts';

// Journey 14's brief, as the founder wrote it, and the partner's update two days on.
const BRIEF = '# Company brief\n\nStage and goals this quarter: one week in, solo founder. Goal this quarter: 10 paying practices.\n\n## Bets\n';
const today = '2026-10-08';

describe('the brief\'s dated goal', () => {
  it('reads the goal and its day, written out or as the end of a quarter or a month', () => {
    expect(goalsIn(BRIEF, today)).toEqual([{ what: '10 paying practices', by: '2026-12-31', said: 'this quarter', line: 'Stage and goals this quarter: one week in, solo founder. Goal this quarter: 10 paying practices.' }]);
    expect(goalsIn('- Goal: 10 paying practices by 3 November 2026. Kill signal: < 10.', today)[0]).toMatchObject({ what: '10 paying practices', by: '2026-11-03', said: '3 November 2026' });
    expect(goalDay('by end of October', today)).toEqual({ by: '2026-10-31', said: 'October' });
    expect(goalDay('this month', today)).toEqual({ by: '2026-10-31', said: 'this month' });
    expect(goalsIn('Goal: find the right customer.', today)).toEqual([]);
  });

  it('turns down a write that moves the goal\'s day unasked, and lets one through with the old day and a reason', () => {
    const moved = `${BRIEF}- Goal: 10 paying practices by 3 November 2026. Kill signal: < 10 paying practices on 3 November 2026.\n`;
    expect(goalMoved(BRIEF, moved, today)).toBe('the goal "10 paying practices" moves from this quarter to 3 November 2026. A goal\'s day is the founder\'s: keep "this quarter", or keep the old day on the same line as "(was this quarter)" with the reason the founder gave ("because …").');
    expect(goalMoved(BRIEF, `${BRIEF}- Goal: 10 paying practices by 3 November 2026 (was this quarter; moved because the founder wants the check before the cash runs low).\n`, today)).toBeNull();
    expect(goalMoved(BRIEF, `${BRIEF}- Goal: 10 paying practices this quarter.\n`, today)).toBeNull();
    expect(goalMoved(BRIEF, BRIEF.replace('## Bets', '## Bets\n\n- Open: 5 demos booked by 20 October 2026.'), today)).toBeNull();
  });
});
