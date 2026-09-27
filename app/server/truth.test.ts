import { describe, expect, it } from 'vitest';
import { PARTNER_STANCE, STANCE } from '../shared/model.ts';
import { checkReply, figureCheck, proseToolCall, turnSources, unreceiptedClaims, unsourcedFigures } from './truth.ts';

const wrote = { name: 'write_doc', ok: true };
const failedWrite = { name: 'write_doc', ok: false };
const read = { name: 'read_doc', ok: true };
const mailed = { name: 'send_email', ok: true };

describe('unreceiptedClaims', () => {
  it('catches a save no tool made, the way June claimed the January update', () => {
    expect(unreceiptedClaims("Here is the January 2026 update. I've saved it as `january-update.md` for you.", [])).toEqual(['saved']);
    expect(unreceiptedClaims('The update has been saved to the shared folder.', [read])).toEqual(['saved']);
    expect(unreceiptedClaims('Saved it to january-update.md.', [])).toEqual(['saved']);
  });

  it('catches sends, posts, emails and schedules, first person or passive', () => {
    expect(unreceiptedClaims('I sent the deck to Maya.', [])).toEqual(['sent']);
    expect(unreceiptedClaims('I have emailed the three investors.', [])).toEqual(['emailed']);
    expect(unreceiptedClaims('The post was published on LinkedIn and I scheduled the follow-up.', [])).toEqual(['published', 'scheduled']);
    expect(unreceiptedClaims("We've posted it this morning.", [])).toEqual(['posted']);
    expect(unreceiptedClaims('We posted it this morning.', [])).toEqual(['posted']);
    expect(unreceiptedClaims('We sent the deck to Maya.', [])).toEqual(['sent']);
    expect(unreceiptedClaims('We scheduled the call for Friday.', [])).toEqual(['scheduled']);
    expect(unreceiptedClaims('I just updated the pricing doc.', [])).toEqual(['updated']);
  });

  it('lets a claim stand when a tool of that kind worked this turn', () => {
    expect(unreceiptedClaims("I've saved it as january-update.md.", [wrote])).toEqual([]);
    expect(unreceiptedClaims('I updated the pricing doc.', [{ name: 'replace_section', ok: true }])).toEqual([]);
    expect(unreceiptedClaims('I sent the deck to Maya.', [mailed])).toEqual([]);
    expect(unreceiptedClaims('I scheduled a check every six hours.', [{ name: 'watch_page', ok: true }])).toEqual([]);
  });

  it('takes a closed or proposed bet as the record and the schedule it is', () => {
    expect(unreceiptedClaims("I've recorded the bet as worked.", [{ name: 'close_bet', ok: true }])).toEqual([]);
    expect(unreceiptedClaims("I've scheduled a check on it for Friday.", [{ name: 'propose_bet', ok: true }])).toEqual([]);
  });

  it('does not count a write the doc guard held back', () => {
    const held = { name: 'replace_section', ok: true, result: 'Not written: the verdict waits for "4. Founder-market fit", which is empty. ' };
    expect(unreceiptedClaims('I wrote the verdict: STRONG.', [held])).toEqual(['wrote']);
  });

  it('does not count a tool that failed, or one of another kind', () => {
    expect(unreceiptedClaims("I've saved the plan.", [failedWrite])).toEqual(['saved']);
    expect(unreceiptedClaims('I sent the deck to Maya.', [wrote])).toEqual(['sent']);
  });

  it('leaves denials, plans, conditions and words written in the reply itself alone', () => {
    for (const reply of [
      'I did not send it: I need your OK first.',
      "I haven't saved anything yet.",
      'Nothing was saved, because the Numbers doc is empty.',
      'It was not sent.',
      "I'll send it once you approve.",
      'Once I have saved it, I will tell you.',
      'If I sent it now, it would go out without figures.',
      'Here is what I wrote below:',
      'Should it be saved as a new doc?',
      'I wrote a first draft for you:\n\nDear investors,',
    ]) expect(unreceiptedClaims(reply, []), reply).toEqual([]);
  });

  it('leaves normal talk about state, history and opinions alone', () => {
    for (const reply of [
      'Stripe was created in 2010.',
      'The data is updated weekly.',
      'Last month we sent 50 cold emails and got 3 replies.',
      'I updated my view: go with B.',
      'You said you sent it Monday, so it was sent already.',
      'Your landing page is published at acme.com.',
      'I sent you nothing yet.',
      'We updated the pricing page in March.',
    ]) expect(unreceiptedClaims(reply, []), reply).toEqual([]);
  });
});

