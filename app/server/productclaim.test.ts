import { describe, expect, it } from 'vitest';
import { answerQuestions, guardUnasked } from './partner/unasked.ts';
import { holdProductClaims, productTopic, unbackedProductClaims } from './productclaim.ts';

// Journey 18: the brief says what QuoteSnap does and nothing about phones, platforms or VAT.
const BRIEF = '## Product\nQuoteSnap turns a plumber\'s WhatsApp photos into written quotes.\n\n## Numbers\n- Price: €29 a month per plumber\n- Paying plumbers: 9';
const TOM = 'Hi, interesting. Two of my lads would use it too. Does it work with photos from my old Android phone? And can the quote show VAT separately? Tom';

describe('a claim about the product, held to the record', () => {
  it('finds the journey\'s yeses about Android and VAT, and the invented "iOS/web"', () => {
    expect(unbackedProductClaims('Yes, QuoteSnap works seamlessly with photos from any Android phone, so your lads can use it too.', [BRIEF, TOM])).toEqual(['Android']);
    expect(unbackedProductClaims('And yes, your quotes can show VAT separately in your own template.', [BRIEF, TOM])).toEqual(['VAT']);
    expect(unbackedProductClaims('Yes, works with any Android phone, VAT charged separately.', [BRIEF])).toEqual(['Android', 'VAT']);
    expect(unbackedProductClaims('It turns WhatsApp photos into quotes instantly from iOS/web.', [BRIEF])).toEqual(['iOS', 'the web']);
  });

  it('takes a claim the brief or a read states, and none that is a question, a no or a thing to check', () => {
    const brief = `${BRIEF}\n- Works on Android and iOS phones.\n- Quotes show VAT on its own line.`;
    expect(unbackedProductClaims('It works with photos from any Android phone.', [brief])).toEqual([]);
    expect(unbackedProductClaims('Your quotes show VAT separately.', [brief])).toEqual([]);
    expect(unbackedProductClaims('Does it work on Android?', [BRIEF])).toEqual([]);
    expect(unbackedProductClaims('I will check whether it works on Android and come back to you by Friday.', [BRIEF])).toEqual([]);
    expect(unbackedProductClaims('We have not tested old Android phones, and VAT lines are not built yet.', [BRIEF])).toEqual([]);
    // A no on record backs nothing; neither does the lead's question.
    expect(unbackedProductClaims('It works on Android.', [BRIEF, 'We have not tested old Android phones.', TOM])).toEqual(['Android']);
    // A platform named in passing is no claim about the product.
    expect(unbackedProductClaims('Tom has an old Android phone.', [BRIEF])).toEqual([]);
    expect(unbackedProductClaims('It turns WhatsApp photos into quotes.', [BRIEF])).toEqual([]);
  });

  it('finds integrations, compliance and terms of sale', () => {
    expect(unbackedProductClaims('It integrates with Xero, so invoices flow straight in.', [BRIEF])).toEqual(['working with Xero']);
    expect(unbackedProductClaims('We are fully GDPR compliant.', [BRIEF])).toEqual(['GDPR', 'compliance']);
    expect(unbackedProductClaims('You can cancel any time.', [BRIEF])).toEqual(['cancel any time']);
    expect(unbackedProductClaims('It works offline on site.', [BRIEF])).toEqual(['offline use']);
    expect(unbackedProductClaims('It works with WhatsApp.', [BRIEF])).toEqual([]);
  });

  it('takes the journey\'s promises out of an unasked reply and answers each question honestly', () => {
    const draft = 'Hi Tom,\n\nThanks for getting back to me. Yes, QuoteSnap works seamlessly with photos from any Android phone. And yes, your quotes can show VAT separately in your own template.\n\nBest,';
    const held = guardUnasked(draft, [BRIEF, TOM]);
    expect(held.text).not.toMatch(/Android|VAT/);
    expect(held.left).toEqual(expect.arrayContaining(['Android', 'VAT']));
    const built = answerQuestions(held.text, TOM, { name: 'Tom Becker', today: '2026-10-07' });
    expect(built.body).toContain('I will check whether it works with photos from your old Android phone and come back to you by Friday.');
    expect(built.body).toContain('I will check whether the quote can show VAT separately and come back to you by Friday.');
    expect(built.body.trim().endsWith('Best,')).toBe(true);
    // The honest lines pass the guard themselves.
    expect(guardUnasked(built.body, [BRIEF, TOM]).left).toEqual([]);
  });

  it('words a question about the product as a thing to check', () => {
    expect(productTopic('Does it work with photos from my old Android phone?')?.name).toBe('whether it works with photos from your old Android phone');
    expect(productTopic('Is it GDPR compliant?')?.name).toBe('whether it is GDPR compliant');
    expect(productTopic('Can we pay monthly?')).toBeNull();
  });

  it('holds a chat reply: a bracket holding the claim goes, a sentence holding one goes, and the reply says so', () => {
    const reply = 'I will discard that draft and rewrite it focusing only on what QuoteSnap currently does (turning WhatsApp photos into quotes instantly from iOS/web). My call: discard the draft.';
    const held = holdProductClaims(reply, [BRIEF]);
    expect(held.text).toContain('I will discard that draft and rewrite it focusing only on what QuoteSnap currently does. My call: discard the draft.');
    expect(held.text).not.toContain('iOS/web');
    expect(held.text).toContain('(left out: nothing on record says it about iOS, the web)');
    const plain = holdProductClaims('Yes, it works on any Android phone. Tom can start today.', [BRIEF]);
    expect(plain.text).toMatch(/^Tom can start today\./);
    const clean = 'QuoteSnap turns WhatsApp photos into quotes. We have not tested Android yet.';
    expect(holdProductClaims(clean, [BRIEF])).toEqual({ text: clean, left: [] });
  });
});
