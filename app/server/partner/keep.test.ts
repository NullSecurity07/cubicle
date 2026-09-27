import { describe, expect, it } from 'vitest';
import { companyTemplate } from '../../shared/partner.ts';
import { companyFacts, keepFacts, keptLine, runwayFix } from './keep.ts';

// Journey 4's first message, as the founder wrote it on Day 1.
export const DAY_ONE = "I'm building Ledgerly: $29/month bookkeeping for EU solo consultants that drafts VAT returns from bank feeds. "
  + 'We have 3 paying beta users; two of them asked for invoicing. I have €4,200 in the bank and burn €1,100/month. I\'m a solo technical founder. Tear it apart.';

describe('company facts in what the founder says', () => {
  it('reads the price, cash, burn, the users and the one line of what the company does', () => {
    expect(companyFacts(DAY_ONE)).toEqual({
      numbers: [
        { label: 'Price', value: '$29/month' },
        { label: 'Paying beta users', value: '3' },
        { label: 'Cash', value: '€4,200' },
        { label: 'Burn', value: '€1,100/month' },
      ],
      idea: "I'm building Ledgerly: $29/month bookkeeping for EU solo consultants that drafts VAT returns from bank feeds",
      customer: 'EU solo consultants',
    });
  });

  it('reads other ways of saying them, and nothing from a question with no facts', () => {
    expect(companyFacts('We charge €49 a month. Cash: $80k. Our total spend is $6,500 per month. 120 customers so far.').numbers).toEqual([
      { label: 'Price', value: '€49 a month' }, { label: 'Cash', value: '$80k' }, { label: 'Burn', value: '$6,500 per month' }, { label: 'Customers', value: '120' },
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
});