describe('unsourcedFigures', () => {
  const doc = '## Doc: Numbers\n| Month | MRR | Churn |\n| Aug | $22,000 | 2.3% |\nRunway: 18 months. 140 customers.';

  it('flags the figures Iona made up with nothing wired but the idea', () => {
    const reply = 'We charge $29 a month, hold SOC 2, keep CAC at $300 and churn under 2%, an 8x LTV:CAC.';
    expect(unsourcedFigures(reply, ['## Idea\nA calm invoicing tool for freelancers.', 'Write the FAQ.'])).toEqual(['$29', '$300', '2%', '8x']);
  });

  it('takes arithmetic on known figures as sourced, and flags a figure no step of it gives', () => {
    // $22,000 × 18 is arithmetic on two figures of the doc; $1.5M is nothing of the kind.
    expect(unsourcedFigures('$22,000 × 18 = $396,000, rounded to $1.5M.', [doc])).toEqual(['$1.5M']);
  });

  it('does not flag a figure quoted from a wired doc, even written another way', () => {
    expect(unsourcedFigures('MRR is $22k with churn at 2.3%, 140 customers and 18 months of runway.', [doc])).toEqual([]);
    expect(unsourcedFigures('MRR is $22,000.', [doc])).toEqual([]);
  });

  it('does not flag figures a tool result or the founder gave this turn', () => {
    expect(unsourcedFigures('The top result says 34% of freelancers pay late.', ['Search results: ... 34% of freelancers ...'])).toEqual([]);
    expect(unsourcedFigures('At $49 a month you need 450 customers.', ['founder: price it at $49', 'we have 450 customers'])).toEqual([]);
  });

  it('leaves small counts, dates and bare numbers alone', () => {
    expect(unsourcedFigures('Talk to 5 customers in 3 weeks, by 12 October 2026, in 2 steps.', [])).toEqual([]);
    expect(unsourcedFigures('Section 4 of the 2026 plan.', [])).toEqual([]);
  });

  it('takes a figure as sourced only when it is no more exact than the input it matches', () => {
    expect(unsourcedFigures('That leaves $8,005 in savings.', ['Savings: $8k'])).toEqual(['$8,005']);
    expect(unsourcedFigures('That leaves $8,000 in savings.', ['Savings: $8k'])).toEqual([]);
    expect(unsourcedFigures('Raise $1.5M.', ['We need 1,500,000 dollars.'])).toEqual([]);
    expect(unsourcedFigures('Raise $1.52M.', ['We need 1.5 million.'])).toEqual(['$1.52M']);
  });

  it('flags a range of hours or a rate nothing gave it, and leaves plain advice alone', () => {
    expect(unsourcedFigures('Freelancers lose 20–40 hours per project search.', [])).toEqual(['20–40 hours']);
    expect(unsourcedFigures('That is 15-25 days of work.', [])).toEqual(['15-25 days']);
    expect(unsourcedFigures('They spend 12 hours per week on invoices.', [])).toEqual(['12 hours']);
    expect(unsourcedFigures('Reply within 24 hours and run it 30 days.', [])).toEqual([]);
    expect(unsourcedFigures('Within 24 hours a customer writes in.', [])).toEqual([]);
    expect(unsourcedFigures('They spend 12 hours/week on invoices.', [])).toEqual(['12 hours']);
    expect(unsourcedFigures('They spend 12 hours per week on invoices.', ['survey: 12 hours a week'])).toEqual([]);
  });

  it('leaves durations in advice alone', () => {
    expect(unsourcedFigures('Run it for 30 days and reply within 24 hours, over 12 weeks.', [])).toEqual([]);
  });

  it('flags a large count with a unit', () => {
    expect(unsourcedFigures('You will reach 1,200 users by spring.', [])).toEqual(['1,200 users']);
  });
});

