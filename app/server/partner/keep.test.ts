import { describe, expect, it } from 'vitest';
import { seedDocs } from '../../shared/model.ts';
import { companyTemplate } from '../../shared/partner.ts';
import { withSections } from './company.ts';
import { companyFacts, keepFacts, keptLine, runwayFix } from './keep.ts';

// Journey 4's first message, as the founder wrote it on Day 1.
export const DAY_ONE = "I'm building Ledgerly: $29/month bookkeeping for EU solo consultants that drafts VAT returns from bank feeds. "
  + 'We have 3 paying beta users; two of them asked for invoicing. I have €4,200 in the bank and burn €1,100/month. I\'m a solo technical founder. Tear it apart.';

// Journey 15: the founder said "one host is not €12 a month of revenue" and the brief gained "- MRR: €12 a month
// (founder, 2026-10-06)", which fed the Runway doc and the deck.
describe('a figure the founder says is not so', () => {
  const PUSHBACK = "I don't buy it. You gave me no kill signal at all, and break-even is 50 print jobs a month, not 50 paying hosts: one host is not €12 a month of revenue. Give me a sharper call with a kill signal that can actually fail, tied to my 10-jobs goal.";
  const BRIEF = '# Company brief\n\n## Numbers\n\n- Price: €12 per print job (paid by the maker)\n- Paying hosts: 1\n- Cash: €2,500\n- Burn: €600 a month\n\n## Decisions\n';
  it('is never written into the brief as the founder\'s', () => {
    const facts = companyFacts(PUSHBACK);
    expect(facts.numbers).toEqual([]);
    expect(facts.denied).toEqual([{ label: 'MRR', value: '€12 a month' }]);
    expect(keepFacts(BRIEF, facts, '2026-10-06')).toEqual({ text: BRIEF, kept: [] });
  });

  it('takes its row out of the brief, however it got there, and a corrected figure takes its place', () => {
    const wrong = BRIEF.replace('- Burn: €600 a month', '- Burn: €600 a month\n- MRR: €12 a month (founder, 2026-10-06)');
    const out = keepFacts(wrong, companyFacts(PUSHBACK), '2026-10-06');
    expect(out.text).toContain('- Paying hosts: 1\n- Cash: €2,500\n- Burn: €600 a month\n');
    expect(out.text).not.toContain('MRR');
    expect(out.kept).toEqual(['Numbers (MRR €12 a month taken out: the founder said it is not so)']);
    const put = keepFacts(wrong, companyFacts('MRR is not €12 a month. MRR is €0 a month.'), '2026-10-07');
    expect(put.text).toContain('- MRR: €0 a month (founder, 2026-10-07)');
    expect(put.text).not.toContain('€12 a month (founder');
    expect(companyFacts('Burn is €600 a month, not €900 a month.').numbers).toEqual([{ label: 'Burn', value: '€600 a month' }]);
  });
});

describe('company facts in what the founder says', () => {
  it('reads the price, cash, burn, the users and the one line of what the company does', () => {
    expect(companyFacts(DAY_ONE)).toEqual({
      numbers: [
        { label: 'Price', value: '$29/month' },
        { label: 'Paying beta users', value: '3', sure: true },
        { label: 'Cash', value: '€4,200' },
        { label: 'Burn', value: '€1,100/month' },
      ],
      idea: "I'm building Ledgerly: $29/month bookkeeping for EU solo consultants that drafts VAT returns from bank feeds",
      customer: 'EU solo consultants',
    });
  });

  it('reads other ways of saying them, and nothing from a question with no facts', () => {
    expect(companyFacts('We charge €49 a month. Cash: $80k. Our total spend is $6,500 per month. 120 customers so far.').numbers).toEqual([
      { label: 'Price', value: '€49 a month' }, { label: 'Cash', value: '$80k' }, { label: 'Burn', value: '$6,500 per month' }, { label: 'Customers', value: '120', sure: true },
    ]);
    expect(companyFacts('should we raise the price? Give me a number.')).toEqual({ numbers: [] });
    expect(companyFacts('What do I do right now?')).toEqual({ numbers: [] });
    expect(companyFacts('Draft a short update for our 3 beta users about what we are building')).toEqual({ numbers: [] });
    // Past figures and plans are not where the company stands.
    expect(companyFacts('Help me plan how we spend $300 on ads next week.').numbers).toEqual([]);
  });
});

