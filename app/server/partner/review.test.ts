import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Stage } from '../../shared/model.ts';
import { calculate } from '../tools/calc.ts';
import { createReviews, dailyBudget, fixAsk, granted, phrasingHolds, reviewDoc, reviewLine, senseFlags } from './review.ts';
import { stateOf } from './economics.ts';

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
    // Both workings: the one state's and the doc's own line.
    expect(review.flags[0].said).toBe('Net burn is €1,914 a month, not €1,380: 2100 - 3 * (240 - 178) = 1,914 (calc); it leaves out what the 3 paying offices cost (€534 a month). The doc has "Net burn at current MRR (€720): €1,380 per month".');
    expect(review.flags[1].said).toBe('Runway is 6.3 months, not 8.7: round(12000 / (2100 - 3 * (240 - 178)), 1) = 6.3 (calc). The doc has "Runway at net burn: 8.7 months".');
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

// Journey 15: Otto's turn made three "Runway" docs, the review called each "Fit for the founder.", and the runway rested
// on an invented MRR; Pia's spec said break-even in paying hosts.
describe('the review of journey 15\'s docs', () => {
  const PRINTNEAR = '- Price: €12 per print job (paid by the maker)\n- Print jobs done: 4\n- Paying hosts: 1\n- Cash: €2,500\n- Burn: €600 a month';
  const ASKED = 'Otto, write the Runway doc from the Company brief.';
  it('flags a doc whose title another doc on the stage carries', () => {
    const review = reviewDoc({ text: '# Runway\n\n- Runway: 4.2 months (calc: round(2500 / 600, 1) = 4.2)', numbers: PRINTNEAR, read: [ASKED, 'round(2500 / 600, 1) = 4.2'], said: [ASKED], title: 'Runway', twins: 2 });
    expect(review.flags).toEqual([{ kind: 'duplicate', said: '3 documents on the stage are called "Runway": keep one and take the others away, so nobody reads the wrong one.', short: '3 docs are called "Runway"' }]);
    expect(review.verdict).toBe('Fix first: 3 docs are called "Runway".');
    expect(reviewDoc({ text: '# Runway\n\n- Runway: 4.2 months', before: '# Runway\n\n- Runway: 4.2 months', numbers: PRINTNEAR, read: [], said: [], title: 'Runway', twins: 1 }).verdict).toBe('Fix first: 2 docs are called "Runway".');
  });

  it('flags a derived figure no calc gave, even one within rounding of the right figure, and passes one that calc gave', () => {
    // 4.3 against 4.2 is more than two in a hundred: named with both workings.
    expect(reviewDoc({ text: '# Runway\n\n- Monthly runway at net burn: 4.3 months', numbers: PRINTNEAR, read: [ASKED], said: [ASKED] }).flags.map((flag) => flag.short)).toEqual(['runway is 4.2 months, not 4.3']);
    // Read from the partner's own words, not worked out: within rounding, but still no calc behind it.
    const near = reviewDoc({ text: '# Runway\n\n- Monthly runway at net burn: 4.21 months', numbers: PRINTNEAR, read: [ASKED, 'Sam: runway is 4.21 months at the net burn.'], said: [ASKED] });
    expect(near.flags.map((flag) => flag.short)).toEqual(['a derived figure has no calc']);
    expect(near.flags[0].said).toContain('"Monthly runway at net burn: 4.21 months" is a sum with no calc behind it');
    const worked = reviewDoc({ text: '# Runway\n\n- Runway: 4.2 months', numbers: PRINTNEAR, read: [ASKED, 'round(2500 / 600, 1) = 4.2'], said: [ASKED] });
    expect(worked.verdict).toBe('Fit for the founder.');
  });

  it('flags break-even said in the wrong unit, with the brief\'s working', () => {
    const review = reviewDoc({ text: '# Spec\n\n- Break-even: 50 paying hosts', numbers: PRINTNEAR, read: [ASKED, 'ceil(600 / 12) = 50'], said: [ASKED] });
    expect(review.flags).toEqual([{ kind: 'sense', said: 'Break-even is 50 print jobs a month, not 50 paying hosts: ceil(600 / 12) = 50 (calc). The doc has "Break-even: 50 paying hosts".', short: 'break-even is 50 print jobs a month, not 50 paying hosts' }]);
    expect(reviewDoc({ text: '# Spec\n\n- Break-even: 50 print jobs a month', numbers: PRINTNEAR, read: [ASKED, 'ceil(600 / 12) = 50'], said: [ASKED] }).verdict).toBe('Fit for the founder.');
  });
});

