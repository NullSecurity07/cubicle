import { describe, expect, it } from 'vitest';
import { guardUnasked, leftOutLine, unbackedPromises } from './unasked.ts';

// Journey 16: Anna asked "Can you deliver on Thursday instead of Sunday? And are the meals nut-free?" and the ready
// reply promised both, with "eat safely" on top.
const ANNA = 'Three of us on the night ward would try it. Can you deliver on Thursday instead of Sunday ...? And are the meals nut-free? Anna';
const BRIEF = '# Company\n\nShiftMeals, a weekly meal-prep delivery for night-shift nurses.\n\n## Numbers\n- Price: €59 per week per subscriber\n- Meals are delivered on Sunday.';

describe('an output nobody asked for, held to the record', () => {
  it('takes out the Thursday delivery and the nut-free promise, and says what was left out', () => {
    const body = 'Hi Anna,\n\nThanks for your reply!\n\nYes, we can definitely deliver on Thursday instead of Sunday, and all our meals are completely nut-free, so you and your colleagues on the night ward can eat safely.\n\nBest,';
    const held = guardUnasked(body, [BRIEF, ANNA]);
    expect(held.text).toBe('Hi Anna,\n\nThanks for your reply!\n\nBest,');
    expect(held.left).toEqual(['delivery on Thursday', 'nut-free', 'allergen safety']);
    expect(leftOutLine(held.left)).toBe('(left out: nothing on record about delivery on Thursday, nut-free, allergen safety)');
  });

  it('keeps what the record says, what says no and what promises to find out', () => {
    expect(unbackedPromises('We deliver on Sunday, as always.', [BRIEF])).toEqual([]);
    expect(unbackedPromises('We cannot promise nut-free meals yet.', [BRIEF])).toEqual([]);
    expect(unbackedPromises('I will check whether we can deliver on Thursday.', [BRIEF])).toEqual([]);
    expect(unbackedPromises('Could we deliver on Thursday?', [BRIEF])).toEqual([]);
    expect(unbackedPromises('Setup is hassle-free.', [BRIEF])).toEqual([]);
    // A question is no source, and nor is a line that says no.
    expect(unbackedPromises('All our meals are nut-free.', [ANNA])).toEqual(['nut-free']);
    expect(unbackedPromises('All our meals are nut-free.', ['Our meals are not nut-free.'])).toEqual(['nut-free']);
    expect(unbackedPromises('All our meals are nut-free.', ['Every meal is cooked nut-free in a separate kitchen.'])).toEqual([]);
  });

  it('takes out a customer\'s words nobody said', () => {
    const held = guardUnasked('Customers love the meals. Reply to Anna today.', [BRIEF]);
    expect(held.text).toBe('Reply to Anna today.');
    expect(held.left).toHaveLength(1);
  });
});

// Journey 16: paying subscribers went from 11 to 9.5 and the watch proposed "Call the three nurses who cancelled this
// week"; no cancellation was on record.
describe('a count nothing on record gives, in an unasked output', () => {
  const FACTS = 'The number is trending to the kill line.\nPaying subscribers: 9.5 on 2026-10-07, from 11 on 2026-10-06; the kill line is 8 (Paying subscribers drop below 8, checked on 2026-10-17).';
  const BRIEF = '## Numbers\n- Price: €59 per week per subscriber\n- Subscribers: 14\n- Paying subscribers: 11\n- Nurses contacted: 120';

  it('is taken out, said in words or in digits, and named in the left-out line', () => {
    const held = guardUnasked('Call the three nurses who cancelled this week. Ask what made them stop.', [FACTS, BRIEF]);
    expect(held.text).toBe('Ask what made them stop.');
    expect(held.left).toEqual(['3 nurses who']);
    expect(guardUnasked('Call the 3 nurses who cancelled.', [FACTS, BRIEF]).left).toHaveLength(1);
  });

  it('stands when the record gives it, or when it is a plan', () => {
    expect(guardUnasked('Call all 11 paying subscribers.', [FACTS, BRIEF]).left).toEqual([]);
    expect(guardUnasked('Contact 30 more night-shift nurses this week.', [FACTS, BRIEF]).left).toEqual([]);
    expect(guardUnasked('Call five lapsed signups this week and ask what stopped them.', [FACTS]).left).toEqual([]);
  });
});