// Review round 4: any monthly figure became the company's price and replaced the founder's own Price line.
describe('a price is the company\'s own', () => {
  it('takes no price from a competitor, a cost, a hire, a customer\'s words or a market range', () => {
    for (const said of ['Their price is $49/month.', "Our competitor's price is $49/month.", 'Competitors price at $49/month.', 'Our competitors price at $49/month.', 'Xero is priced at $49/month.', 'Our competitor charges $49/month.', 'we pay $40/month for hosting', 'Hiring a marketer costs €3,000/month.', "A customer wrote: I'd pay $15/month", 'Accountants cost €80–€200/month.'])
      expect(companyFacts(said).numbers.filter((one) => one.label === 'Price'), said).toEqual([]);
  });

  it('takes it when the company is the one charging', () => {
    for (const said of ['We charge $39/month.', 'Our price is $39/month.', 'We sell at $39 a month.', 'It is $39/month for our base plan.', 'We have 3 paying users and charge $39/month.', 'We charge customers $39/month.', 'For EU freelancers we charge $39/month.'])
      expect(companyFacts(said).numbers.filter((one) => one.label === 'Price'), said).toEqual([{ label: 'Price', value: expect.stringMatching(/^\$39/) }]);
  });

  it('never writes over a Price line the founder wrote themselves', () => {
    const mine = '# Company\n\n## Numbers\n\n- Price: $29/month, annual $290 (my note)\n';
    expect(keepFacts(mine, companyFacts('We charge $39/month now.'), '2026-09-28')).toEqual({ text: mine, kept: [] });
  });
});

// Final review, round 4: a passing remark became the Idea, revenue became the Price, and one bill became the Burn.
describe('only what the company is, charges and burns', () => {
  it('takes no idea from a remark, from money the company makes, and no customer from a length of time', () => {
    for (const said of ['This is a hard week.', 'It is a mess, cash is €3,000.', 'We make $300 a month.', 'Sales are slow and we make $300 MRR.'])
      expect(companyFacts(said).idea, said).toBeUndefined();
    expect(companyFacts('We are building this for the next 3 years.').customer).toBeUndefined();
    expect(companyFacts('We are building this for the next few months.').customer).toBeUndefined();
  });

  it('takes no price from money the company makes', () => {
    for (const said of ['We make $300 a month.', 'Sales are slow and we make $300 MRR.', 'We build websites and make $300 a month.'])
      expect(companyFacts(said).numbers.filter((one) => one.label === 'Price'), said).toEqual([]);
  });

  it('takes the burn only from burn, expenses or total spend, never from one bill', () => {
    for (const said of ['We spend $300/month on ads.', 'Hosting costs us $50/month.', 'We spend $40 a month for hosting.', 'Our burn includes $300/month on ads.'])
      expect(companyFacts(said).numbers.filter((one) => one.label === 'Burn'), said).toEqual([]);
    for (const said of ['We burn €1,100/month.', 'Monthly expenses are $2,000/month.', 'Our total spend is $2,000 a month.'])
      expect(companyFacts(said).numbers.filter((one) => one.label === 'Burn'), said).toHaveLength(1);
  });
});