// Journey 16: Otto's Runway was right (€255.67 a month each, +€912.37 a month, gross runway 3.16, break-even 8), and
// the first "Sam flagged" ever ordered him to write the founder's corrected wrong figures back: "runway is 5.6 months,
// not 3.16; break-even is 33 subscribers, not 8".
describe('the review of journey 16\'s docs', () => {
  const SHIFTMEALS = '- Price: €59 per week per subscriber\n- Subscribers: 14\n- Paying subscribers: 11\n- Cash: €6,000\n- Burn: €1,900 a month';
  const OTTO = '# Runway\n\n- Revenue per subscriber: €59 × 52 / 12 = €255.67 a month (calc)\n- MRR: 11 × €255.67 = €2,812.37 a month (calc)\n- Net cash flow: €2,812.37 − €1,900 = +€912.37 a month (calc)\n- Gross runway: €6,000 / €1,900 = 3.16 months (calc)\n- Break-even: ceil(1900 / 255.67) = 8 paying subscribers (calc)';
  const CALCS = ['59 * 52 / 12 = 255.67', '11 * 255.67 = 2,812.37', '2812.37 - 1900 = 912.37', '6000 / 1900 = 3.16', 'ceil(1900 / 255.67) = 8'];
  const ASKED = 'Otto, put the runway in a doc called Runway.';
  it('calls Otto\'s right doc fit for the founder, with no row', () => {
    expect(reviewDoc({ text: OTTO, numbers: SHIFTMEALS, read: [ASKED, ...CALLS()], said: [ASKED] })).toEqual({ flags: [], verdict: 'Fit for the founder.', checked: true });
  });
  function CALLS() { return CALCS; }
  it('flags the stale 33 with both workings, and only past rounding', () => {
    const review = reviewDoc({ text: '# Runway\n\n- Break-even: 33 paying subscribers (calc: ceil(1900 / 59) = 33)\n- Runway: 5.6 months', numbers: SHIFTMEALS, read: [ASKED, 'ceil(1900 / 59) = 33', 'round(6000 / (1900 - 14 * 59), 1) = 5.6'], said: [ASKED] });
    expect(review.flags.map((flag) => flag.said)).toEqual([
      'Break-even is 8 paying subscribers, not 33: ceil(1900 / (59 * 52 / 12)) = 8 (calc). The doc has "Break-even: 33 paying subscribers (calc: ceil(1900 / 59) = 33)".',
      'Runway is cash-positive (3.2 months at the gross burn alone), not 5.6: round(1900 - 11 * 59 * 52 / 12, 2) = -912.33 a month, cash-positive; at the gross burn round(6000 / 1900, 1) = 3.2 (calc). The doc has "Runway: 5.6 months".',
    ]);
  });
  it('works from the founder\'s corrections when the brief is ambiguous', () => {
    const monthly = SHIFTMEALS.replace('€59 per week per subscriber', '€59 per subscriber').replace('Paying subscribers: 11', 'Paying subscribers: 14');
    const fixed = stateOf(monthly, { fixes: [{ field: 'paying', value: 11, said: '11 pay', day: 'd', over: { value: 14 } }, { field: 'price', period: 'week', said: 'per week', day: 'd', over: { value: 59 } }] });
    expect(reviewDoc({ text: OTTO, numbers: monthly, read: [ASKED, ...CALCS], said: [ASKED], state: fixed }).verdict).toBe('Fit for the founder.');
    // Without them the same doc reads wrong: the flag is the state's, never the brief's alone.
    expect(reviewDoc({ text: OTTO, numbers: monthly, read: [ASKED, ...CALCS], said: [ASKED] }).verdict).toMatch(/^Fix first: /);
  });
});

