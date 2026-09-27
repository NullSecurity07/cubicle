import { describe, expect, it } from 'vitest';
import type { Attention } from '../../shared/model.ts';
import type { Stage } from '../../shared/model.ts';
import { NOTHING_WAITING, staleNeeds, STANDING_HEAD, STANDING_MOST, standingBlock, teamVerdict, waitingLine, type StandingParts } from './standing.ts';

const item = (kind: Attention['kind'], title: string): Attention => ({ id: `${kind}:${title}`, kind, title, at: 1 });
const parts = (extra: Partial<StandingParts> = {}): StandingParts => ({ verdicts: [], numbers: '', open: [], planned: [], flagCounts: [], decided: [], learned: [], ...extra });

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

  it('carries what the closed bets taught, one line each', () => {
    const block = standingBlock(parts({ learned: ['- 2026-10-03: Post in r/SaaS did not work; "signups" was 4 against 20.'] }), []);
    expect(block).toContain('What we learned (closed bets; cite the line when advice rests on it):\n- 2026-10-03: Post in r/SaaS did not work; "signups" was 4 against 20.');
  });
});

describe('what the reply is held to', () => {
  it('reads the weakest team verdict off its own document, and none while it is strong or unwritten', async () => {
    const rules = { framework: 'startup-evaluation', sections: [], verdict: { heading: '6. Verdict', by: 'judge' }, outcomes: ['PIVOT REQUIRED', 'WEAK', 'STRONG'] };
    const stage = { rooms: [], wires: [], docs: [{ id: 'e', title: 'Evaluation', x: 0, y: 0, w: 1, h: 1, rules }] } as unknown as Stage;
    const doc = (text: string) => async () => text;
    expect(await teamVerdict(stage, doc('# E\n\n## 6. Verdict\n\nVerdict: PIVOT REQUIRED\nScore: 6/10\nPause coding.\n'))).toEqual({ title: 'Evaluation', word: 'PIVOT REQUIRED', score: 6 });
    expect(await teamVerdict(stage, doc('# E\n\n## 6. Verdict\n\nVerdict: STRONG\nScore: 8/10\n'))).toBeNull();
    expect(await teamVerdict(stage, doc('# E\n\n## 6. Verdict\n\n'))).toBeNull();
  });

  // Journey 6: "Approve the task board: check your Needs you list" with nothing there.
  it('says nothing waits when a reply sends the founder to Needs you and nothing does', () => {
    expect(staleNeeds('1. Approve the task board: check your Needs you list.', [])).toBe(`1. Approve the task board: check your Needs you list.\n\n${NOTHING_WAITING}`);
    expect(staleNeeds('Accept the bet waiting in your Needs you.', [item('morning-note', 'Morning note')])).toMatch(/Nothing is waiting in Needs you\.\)$/);
    expect(staleNeeds('Accept the bet waiting in your Needs you.', [item('proposed-bet', 'Five paying users')])).toBe('Accept the bet waiting in your Needs you.');
    expect(staleNeeds('Talk to the three users today.', [])).toBe('Talk to the three users today.');
    // Journey 7: sent to "your decisions list" to approve a decision declined a moment before.
    const j7 = 'Yes, you should check your decisions list and approve the **Build invoicing feature this week?** decision.\n\nMy call: Open your decisions list and approve it.';
    expect(staleNeeds(j7, [])).toBe(`${j7}\n\n${NOTHING_WAITING}`);
    for (const said of ['Decline the proposal and move on.', 'Accept the tasks Dev proposed.', 'Approve the bet before Friday.']) expect(staleNeeds(said, []), said).toBe(`${said}\n\n${NOTHING_WAITING}`);
    expect(staleNeeds(j7, [item('proposed-decision', 'Build invoicing feature this week?')])).toBe(j7);
    expect(staleNeeds('Check the pricing pages of the three competitors.', [])).toBe('Check the pricing pages of the three competitors.');
  });
});
