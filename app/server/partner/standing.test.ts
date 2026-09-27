import { describe, expect, it } from 'vitest';
import type { Attention } from '../../shared/model.ts';
import { STANDING_HEAD, STANDING_MOST, standingBlock, waitingLine, type StandingParts } from './standing.ts';

const item = (kind: Attention['kind'], title: string): Attention => ({ id: `${kind}:${title}`, kind, title, at: 1 });
const parts = (extra: Partial<StandingParts> = {}): StandingParts => ({ verdicts: [], numbers: '', open: [], planned: [], flagCounts: [], decided: [], ...extra });

describe('the standing facts', () => {
  it('says what waits in Needs you by kind and count, never the morning note, and says so when nothing does', () => {
    expect(waitingLine([])).toBe('Waiting in Needs you: nothing. Never tell the founder something waits there.');
    expect(waitingLine([item('morning-note', 'Morning note: call three users')])).toBe('Waiting in Needs you: nothing. Never tell the founder something waits there.');
    expect(waitingLine([item('proposed-task', 'Build the form'), item('proposed-task', 'PDF invoice'), item('proposed-task', 'Numbering'), item('proposed-decision', 'Price')]))
      .toBe('Waiting in Needs you: 3 tasks to accept ("Build the form", "PDF invoice", …); 1 decision to make ("Price"). Nothing else waits there: anything the founder already answered is done.');
  });

  it('puts the verdict and what waits first, keeps whole lines, and never runs past its cap', () => {
    const long = Array.from({ length: 40 }, (_, index) => `- 2026-09-${String(index % 28 + 1).padStart(2, '0')} Decision number ${index}: ${'x'.repeat(80)}`);
    const block = standingBlock(parts({ verdicts: ['- Evaluation, 6. Verdict: WEAK, score 5/10. Talk to users first.'], decided: long, numbers: '- Cash: €4,200\n- Burn: €1,100/month' }), [item('proposed-bet', 'Five paying users')]);
    expect(block.length).toBeLessThanOrEqual(STANDING_MOST);
    const lines = block.split('\n');
    expect(lines.slice(0, 4)).toEqual([STANDING_HEAD, 'Team verdicts:', '- Evaluation, 6. Verdict: WEAK, score 5/10. Talk to users first.', expect.stringMatching(/^Waiting in Needs you: 1 bet to take or leave/)]);
    expect(lines).toContain('- Cash: €4,200');
    expect(lines.at(-1)).toMatch(/^- 2026-09-\d\d Decision number \d+: x+$/);
  });

  it('says the Company numbers are not written yet, and counts the truth net\'s flags by room', () => {
    const block = standingBlock(parts({ flagCounts: [{ room: 'Meera (Market)', count: 2 }] }), []);
    expect(block).toContain('Company Numbers:\n- none written yet');
    expect(block).toContain('Truth net since yesterday: Meera (Market) had 2 flagged lines. Never repeat a flagged figure as a fact.');
  });
});