// Journey 17: Otto's Runway, rewritten on Sam's ask with nine calc calls, every figure right. The review read the doc's
// words ("burn - mrr") against the calc's ("1900 - 11 * 59 * 52 / 12"), lost the minus of "-€912.33" and held "3.16"
// against 3.157894737: "Fix first: 2 derived figures have no calc." for four days.
const SHIFTMEALS = `- Subscribers: 14
- Paying subscribers: 11
- Price: €59 per week
- Cash: €6,000
- Burn: €1,900 a month
- Nurses contacted: 120
- Goal: 30 paying subscribers by 2026-10-17`;
const OTTO_CALCS = ['59 * 52 / 12', 'round(59 * 52 / 12, 2)', '11 * 59 * 52 / 12', 'round(11 * 59 * 52 / 12, 2)', '1900 - 11 * 59 * 52 / 12', '6000 / 1900', 'round(6000 / 1900, 1)', 'ceil(1900 / (59 * 52 / 12))', '30 - 11']
  .map((expression) => { const result = calculate(expression); return `${result.worked} = ${result.display}${Number(result.display.replace(/,/g, '')) !== result.value ? ` (exact: ${result.value})` : ''}`; });
const OTTO_RUNWAY = `# Runway

## Inputs (Company brief)
- Price: €59 per week
- Paying subscribers: 11
- Cash: €6,000
- Burn: €1,900 a month

## Workings
- Revenue per subscriber a month: price * 52 / 12 = €255.67 (calc)
- MRR: mrr = paying * price * 52 / 12 = €2,812.33 (calc)
- Net burn: net_burn = burn - mrr = -€912.33 a month (calc), so the company is cash-positive
- Gross runway: cash / burn = 6000 / 1900 = 3.16 months (calc), 3.2 months rounded
- Break-even: ceil(burn / revenue per subscriber) = 8 paying subscribers (calc)
- Gap to the goal: 19 paying subscribers (calc)
`;
const REDO = 'Please fix "Runway" before I act on it: work every figure out with calc from the Company brief\'s Numbers.';

