import { describe, expect, it } from 'vitest';
import { draftAsk, leadRecord, type Lead } from '../shared/leads.ts';
import { productLine, unbackedPersonal, usedSources } from './opener.ts';

const BRIEF = '# Company\n\n## Idea\n\nQuoteSnap turns a plumber\'s WhatsApp photos into written quotes. It saves the evening.\n\n## Numbers\n- Price: €29 a month';
const tom = (notes: string[] = []): Lead => ({
  id: 'l1', person: { name: 'Tom Becker', email: 'tom@becker.example' }, company: { name: 'Becker Sanitär' }, stage: 'new',
  notes: notes.map((text, at) => ({ at, by: 'founder', text })), source: 'founder', addedAt: 0, updatedAt: 0,
});
const row = (lead: Lead) => [{ label: "Tom Becker's row on the Leads card", text: leadRecord(lead) }];

describe('a first message, held to what is on record about the person', () => {
  it('finds the journey\'s invented Reddit comment, and lets a plain line about us through', () => {
    expect(unbackedPersonal('Hi Tom,\n\nI saw your comment on Reddit about spending your evenings after jobs writing up quotes in the van.', row(tom())))
      .toEqual(['I saw your comment on Reddit about spending your evenings after jobs writing up quotes in the van.']);
    expect(unbackedPersonal('QuoteSnap turns WhatsApp photos into written quotes. Would a short call help?', row(tom()))).toEqual([]);
    expect(unbackedPersonal('I noticed you run Becker Sanitär.', row(tom()))).toEqual([]);
    expect(unbackedPersonal('Congrats on the new van fleet!', row(tom()))).toHaveLength(1);
  });

  it('takes a detail their notes give, and names where it came from', () => {
    const lead = tom(['Commented on Reddit that he writes quotes in the van every evening.']);
    const body = 'Hi Tom,\n\nI saw your comment on Reddit about writing quotes in the van every evening. QuoteSnap turns WhatsApp photos into written quotes.';
    expect(unbackedPersonal(body, row(lead))).toEqual([]);
    expect(usedSources(body, row(lead), { label: 'Company brief', text: BRIEF })).toEqual(["(from: Tom Becker's row on the Leads card)", '(from: Company brief)']);
    // A detail the notes give, said to come from somewhere they do not name, is not theirs.
    expect(unbackedPersonal('I saw your post on LinkedIn about quotes in the van.', row(lead))).toHaveLength(1);
  });

  it('reads the brief\'s product line, and the ask says what is on record or that nothing is', () => {
    expect(productLine(BRIEF)).toBe('QuoteSnap turns a plumber\'s WhatsApp photos into written quotes.');
    expect(productLine('# Company\n\n## Idea\n\n## Numbers\n- x')).toBe('');
    expect(draftAsk(tom())).toContain('Nothing is on record about them beyond their name and company');
    expect(draftAsk(tom(['Met at the trade fair in Köln.']))).toContain('On record about them (their notes on the Leads card): Met at the trade fair in Köln.');
  });
});
