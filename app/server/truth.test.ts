import { describe, expect, it } from 'vitest';
import { checkReply, proseToolCall, unreceiptedClaims, unsourcedFigures } from './truth.ts';

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
    expect(unreceiptedClaims('We posted it this morning.', [])).toEqual(['posted']);
    expect(unreceiptedClaims('I just updated the pricing doc.', [])).toEqual(['updated']);
  });

  it('lets a claim stand when a tool of that kind worked this turn', () => {
    expect(unreceiptedClaims("I've saved it as january-update.md.", [wrote])).toEqual([]);
    expect(unreceiptedClaims('I updated the pricing doc.', [{ name: 'replace_section', ok: true }])).toEqual([]);
    expect(unreceiptedClaims('I sent the deck to Maya.', [mailed])).toEqual([]);
    expect(unreceiptedClaims('I scheduled a check every six hours.', [{ name: 'watch_page', ok: true }])).toEqual([]);
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
});

describe('unsourcedFigures', () => {
  const doc = '## Doc: Numbers\n| Month | MRR | Churn |\n| Aug | $22,000 | 2.3% |\nRunway: 18 months. 140 customers.';

  it('flags the figures Iona made up with nothing wired but the idea', () => {
    const reply = 'We charge $29 a month, hold SOC 2, keep CAC at $300 and churn under 2%, an 8x LTV:CAC.';
    expect(unsourcedFigures(reply, ['## Idea\nA calm invoicing tool for freelancers.', 'Write the FAQ.'])).toEqual(['$29', '$300', '2%']);
  });

  it('flags Ben\'s arithmetic that no input holds', () => {
    expect(unsourcedFigures('$22,000 × 18 = $396,000, rounded to $1.5M.', [doc])).toEqual(['$396,000', '$1.5M']);
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
