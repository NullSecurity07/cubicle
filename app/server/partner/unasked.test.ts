import { describe, expect, it } from 'vitest';
import { answerQuestions, filledIn, guardMove, guardUnasked, guardView, leftOutLine, questionsIn, unbackedPromises } from './unasked.ts';
import { draftLine } from './watch.ts';

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

// Journey 17: a move is a plan and a risk is a view; neither is taken out.
describe('a move and a risk, held as what they are', () => {
  const brief = '- Paying subscribers: 11\n- Nurses contacted: 120';
  it('keeps a move whole, naming after it only a count whose number is nowhere on record, or a promise', () => {
    expect(guardMove('Follow up with the 120 nurses contacted.', [brief])).toBe('Follow up with the 120 nurses contacted.');
    expect(guardMove('Call back the 37 nurses who cancelled.', [brief])).toBe('Call back the 37 nurses who cancelled. (not on record: 37 nurses who)');
    // A count the move sets out to reach, and a gap worked from two figures on record, are the plan's.
    expect(guardMove('Contact 50 new nurses today.', [brief])).toBe('Contact 50 new nurses today.');
    expect(guardMove('Ask the 11 paying for referrals to find the 109 nurses still to reach.', [brief], brief)).toBe('Ask the 11 paying for referrals to find the 109 nurses still to reach.');
    expect(guardMove('Tell Anna we deliver on Thursday.', [brief])).toBe('Tell Anna we deliver on Thursday. (not on record: delivery on Thursday)');
  });
  it('keeps a risk as written, marked as the partner\'s view when it names what nothing backs', () => {
    expect(guardView('Paying subscribers are 11, near the line.', [brief])).toBe('Paying subscribers are 11, near the line.');
    expect(guardView('37 nurses cancelled last week.', [brief])).toBe('37 nurses cancelled last week. (view)');
  });
});

// Journey 17: the guard took out both made-up yeses to Anna and left "Thanks for reaching out ... Best,".
describe('a reply built from the lead\'s questions', () => {
  const ANNA = 'Three of us on the night ward would try it. Can you deliver on Thursday instead of Sunday? And are the meals nut-free? Anna';
  const HOLLOW = 'Hi Anna,\n\nThanks for reaching out from St. Marien Hospital. Let me know if you would like to set this up for your shift week.\n\nBest,';

  it('gives each of Anna\'s questions an honest line, before the sign-off, and says we wrote first', () => {
    expect(questionsIn(ANNA)).toEqual(['Can you deliver on Thursday instead of Sunday?', 'Are the meals nut-free?']);
    const built = answerQuestions(HOLLOW, ANNA, { name: 'Anna Kowalski', today: '2026-10-07' });
    expect(built.body).toBe('Hi Anna,\n\nThanks for getting back to me from St. Marien Hospital. Let me know if you would like to set this up for your shift week.\n\n'
      + 'I will check Thursday delivery and come back to you by Friday.\nI will check nut-free meals and come back to you by Friday.\n\nBest,');
    expect(built).toMatchObject({ asks: [], hollow: false });
    // The honest lines promise nothing the guard would take out.
    expect(guardUnasked(built.body, [ANNA]).left).toEqual([]);
  });

  it('keeps an answer the record backs and adds no line for it', () => {
    const body = 'Hi Anna,\n\nOur meals are delivered on Sunday to the staff entrance, so Thursday is not something we do yet.\n\nBest,';
    const built = answerQuestions(body, ANNA, { name: 'Anna Kowalski', today: '2026-10-07' });
    expect(built.body).not.toContain('On Thursday delivery');
    expect(built.body).toContain('I will check nut-free meals and come back to you by Friday.');
  });

  it('offers the questions to the founder, never a hollow email, when nothing on record answers them', () => {
    const said = 'What does a week cost for three people? Who cooks the meals?';
    const built = answerQuestions('Hi Anna,\n\nThanks for your reply.\n\nBest,', said, { name: 'Anna Kowalski', today: '2026-10-07' });
    expect(built).toEqual({ body: 'Hi Anna,\n\nWhat does a week cost for three people?\n\nWho cooks the meals?', asks: ['What does a week cost for three people?', 'Who cooks the meals?'], hollow: true });
    expect(draftLine({ kind: 'email', to: 'anna@marien.example', subject: 'Thanks', ...built, hollow: true }))
      .toBe("Nothing on record to answer Anna's questions; draft needs the founder.\n☐ What does a week cost for three people?\n☐ Who cooks the meals?");
  });
});

// Journey 18: Lea signed the founder's email "Best, Sam / QuoteSnap", the partner's name on the founder's mail.
describe('the name under a draft', () => {
  const BRIEF = '# Company\n\n## Idea\nQuoteSnap turns a plumber\'s WhatsApp photos into written quotes.';
  it('signs with the founder\'s name the brief gives and the company only when the brief names it, never a colleague', () => {
    expect(filledIn('Hi Tom,\n\nThanks.\n\nBest, Sam / QuoteSnap', BRIEF, ['Sam', 'Lea'])).toBe('Hi Tom,\n\nThanks.\n\nBest,\nQuoteSnap');
    expect(filledIn('Hi Tom,\n\nThanks.\n\nBest,\nSam / QuoteSnap', `${BRIEF}\n- Founder: Mara Lind`, ['Sam'])).toBe('Hi Tom,\n\nThanks.\n\nBest,\nMara Lind / QuoteSnap');
    expect(filledIn('Hi Tom,\n\nThanks.\n\nBest,\nLea\nPlumbFast', BRIEF, ['Lea'])).toBe('Hi Tom,\n\nThanks.\n\nBest,');
    // A sign-off already right is left as written, and a sentence that starts with thanks is no sign-off.
    expect(filledIn('Hi Tom,\n\nKind regards,\nMara Lind\nQuoteSnap', `${BRIEF}\n- Founder: Mara Lind`)).toBe('Hi Tom,\n\nKind regards,\nMara Lind\nQuoteSnap');
    expect(filledIn('Hi Tom,\n\nThanks for your reply.', BRIEF)).toBe('Hi Tom,\n\nThanks for your reply.');
  });
});

