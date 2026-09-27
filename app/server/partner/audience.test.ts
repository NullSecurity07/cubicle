import { describe, expect, it } from 'vitest';
import { customerReply, forCustomers } from './audience.ts';

// Journey 5, Day 3: the beta-user update came back in the investor layout, source tags, "(founder to add)" and all.
const DRAFT = [
  'Here is a draft September update for your beta users:',
  '',
  '### September update',
  'We decided to build PDF invoicing first [Decisions], because two of you asked for it.',
  '',
  '### Numbers',
  '- Metrics card not wired.',
  '- Runway card not wired.',
  '- Cash: €4,200 in the bank, burning €1,100/month, about 3.8 months of runway.',
  '',
  '### Lowlights',
  '- No completed tasks shipped this period [Board].',
  '',
  '### Asks',
  '- (founder to add)',
  '',
  '(Note: Metrics, Runway, and Leads cards are not wired.)',
  '',
  'Ready to send: fill in any missing metrics, and send it to your beta users.',
].join('\n');
const NUMBERS = '- Cash: €4,200 (founder, 2026-09-27)\n- Burn: €1,100/month (founder, 2026-09-27)';

describe('a reply written for customers', () => {
  it('knows an ask whose readers are customers, users, beta users or subscribers', () => {
    for (const said of ['Draft a short update for our 3 beta users about what we are building', 'write the monthly email to my customers', 'Beta-user update please', 'Draft a note to all paying users about the price change', 'write a newsletter for our subscribers'])
      expect(forCustomers(said), said).toBe(true);
    for (const said of ['help me write an investor update', 'How many users do we need?', 'Draft the monthly email to investors', 'What do our customers want?'])
      expect(forCustomers(said), said).toBe(false);
  });

  it('takes out source tags, placeholders and notes about cards, and refuses to call it ready while cash, burn or runway are in it', () => {
    expect(customerReply(DRAFT, NUMBERS)).toBe([
      'Here is a draft September update for your beta users:',
      '',
      '### September update',
      'We decided to build PDF invoicing first, because two of you asked for it.',
      '',
      '### Numbers',
      '- Cash: €4,200 in the bank, burning €1,100/month, about 3.8 months of runway.',
      '',
      '### Lowlights',
      '- No completed tasks shipped this period.',
      '',
      'Not for customers: cash, burn, runway. Take them out before this goes to anyone outside the company.',
    ].join('\n'));
  });

  it('leaves a clean customer update as it is, ready claim and all', () => {
    expect(customerReply('# October update\n## Invoices\nComing next week [Board].\n## Asks\n- (founder to add)', NUMBERS)).toBe('# October update\n## Invoices\nComing next week.');
    const clean = 'Hi all,\n\nInvoices are coming next week: PDF, your VAT number on them, numbered for you.\n\nReady to send.';
    expect(customerReply(clean, NUMBERS)).toBe(clean);
    // The Company cash figure alone, with no word beside it, is still an internal figure.
    expect(customerReply('We are running on €4,200 and a lot of coffee. Ready to send.', NUMBERS)).toBe('We are running on €4,200 and a lot of coffee.\n\nNot for customers: cash. Take them out before this goes to anyone outside the company.');
  });
});
