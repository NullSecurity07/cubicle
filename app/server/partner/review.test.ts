import { describe, expect, it } from 'vitest';
import { dailyBudget, fixAsk, granted, phrasingHolds, reviewDoc, reviewLine } from './review.ts';

// The Numbers of journey 13's Company brief, as the founder wrote them.
const HARVEST = `- Offices in pilot: 5
- Paying offices: 3 (since September 2026)
- Price: €240 a month per office (one box a week for about 20 people)
- Produce + delivery cost: €41 per box, about €178 a month per office
- MRR: €720
- Cash: €12,000
- Burn: €2,100 a month (van, founder's costs, packaging)
- Farms signed: 4`;
const ASK = 'Tom, write the Unit Economics doc from the Company brief.';

describe('the partner reviews a colleague\'s doc', () => {
  it('names journey 13\'s wrong net burn and runway with the right working, though Tom worked them out with calc', () => {
    const tom = '# Unit Economics\n\n## Monthly\n- MRR: €720\n- Net burn at current MRR (€720): €1,380 per month\n- Runway at net burn: 8.7 months\n';
    const review = reviewDoc({ text: tom, numbers: HARVEST, read: [ASK, '2100 - 720 = 1380', '12000 / 1380 = 8.695652174 (exact: 8.695652173913043)'], said: [ASK] });
    expect(review.flags.map((flag) => flag.kind)).toEqual(['sense', 'sense']);
    expect(review.flags[0].said).toBe('Net burn is €1,914 a month, not €1,380: 2100 + 3 * 178 - 3 * 240 = 1,914 (calc); it leaves out what the 3 paying offices cost (€534 a month).');
    expect(review.flags[1].said).toBe('Runway is 6.3 months, not 8.7: round(12000 / 1914, 1) = 6.3 (calc).');
    expect(review.verdict).toBe('Fix first: net burn is €1,914 a month, not €1,380; runway is 6.3 months, not 8.7.');
    expect(reviewLine('Unit Economics', review)).toMatch(/^I read "Unit Economics"\.\n- Net burn is €1,914/);
    expect(fixAsk('Unit Economics', review)).toContain('Please fix "Unit Economics" before I act on it: Net burn is €1,914');
  });

  it('names a derived figure with no calc and no source, written in the head', () => {
    const review = reviewDoc({ text: '# Unit Economics\n\n- Payback on a new office: 7 months a month of margin\n- Total monthly cost: €3,050', numbers: HARVEST, read: [ASK], said: [ASK] });
    expect(review.flags.some((flag) => flag.kind === 'number' && flag.said.includes('"€3,050"'))).toBe(true);
    expect(review.verdict).toMatch(/^Fix first: /);
  });

  it('names customer feedback nothing on record says, written as fact or as the writer\'s assumption', () => {
    const notes = '# Customer notes\n\n- Office managers report the boxes are a popular perk.\n- Staff appreciate the freshness (assumption).\n- Next: ask the 3 paying offices what they would change.';
    const review = reviewDoc({ text: notes, numbers: HARVEST, read: [ASK], said: [ASK] });
    expect(review.flags.map((flag) => flag.kind)).toEqual(['claim']);
    expect(review.flags[0].said).toContain('"Office managers report the boxes are a popular perk." and "Staff appreciate the freshness."');
    expect(review.verdict).toBe('Fix first: 2 claims have no record behind them.');
    // Interview notes that say it back the claim.
    const heard = 'Interview with Ana, office manager at Brightdesk: she said the boxes are a popular perk with her team.';
    expect(reviewDoc({ text: '# Customer notes\n\n- Office managers report the boxes are a popular perk.', numbers: HARVEST, read: [heard], said: [heard] }).flags).toEqual([]);
  });

  it('calls a clean doc fit for the founder, and reviews only what was added since', () => {
    const clean = '# Unit Economics\n\n- Net burn: €1,914 a month\n- Runway: 6.3 months at that burn\n- Margin: €62 a month per office, 25.8%';
    const review = reviewDoc({ text: clean, numbers: HARVEST, read: [ASK, '2100 + 3 * 178 - 3 * 240 = 1914'], said: [ASK] });
    expect(review).toEqual({ flags: [], verdict: 'Fit for the founder.', checked: true });
    const tom = '# Unit Economics\n\n- Net burn: €1,380 per month';
    expect(reviewDoc({ text: `${tom}\n- Farms signed: 4`, before: tom, numbers: HARVEST, read: [], said: [] })).toEqual({ flags: [], verdict: 'Fit for the founder.', checked: true });
    expect(reviewDoc({ text: tom, before: tom, numbers: HARVEST, read: [], said: [] }).checked).toBe(false);
  });

  it('keeps a model\'s wording only when its numbers are the review\'s, and spends the day\'s budget once each', async () => {
    const line = 'Net burn is €1,914 a month, not €1,380: 2100 + 3 * 178 - 3 * 240 = 1914 (calc).';
    expect(phrasingHolds('Tom, the net burn is €1,914, not €1,380: the box costs are missing.', line)).toBe(true);
    expect(phrasingHolds('Tom, the net burn is €2,000.', line)).toBe(false);
    let at = new Date('2026-10-06T09:00').getTime();
    const budget = dailyBudget(2, () => at);
    expect([(await granted(budget, 'a')).ok, (await granted(budget, 'b')).ok, (await granted(budget, 'c')).ok]).toEqual([true, true, false]);
    at += 86_400_000;
    expect((await granted(budget, 'd')).ok).toBe(true);
    expect((await granted({ take: () => ({ ok: false }) }, 'e')).ok).toBe(false);
    // The app's budget hands back a release: a turn no model answered goes back.
    let released = 0;
    (await granted({ take: () => ({ ok: true, release: () => { released += 1; } }) }, 'f')).release();
    expect(released).toBe(1);
  });
});
