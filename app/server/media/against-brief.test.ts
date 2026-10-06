import { describe, expect, it } from 'vitest';
import { answersItself, contradictions, factLine, factSteps, handsItToSomebody, productName } from './against-brief.ts';
import { criticise, repair, type Want } from './critic.ts';
import { aboutTheCompany, namesTheProduct } from './gather.ts';
import { productFacts, sourcesOf } from './grounding.ts';
import { factsIn } from './against-brief.ts';
import { LAYOUTS, type Spec } from './spec.ts';

// Journey 14: a film for Callback said staff reply by hand; the brief says Callback texts the caller back itself.
const BRIEF = [
  '# Company brief', '', 'Everyone on the stage reads this.', '',
  "What the company does: Callback turns a dental practice's voicemail into booked appointments. It transcribes each voicemail left after hours or while the front desk is busy, works out what the caller wants, and offers them a slot in the practice calendar by text message.",
  '', '## Idea', '', 'Dentists miss calls; patients leave voicemails nobody returns for hours, and many book elsewhere. Callback answers every voicemail with a booking offer by text within minutes.',
  '', '## Customer', '', 'Small independent dental practices (1-3 dentists) with one front-desk person.',
].join('\n');
const ASK = 'A 30 second explainer about voicemail chaos at a dental practice front desk: phones ringing, voicemails piling up, patients booking elsewhere. Use real footage clips.';
const material = { lines: [`Company brief:\n${BRIEF}`], assets: [], using: ['Company brief'] };
const sources = sourcesOf(material, ASK);

describe('a film held to what the brief says the product does', () => {
  it('reads the voicemail ask as an ask about the company, and a pottery film as not', () => {
    expect(namesTheProduct(ASK, productFacts(BRIEF))).toBe(true);
    expect(aboutTheCompany(ASK, { title: 'Company brief', text: BRIEF })).toBe(true);
    expect(aboutTheCompany('A 20 second documentary clip about a pottery class, with real photographs.', { title: 'Company brief', text: BRIEF })).toBe(false);
    expect(aboutTheCompany('A short film about a dental hygienist on her first day', { title: 'Company brief', text: BRIEF })).toBe(false);
  });

  it('knows the product answers the caller itself', () => {
    expect(productName(factsIn(sources))).toBe('Callback');
    const own = answersItself(factsIn(sources));
    expect(own.some((one) => one.includes('offers them a slot'))).toBe(true);
    expect(own.some((one) => one.startsWith('Dentists'))).toBe(false);
  });

  it('finds the journey\'s lines and steps, and leaves true ones alone', () => {
    expect(handsItToSomebody('Staff members send instant text message replies directly from the main dashboard.')).toBe(true);
    expect(handsItToSomebody('Tap quick reply button', true)).toBe(true);
    expect(handsItToSomebody('Send instant text message', true)).toBe(true);
    expect(handsItToSomebody('Patients book with the practice down the street.')).toBe(false);
    expect(handsItToSomebody('Our platform captures every missed call and converts voicemails into readable text.')).toBe(false);
    expect(handsItToSomebody('Book a free pilot')).toBe(false);
    expect(handsItToSomebody('Offers them a slot', true)).toBe(false);
    const scene = { layout: 'steps' as const, heading: 'How it works', say: 'Staff members send instant text message replies directly from the main dashboard.',
      bullets: ['Review transcribed messages', 'Tap quick reply button', 'Send instant text message'] };
    expect(contradictions(scene, factsIn(sources)).map((one) => one.line)).toEqual([scene.say, 'Tap quick reply button', 'Send instant text message']);
    // The product's own steps, written as orders, are not somebody doing it by hand.
    expect(contradictions({ layout: 'steps', heading: 'How it works', bullets: ['Transcribe each voicemail', 'Offer open slots', 'Book the patient'] }, factsIn(sources))).toEqual([]);
  });

  const want = (): Want => ({
    seconds: 30, pace: 'calm', purpose: 'explainer', captions: true, bible: 'quiet documentary photography',
    layouts: [...LAYOUTS], reel: false, product: true, sources,
  });
  const film: Spec = {
    title: 'Voicemail',
    scenes: [
      { layout: 'hook', text: 'Phones never stop', say: 'Dentists miss calls and patients book elsewhere.', source: 'Dentists miss calls' },
      { layout: 'steps', heading: 'How it works', say: 'Staff members send instant text message replies directly from the main dashboard.',
        bullets: ['Review transcribed messages', 'Tap quick reply button', 'Send instant text message'] },
      { layout: 'cta', text: 'Try Callback', say: 'Callback answers every voicemail with a booking offer by text within minutes.', source: 'Callback answers every voicemail' },
    ],
  };

  it('the critic says so, quoting the brief', () => {
    const found = criticise(film, want()).filter((one) => one.rule === 'contradicts');
    expect(found).toHaveLength(1);
    expect(found[0].scene).toBe(2);
    expect(found[0].says).toContain('Staff members send instant text');
    expect(found[0].says).toMatch(/brief says/);
  });

  it('the repair says what the brief says, with the product doing it', () => {
    const { spec, notes } = repair(film, want());
    const steps = spec.scenes.find((one) => one.heading === 'How it works' || one.bullets?.length);
    const said = spec.scenes.map((one) => one.say ?? '').join(' ');
    expect(said).not.toMatch(/staff members send/i);
    for (const scene of spec.scenes) expect(contradictions(scene, factsIn(sources))).toEqual([]);
    expect(notes.join(' ')).toMatch(/the way the brief says it does not/);
    expect(steps?.bullets?.join(' ') ?? '').not.toMatch(/tap|quick reply/i);
    expect(criticise(spec, want()).filter((one) => one.rule === 'contradicts')).toEqual([]);
  });

  it('a fact read back as a line and as steps', () => {
    const fact = answersItself(factsIn(sources)).find((one) => one.startsWith('It'))!;
    expect(factLine(fact, factsIn(sources))).toMatch(/^Callback transcribes each voicemail/);
    expect(factSteps(fact, factsIn(sources))).toEqual(['Transcribes each voicemail left', 'Works out what the caller wants', 'Offers them a slot']);
  });
});