describe('proseToolCall', () => {
  it('catches the colleague reply from the journey', () => {
    expect(proseToolCall('<tool_call><function=ask_founder>\n<parameter=question>What price?</parameter></function></tool_call>')).toBe(true);
  });

  it('catches a raw JSON call and the gpt-oss bold-name shape', () => {
    expect(proseToolCall('{"name": "ask_founder", "arguments": {"question": "What price?"}}')).toBe(true);
    expect(proseToolCall('```json\n{ "name": "write_doc", "arguments": { "doc": "Plan" } }\n```')).toBe(true);
    expect(proseToolCall('**ask_founder**{"question":"What price?"}')).toBe(true);
    expect(proseToolCall('ask_person({"person": "Sam", "question": "why"})')).toBe(true);
    expect(proseToolCall('write_doc {"doc": "Plan", "text": "x"}', ['write_doc'])).toBe(true);
  });

  it('leaves words that only name a tool alone', () => {
    expect(proseToolCall('I will use ask_founder to check the price with you.')).toBe(false);
    expect(proseToolCall('The plan: {"name": "Pro", "price": 29} is one option.')).toBe(false);
    expect(proseToolCall('Wrote the plan into write_doc earlier.', ['write_doc'])).toBe(false);
  });
});

describe('checkReply', () => {
  it('does not take a figure a past reply was already flagged for as a source', () => {
    const earlier = 'We should charge $29 a month.\n\nUnsourced figures: $29 (not found in anything this turn read).';
    expect(checkReply({ reply: 'At $29 a month we break even.', receipts: [], sources: ['What price?', earlier] }))
      .toEqual(['Unsourced figures: $29 (not found in anything this turn read).']);
    expect(checkReply({ reply: 'At $29 a month we break even.', receipts: [], sources: ['Price: $29', earlier] })).toEqual([]);
    const both = 'Churn is 2% and 32% of trials convert.\n\nUnsourced figures: 2% (not found in anything this turn read).';
    expect(checkReply({ reply: '32% of trials convert.', receipts: [], sources: ['How do trials do?', both] })).toEqual([]);
  });

  it('gives the founder-visible lines, one per kind of problem', () => {
    const lines = checkReply({ reply: "I've saved it. Revenue grew to $36,850, up 23%.", receipts: [], sources: ['Numbers is empty.'] });
    expect(lines).toEqual([
      'Unconfirmed: this reply claims an action no tool confirmed (saved).',
      'Unsourced figures: $36,850, 23% (not found in anything this turn read).',
    ]);
  });

  it('says nothing about a clean reply', () => {
    expect(checkReply({ reply: 'I did not send it. MRR is $22,000.', receipts: [], sources: ['MRR $22,000'] })).toEqual([]);
  });
});