describe('a figure is worked by its value, never by its words', () => {
  it('holds journey 17\'s right Runway fit: every derived figure is a calc result, the words around it aside', () => {
    expect(OTTO_CALCS).toHaveLength(9);
    const review = reviewDoc({ text: OTTO_RUNWAY, numbers: SHIFTMEALS, read: [REDO, ...OTTO_CALCS], said: [REDO] });
    expect(review.flags).toEqual([]);
    expect(review.verdict).toBe('Fit for the founder.');
  });

  it('still names a runway no calc and no state figure gives', () => {
    const doc = OTTO_RUNWAY.replace('= 3.16 months (calc), 3.2 months rounded', '= 3.4 months');
    const review = reviewDoc({ text: doc, numbers: SHIFTMEALS, read: [REDO, ...OTTO_CALCS], said: [REDO] });
    expect(review.verdict).toMatch(/^Fix first: /);
  });

  it('withdraws the flag on the doc\'s next review when the doc no longer bears it out', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'review-'));
    try {
      const docs: Record<string, string> = { runway: OTTO_RUNWAY.replace(/= 3\.16 months \(calc\), 3\.2 months rounded/, '= 3.4 months') };
      const stage = { rooms: [{ id: 'otto', name: 'Otto' }, { id: 'sam', name: 'Sam', partner: true }], docs: [{ id: 'runway', title: 'Runway' }], wires: [] } as unknown as Stage;
      let refreshed = 0;
      const reviews = createReviews({
        workspace, busy: new Set(), now: () => Date.now(), budget: dailyBudget(0),
        store: { loadStage: async () => stage, readDoc: async (id) => docs[id] ?? '', appendChat: async () => undefined },
        attention: { refresh: async () => { refreshed += 1; } },
        company: async () => ({ id: 'brief', text: `# ShiftMeals\n\n## Numbers\n${SHIFTMEALS}\n` }),
      });
      const turn = (read: string[]) => reviews.heard({ roomId: 'otto', query: REDO, reply: { tools: [{ name: 'create_doc', ok: true, result: read.join('\n'), effect: { kind: 'doc-changed', id: 'runway' } }] } } as never, async () => undefined as never);
      await turn([]);
      await reviews.tick({ id: 'sam', name: 'Sam' });
      expect((await reviews.rows()).map((row) => row.title)).toEqual([expect.stringMatching(/^Sam flagged: Otto's "Runway"\. Fix first: /)]);
      docs.runway = OTTO_RUNWAY;
      await turn(OTTO_CALCS);
      await reviews.tick({ id: 'sam', name: 'Sam' });
      expect(await reviews.rows()).toEqual([]);
      expect(refreshed).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

// Journey 18: Otto's Runway said "1,100 / 29 = 37.9 (rounded up to 38 plumbers) (calc)" and was flagged "38, not 37.9".
describe('a break-even written with its rounding', () => {
  const QUOTESNAP = '- Price: €29 a month per plumber\n- Paying plumbers: 9\n- Cash: €3,200\n- Burn: €1,100 a month';
  const ASKED = 'Write the runway';
  const read = [ASKED, 'ceil(1100 / 29) = 38', '1100 / 29 = 37.93'];
  const review = (line: string) => senseFlags(`# Runway\n\n${line}`, QUOTESNAP).flags;

  it('takes the quotient to its written places, or a line that says it was rounded to the right count', () => {
    expect(review('- Break-even paying plumbers = Gross burn / Price = 1,100 / 29 = 37.9 (rounded up to 38 plumbers) (calc)')).toEqual([]);
    expect(review('- Break-even: 37.93 paying plumbers')).toEqual([]);
    expect(review('- Break-even: 37 paying plumbers, rounded to 38')).toEqual([]);
    expect(reviewDoc({ text: '# Runway\n\n- Break-even paying plumbers = 1,100 / 29 = 37.9 (rounded up to 38 plumbers) (calc)', numbers: QUOTESNAP, read, said: [ASKED] }).flags.filter((one) => one.kind === 'sense')).toEqual([]);
  });

  it('still flags a figure off by more than its places, or rounded to the wrong count', () => {
    expect(review('- Break-even: 37.1 paying plumbers')[0]?.short).toBe('break-even is 38 paying plumbers, not 37.1');
    expect(review('- Break-even: 37 paying plumbers')[0]?.short).toBe('break-even is 38 paying plumbers, not 37');
    expect(review('- Break-even: 37.9, rounded to 37 paying plumbers')).toHaveLength(1);
  });
});

// Journey 20: Otto's Runway doc was the one right picture on the stage (both streams, cash-positive, 34 cafés on the
// subscriptions alone), and the review flagged it "break-even is 325 bookings a month, not 34 paying caf".
describe('a review of a doc on two revenue streams (journey 20)', () => {
  const FIXSLOT = '- Price: €4 per booking\n- Bookings last month: 280\n- Paying cafés: 6 at €39 a month\n- Cash: €5,400\n- Burn: €1,300 a month\n- Cafés contacted: 40';
  const OTTO = [
    '# Runway',
    '',
    '- Revenue: 280 * 4 + 6 * 39 = €1,354 a month (calc)',
    '- Net burn: 1300 - 1354 = -€54 a month (calc)',
    '- Runway: Infinite, we are cash-positive',
    '- Break-even on subscriptions alone: 1300 / 39 = 33.33, so 34 paying cafés if bookings stopped',
  ].join('\n');
  it('is Fit for the founder', () => {
    const review = reviewDoc({ text: OTTO, numbers: FIXSLOT, read: ['280 * 4 + 6 * 39 = 1354', '1300 - 1354 = -54', '1300 / 39 = 33.33333333'], said: [] });
    expect(review.verdict).toBe('Fit for the founder.');
  });
  it('a break-even in bookings is flagged with the unit whole, never "caf"', () => {
    const review = reviewDoc({ text: '# Runway\n\n- Break-even: 325 bookings a month', numbers: FIXSLOT, read: [], said: [] });
    expect(review.verdict).toMatch(/^Fix first: break-even is 5 paying cafés, not 325 bookings/);
    const sense = senseFlags('- Break-even: 34 paying cafés', stateOf(FIXSLOT));
    expect(sense.flags).toEqual([]);
  });
});
