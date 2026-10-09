import { describe, expect, it } from 'vitest';
import { answerQuestions, guardUnasked } from './partner/unasked.ts';
import { holdProductClaims, productClaimsIn, productTopic, unbackedProductClaims } from './productclaim.ts';

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

  it('passes journey 19\'s three honest answers to Tom: a line that says the answer is still to come claims nothing', () => {
    const sources = [BRIEF, TOM];
    // First try: one line for both questions.
    expect(productClaimsIn('Hi Tom,\n\nRegarding your old Android phone and VAT separately: I will check on those details and come back to you.\n\nBest,\nAlex Hart', sources)).toEqual([]);
    // Second try, after the founder's Allow: the questions named first, the promise to check after.
    expect(productClaimsIn('Thanks for your questions about photos from your old Android phone and showing VAT separately. I will check on both and come back to you by Tuesday.', sources)).toEqual([]);
    // Third try: each question quoted with its own line.
    expect(productClaimsIn('"Does it work with photos from my old Android phone?" I will check and come back to you.\n"Can the quote show VAT separately?" I will check and come back to you.', sources)).toEqual([]);
    for (const line of ['I don\'t know yet about Android.', 'Let me confirm the VAT part and get back to you.']) expect(productClaimsIn(line, sources)).toEqual([]);
    // A clause that says the product does it is still a claim, honest words elsewhere or not.
    expect(productClaimsIn('It works on any Android phone, and I will check the VAT part.', sources)).toEqual(['Android']);
    expect(productClaimsIn('Yes, the quote shows VAT separately; I will confirm the layout.', sources)).toEqual(['VAT']);
  });

  // Journey 20: Sam's ready reply to Ines invented a web app and a refund policy.
  const FIXSLOT = 'What the company does: FixSlot is a pop-up repair café booking tool for neighbourhoods: visitors book a repair slot online, the café sees who is coming with what.\n\n## Numbers\n- Price: €4 per booking';
  const INES = 'Our Thursday evenings are chaos. Is there an iOS app for our volunteers? If a visitor cancels, do they get the €4 back?';

  it('takes out journey 20\'s "web-based ... any browser" and "non-refundable", and answers each question honestly', () => {
    const web = 'We do not have an iOS app for volunteers; FixSlot is web-based and works on any phone or tablet browser so volunteers can view the list without downloading an app.';
    const refund = 'If a visitor cancels, the €4 booking fee is non-refundable.';
    expect(unbackedProductClaims(web, [FIXSLOT, INES])).toEqual(['the browser', 'the web', 'no app needed']);
    expect(unbackedProductClaims(refund, [FIXSLOT, INES])).toEqual(['our refund policy']);
    const draft = `Hi Ines,\n\nThanks for getting in touch. To answer your questions:\n\n${web}\n\n${refund}\n\nBest,`;
    const held = guardUnasked(draft, [FIXSLOT, INES]);
    expect(held.text).not.toMatch(/web-based|browser|refundable/);
    expect(held.left).toEqual(expect.arrayContaining(['the web', 'the browser', 'no app needed', 'our refund policy']));
    const built = answerQuestions(held.text, INES, { name: 'Ines Vogel', today: '2026-10-07' });
    expect(built.body).toContain('I will check whether there is an iOS app for your volunteers and come back to you by Friday.');
    expect(built.body).toContain('I will check our refund policy and come back to you by Friday.');
    expect(guardUnasked(built.body, [FIXSLOT, INES]).left).toEqual([]);
  });

  it('holds policy, fee, pricing and where-it-runs words however they are said', () => {
    const none = [FIXSLOT];
    expect(unbackedProductClaims('The booking fee is not refundable.', none)).toEqual(['our refund policy']);
    expect(unbackedProductClaims('Visitors can cancel for free up to a day before.', none)).toEqual(['our cancellation policy']);
    expect(unbackedProductClaims('It runs in any browser, no app needed.', none)).toEqual(['the browser', 'no app needed']);
    expect(unbackedProductClaims('It is available on the App Store.', none)).toEqual(['App Store']);
    expect(unbackedProductClaims('It works offline.', none)).toEqual(['offline use']);
    expect(unbackedProductClaims('Every café starts on a free trial, billed monthly after.', none)).toEqual(['free trial', 'billed monthly']);
    // Said on record, either way, it stands; said as undecided or still to check, it claims nothing.
    expect(unbackedProductClaims('The booking fee is non-refundable.', [`${FIXSLOT}\n- Bookings are not refundable.`])).toEqual([]);
    expect(unbackedProductClaims('It runs in any browser.', [`${FIXSLOT}\n- Runs in any browser, nothing to install.`])).toEqual([]);
    expect(unbackedProductClaims('We have not decided a refund policy yet.', none)).toEqual([]);
    expect(unbackedProductClaims('I will check our refund policy and come back to you by Friday.', none)).toEqual([]);
    expect(productTopic('If a visitor cancels, do they get the €4 back?')?.name).toBe('our refund policy');
    expect(productTopic('Is there a cancellation fee?')?.name).toBe('our cancellation policy');
  });
});