// The probe from the second reliability audit: the founder said 40 customers, $49/mo, $2k MRR, 3 churned, 9 months,
// 12 prospects, and seventeen ordinary replies came back. Five were false alarms and two inventions were missed.
describe('the truth net on ordinary founder replies', () => {
  const founder = 'We have 40 customers paying $49/mo, about $2k MRR. 3 churned last month. We have 9 months of runway and 12 prospects in the pipeline.';
  const check = (reply: string) => checkReply({ reply, receipts: [], sources: [founder] });
  const figures = (reply: string) => figureCheck(reply, [founder]);

  it('takes correct arithmetic on the founder\'s figures as sourced', () => {
    expect(check('40 customers is $1,960 MRR, about $23,520 a year.')).toEqual([]);
    expect(check('3 of 40 is 7.5% monthly churn.')).toEqual([]);
    expect(check('30% of your 40, so 12 accounts.')).toEqual([]);
  });

  it('marks a goal or a proposed price as a proposal, not as unsourced', () => {
    expect(figures('Aim for 100 customers by December.')).toEqual({ unsourced: [], proposals: ['100 customers'] });
    expect(figures('Try $79/month for new signups.')).toEqual({ unsourced: [], proposals: ['$79'] });
    expect(check('Aim for 100 customers by December.')).toEqual([]);
    expect(check('What if you charged $99 for teams? You could charge $149 for agencies. I suggest a target of 60 customers.')).toEqual([]);
  });

  it('still flags what nothing gives, even among proposals', () => {
    expect(check('Cutting the $500 ad spend frees cash.')).toEqual(['Unsourced figures: $500 (not found in anything this turn read).']);
    expect(check('That is 20-40 hours of work.')).toEqual(['Unsourced figures: 20-40 hours (not found in anything this turn read).']);
    expect(check('Stripe grew to 1,000 customers in its first year, in 2011.')).toEqual(['Unsourced figures: 1,000 customers (not found in anything this turn read).']);
    expect(figures('Aim for 100 customers, since good SaaS churn is under 2% a month.')).toEqual({ unsourced: ['2%'], proposals: ['100 customers'] });
  });

  it('does not let the 2 in "$2k" source a 2% or a 2x', () => {
    expect(check('Good B2B SaaS churn is under 2% a month.')).toEqual(['Unsourced figures: 2% (not found in anything this turn read).']);
    expect(check('Your best customers pay 2x the median.')).toEqual(['Unsourced figures: 2x (not found in anything this turn read).']);
  });

  it('flags an unconfirmed save and leaves plain talk alone', () => {
    expect(check('I saved the pricing notes.')).toEqual(['Unconfirmed: this reply claims an action no tool confirmed (saved).']);
    for (const reply of [
      'Talk to the three who churned before you change anything.',
      'Once you have the numbers, I will have saved a copy for you.',
      'I will send the update on Friday.',
      'You told me we sent the deck last week.',
      'I updated my view: price is not the problem.',
      'Spend 2 hours a day on sales calls and reply within 24 hours.',
    ]) expect(check(reply)).toEqual([]);
  });

  it('takes runway worked out from cash and burn as sourced, as journey 3 wrote it', () => {
    expect(check('Runway: 26.67 months at this burn.').length).toBe(1);
    expect(checkReply({ reply: 'Runway: 26.67 months at this burn.', receipts: [], sources: ['We have $8,000 in the bank and burn $300 a month.'] })).toEqual([]);
  });
});

describe('what a turn counts as its sources', () => {
  const system = [
    'You are Sam, Partner. Keep CAC under $300 and churn under 2% in everything you propose.',
    PARTNER_STANCE,
    STANCE,
    'Reply in short markdown: brief paragraphs, lists where they help, a table only for real comparisons.',
    'Company documents every person reads:\n\n## Doc: Company\n## Numbers\nMRR $22,000\n\n## Team\nTwo founders.',
    'The founder has connected these documents to your room. Treat them as what the founder wants you to know.\n\n## Doc: Plan\nLaunch with 140 customers.',
    'Today is Sunday 27 September 2026, in the founder\'s time zone (UTC).',
    'Your company playbook: what the people here learned doing this kind of work before.\nOffer 45% off the first month.',
  ].join('\n\n');
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: 'We burn $4,000 a month.' },
    { role: 'tool' as const, content: 'Search results: 34% of freelancers pay late.', tool_call_id: 'c1' },
  ];

  it('reads the founder\'s words, the documents and the tool results, not the brief, the stance, the day or the playbook', () => {
    const sources = turnSources(messages);
    const flagged = unsourcedFigures('MRR is $22,000 with 140 customers, burn $4,000, and 34% pay late. Keep CAC at $300, churn at 2%, and offer 45% off.', sources);
    expect(flagged).toEqual(['$300', '2%', '45%']);
  });
});