// Journey 6: the name never reached the brief, and Numbers ended with the user count three times in three forms.
describe('the brief keeps the name and one row of users', () => {
  it('takes "<Name> is a … for …" as what the company does, under the Idea heading even when the brief only had a label', () => {
    const facts = companyFacts('Ledgerly is a $29/month bookkeeping tool for EU solo consultants. It drafts VAT returns from bank feeds.');
    expect(facts.idea).toBe('Ledgerly is a $29/month bookkeeping tool for EU solo consultants');
    expect(facts.customer).toBe('EU solo consultants');
    const seeded = '# Company brief\n\nEveryone on the stage reads this.\n\nWhat the company does:\n\nStage and goals this quarter:\n';
    expect(keepFacts(seeded, facts, '2026-09-27').text).toContain('## Idea\n\n- Ledgerly is a $29/month bookkeeping tool for EU solo consultants (founder, 2026-09-27)');
    for (const said of ['This is a hard week for us.', 'It is a tool for nobody yet.', 'Today is a good day for calls.']) expect(companyFacts(said).idea, said).toBeUndefined();
    // Hotfix review: a competitor or a day by its name is not the company, and the founder's own line wins.
    for (const said of ['Xero is a competitor for small firms.', 'Monday is a good day for calls.']) expect(companyFacts(said), said).toEqual({ numbers: [] });
    expect(companyFacts(`Xero is a bookkeeping tool for small firms. ${DAY_ONE}`).idea).toMatch(/^I'm building Ledgerly/);
    expect(companyFacts(DAY_ONE).idea).toMatch(/^I'm building Ledgerly/);
  });

  it('keeps one row for the paying users, whatever words they were counted in', () => {
    const doc = '# Company\n\n## Numbers\n\n- Paying beta users: 3 (founder, 2026-09-27)\n- 3 paying users\n- Customers: 3\n- Cash: €4,200 (founder, 2026-09-27)\n';
    const again = keepFacts(doc, companyFacts('We now have 5 paying users.'), '2026-09-30');
    expect(again.text.match(/users|customers/gi)).toHaveLength(1);
    expect(again.text).toContain('- Paying users: 5 (founder, 2026-09-30)\n- Cash: €4,200');
    // The same count said another way changes nothing.
    const once = keepFacts(companyTemplate(), companyFacts('We have 3 paying beta users.'), '2026-09-27').text;
    expect(keepFacts(once, companyFacts('We have 3 customers.'), '2026-09-28')).toEqual({ text: once, kept: [] });
    // A total, a waitlist, the churned, the active and a target are each their own row, never merged or removed.
    const others = '# Company\n\n## Numbers\n\n- Total users: 40\n- Waitlist users: 200\n- Churned customers: 1\n- Active users: 25\n- Interviewed customers: 12\n- Target 100 users by Dec\n- Paying users: 2 (founder, 2026-09-20)\n';
    const merged = keepFacts(others, companyFacts('We have 3 paying users.'), '2026-09-28').text;
    for (const row of ['- Total users: 40', '- Waitlist users: 200', '- Churned customers: 1', '- Active users: 25', '- Interviewed customers: 12', '- Target 100 users by Dec', '- Paying users: 3 (founder, 2026-09-28)']) expect(merged).toContain(row);
    expect(merged).not.toContain('Paying users: 2');
    // Free users are their own row.
    expect(keepFacts(once, companyFacts('We have 40 free users.'), '2026-09-28').text).toContain('- Paying beta users: 3 (founder, 2026-09-27)\n- Free users: 40 (founder, 2026-09-28)');
  });
});

// Journey 7: the Day-1 message left two users rows, "Paying beta users: 3" and "Users: 3", in the seeded brief.
describe('one users row from one message', () => {
  const J7 = "I'm building Ledgerly: $29/month bookkeeping and VAT return drafting for solo consultants in the EU. We have 3 paying beta users, "
    + 'and two of the three users asked for invoicing. I have €4,200 in the bank and burn €1,100/month. Tear it apart.';
  it('reads the count once, the first way it was said, and writes one row into the seeded brief', () => {
    expect(companyFacts(J7).numbers.filter((one) => /users/i.test(one.label))).toEqual([{ label: 'Paying beta users', value: '3', sure: true }]);
    const seeded = withSections(seedDocs['company-brief']);
    const { text, kept } = keepFacts(seeded, companyFacts(J7), '2026-09-27');
    expect(text.match(/^- .*users.*$/gim)).toEqual(['- Paying beta users: 3 (founder, 2026-09-27)']);
    expect(kept[0]).toBe('Numbers (Price $29/month, Paying beta users 3, Cash €4,200, Burn €1,100/month)');
    // Two counts of one kind in the same message never make two rows, even when the words differ.
    expect(keepFacts(seeded, { numbers: [{ label: 'Paying users', value: '3' }, { label: 'Users', value: '3' }] }, '2026-09-27').text.match(/^- .*users.*$/gim)).toHaveLength(1);
  });
});

// Journey 8: a target in a choice ("or wait until 10 paying users") replaced the real count of 3; the burn was written
// twice beside the partner's own row; the idea was written again at the foot of the document.
describe('only where the company stands now', () => {
  const BRIEF = '# Company brief\n\n## Idea\n\n- I\'m building Ledgerly: $29/month bookkeeping (founder, 2026-09-27)\n\n## Customer\n\n## Numbers\n\n- Paying beta users: 3 (founder, 2026-09-27)\n- Monthly burn: €1,100\n\n## Open questions\n';
  it('takes no count from a target, a condition, a choice or an answer to a question', () => {
    for (const said of ['Put a decision in my list: should I build invoicing this week? Options: build it now, or wait until 10 paying users. Then tell me what to do today.',
      'wait until 10 paying users', 'Raise once we reach 50 paying users.', 'Our goal is 100 customers.', 'Should we launch? Maybe at 20 users.', 'Build it now or at 10 paying users.'])
      expect(companyFacts(said).numbers, said).toEqual([]);
    const { text, kept } = keepFacts(BRIEF, companyFacts('Put a decision in my list: should I build invoicing this week? Options: build it now, or wait until 10 paying users. Then tell me what to do today.'), '2026-09-28');
    expect([text, kept]).toEqual([BRIEF, []]);
  });

  it('updates the count from a plain statement', () => {
    const { text } = keepFacts(BRIEF, companyFacts('we now have 4 paying users'), '2026-09-28');
    expect(text).toContain('- Paying users: 4 (founder, 2026-09-28)');
    expect(text).not.toContain('Paying beta users: 3');
  });

  it('never writes over a count row with a count said in passing', () => {
    expect(keepFacts(BRIEF, companyFacts('Two of the 5 paying users asked for invoicing.'), '2026-09-28').text).toBe(BRIEF);
  });

  it('never takes a target or a loan row for the figure now', () => {
    const doc = '# Company\n\n## Numbers\n\n- Revenue target: €10k\n- Bank loan: €5,000\n';
    const { text } = keepFacts(doc, companyFacts('MRR is €300 a month now. We have €2,000 in the bank.'), '2026-09-28');
    expect(text).toContain('- Revenue target: €10k\n- Bank loan: €5,000\n- MRR: €300 a month (founder, 2026-09-28)\n- Cash: €2,000 (founder, 2026-09-28)');
  });

  it('keeps one Burn row beside the partner\'s own, and never writes the idea twice', () => {
    const { text } = keepFacts(BRIEF, companyFacts("I'm building Ledgerly: $29/month bookkeeping. I burn €1,100/month."), '2026-09-28');
    expect(text.match(/burn/gi)).toHaveLength(1);
    expect(text.match(/Ledgerly/g)).toHaveLength(1);
    const moved = BRIEF.replace('## Idea\n\n- I\'m building Ledgerly: $29/month bookkeeping (founder, 2026-09-27)\n\n', '## Idea\n\n') + '\nI\'m building Ledgerly: $29/month bookkeeping\n';
    expect(keepFacts(moved, companyFacts("I'm building Ledgerly: $29/month bookkeeping."), '2026-09-28').text.match(/Ledgerly/g)).toHaveLength(1);
    const burnMoved = keepFacts(BRIEF, companyFacts('I burn €1,300/month now.'), '2026-09-28').text;
    expect(burnMoved.match(/burn/gi)).toHaveLength(1);
    expect(burnMoved).toContain('- Burn: €1,300/month (founder, 2026-09-28)');
  });
});

describe('keeping the Company document current', () => {
  it('writes Numbers, Idea and Customer into an empty document, and says what it kept', () => {
    const { text, kept } = keepFacts(companyTemplate(), companyFacts(DAY_ONE), '2026-09-27');
    expect(text).toContain('## Idea\n\n- I\'m building Ledgerly: $29/month bookkeeping for EU solo consultants that drafts VAT returns from bank feeds (founder, 2026-09-27)\n');
    expect(text).toContain('## Customer\n\n- EU solo consultants (founder, 2026-09-27)\n');
    expect(text).toContain('## Numbers\n\n- Price: $29/month (founder, 2026-09-27)\n- Paying beta users: 3 (founder, 2026-09-27)\n- Cash: €4,200 (founder, 2026-09-27)\n- Burn: €1,100/month (founder, 2026-09-27)\n');
    expect(kept).toEqual(['Numbers (Price $29/month, Paying beta users 3, Cash €4,200, Burn €1,100/month)', 'Idea', 'Customer']);
    expect(keptLine(kept)).toBe('*Kept in the Company document: Numbers (Price $29/month, Paying beta users 3, Cash €4,200, Burn €1,100/month), Idea, Customer.*');
  });

  it('puts a new figure in place of the old one, leaves one that did not change, and never writes over the founder\'s idea', () => {
    const first = keepFacts(companyTemplate(), companyFacts(DAY_ONE), '2026-09-27').text;
    const again = keepFacts(first, companyFacts('I have €3,900 in the bank now. We still charge $29/month. We are building an invoicing tool for freelancers.'), '2026-09-30');
    expect(again.text).toContain('- Cash: €3,900 (founder, 2026-09-30)');
    expect(again.text).not.toContain('€4,200');
    expect(again.text).toContain('- Price: $29/month (founder, 2026-09-27)');
    expect(again.text).toContain('Ledgerly');
    expect(again.text).not.toContain('invoicing tool for freelancers');
    expect(again.kept).toEqual(['Numbers (Cash €3,900)']);
    expect(keepFacts(again.text, companyFacts(DAY_ONE.replace('€4,200', '€3,900')), '2026-09-30').kept).toEqual([]);
  });
});

// Journey 5: "You have 4 months of runway" from €4,200 and €1,100 a month, which is 3.82: rounded toward the better side.
describe('runway said in months', () => {
  const NUMBERS = '- Cash: €4,200 (founder, 2026-09-27)\n- Burn: €1,100/month (founder, 2026-09-27)';
  it('puts the months to one decimal, rounded down, beside a runway rounded up', () => {
    expect(runwayFix('You have **4 months** of operational runway remaining (based on €4,200 in cash and a €1,100 monthly burn).', NUMBERS))
      .toBe('You have **4 months (3.8 months)** of operational runway remaining (based on €4,200 in cash and a €1,100 monthly burn).');
    expect(runwayFix('Risk: with the remaining 4 months of runway, coding first is the gamble.', NUMBERS)).toBe('Risk: with the remaining 4 months (3.8 months) of runway, coding first is the gamble.');
    expect(runwayFix('Runway: 3.9 months.', NUMBERS)).toBe('Runway: 3.9 months (3.8 months).');
  });

  it('leaves a right figure, a figure said as under, a longer one and months that are not runway alone', () => {
    for (const reply of ['A seed round takes 3 to 4 months, and you run out of cash first.', 'Net of MRR, net burn is €1,013, so runway is 4 months.', 'You have ~3.8 months of runway.', 'You have under 4 months of runway.', 'Runway is less than 4 months.', 'Ship the invoice feature in 4 months.', 'With revenue, runway is 5 months.', 'Runway: 3 months if burn rises.'])
      expect(runwayFix(reply, NUMBERS), reply).toBe(reply);
    expect(runwayFix('You have 4 months of runway.', '- Cash: €4,200')).toBe('You have 4 months of runway.');
    // With MRR in the Numbers, a runway worked on the net burn is right: 4,200 / (1,100 - 87) = 4.1.
    expect(runwayFix('You have 4 months of runway.', `${NUMBERS}\n- MRR: €87 (founder, 2026-09-27)`)).toBe('You have 4 months of runway.');
    expect(runwayFix('You have 5 months of runway.', `${NUMBERS}\n- MRR: €87 (founder, 2026-09-27)`)).toBe('You have 5 months of runway.');
  });

  // Journey 9: €9,800 over €1,650 is 5.94. "(5.9 months)" was pasted after a precondition, a scenario and a figure
  // the reply had already said.
  it('never pastes the months beside a bound, a new scenario, a comparison or a sentence that already says them', () => {
    const KINDLING = '- Cash: €9,800 (founder, 2026-09-27)\n- Burn: €1,650/month (founder, 2026-09-27)\n- Runway: 5.9 months';
    for (const reply of [
      '2. At least 6 months of runway (we have 5.9 months of runway at the current burn).',
      '- Precondition: at least 6 months of runway before you hire.',
      '**New runway:** **6.4 months**',
      'With the €19 tier and 2 more paying users, runway would be 6 months.',
      'At €1,500 burn, runway is 6 months.',
      'Runway goes from 5.9 months to 6 months with that cut.',
      'Today 5.9 vs 6 months after the cut in runway.',
      'You have 6 months (5.9 months) of runway.',
    ]) expect(runwayFix(reply, KINDLING), reply).toBe(reply);
    // The current figure rounded up is still put right, once.
    const once = runwayFix('You have 6 months of runway.', KINDLING);
    expect(once).toBe('You have 6 months (5.9 months) of runway.');
    expect(runwayFix(once, KINDLING)).toBe(once);
    // A figure that is not cash over burn rounded up (6.4 is not 5.94 rounded up) is not the current runway.
    expect(runwayFix('Your runway is 6.4 months.', KINDLING)).toBe('Your runway is 6.4 months.');
  });
});
