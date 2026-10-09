import { describe, expect, it } from 'vitest';
import { repair, type Want } from './critic.ts';
import { LAYOUTS, type Scene, type Spec } from './spec.ts';
import { productFacts, sourcesOf } from './grounding.ts';
import { briefWants, closeLineOf, problemLine } from './close.ts';
import { bossy, freshHeadlines, offScript, phrasesOf } from './headlines.ts';
import { castFor, worldOf, type Visual } from './visuals.ts';
import { groundedFor } from './picture-policy.ts';
import { planPrompt, type Material } from './director.ts';

// Journey 20: "20 s explainer about our booking tool" for FixSlot, a pop-up repair café booking tool. The film showed
// dim rooms and people at windows, set "Explain FixSlot" and "Visit a repair café every week" as headlines, and
// closed on its problem: "People queue without knowing."
const BRIEF = [
  '# Company brief', '',
  'What the company does: FixSlot is a pop-up repair café booking tool for neighbourhoods: visitors book a repair slot online, the café sees who is coming with what.',
  '', 'How we work: two founders, small, ship weekly, visit a repair café every week.',
  '', '## Idea', '',
  'Neighbourhood repair cafés run pop-up evenings where volunteers fix toasters, bikes and clothes. Today people queue at the door and volunteers do not know what is coming. FixSlot lets a visitor book a slot and say what is broken; the café gets a list per volunteer.',
  '', '## Customer', '', 'Volunteer-run repair cafés and the community centres that host them.',
].join('\n');
const ASK = 'Explain FixSlot, a pop-up repair café booking tool for neighbourhoods that lets visitors book repair slots online and helps cafés know what is coming.';
const material = { lines: [`Company brief:\n${BRIEF}`], pitch: productFacts(BRIEF), assets: [], using: ['Company brief'] } as Material;
const want = (over: Partial<Want> = {}): Want => ({
  seconds: 20, pace: 'calm', purpose: 'explainer', captions: true, bible: 'a warm digital photograph, natural window light',
  layouts: [...LAYOUTS], reel: false, product: true, sources: sourcesOf(material, ASK), ...briefWants(material, ASK), ...over,
});
// The storyboard as journey 20's director wrote it, before the critic.
const STORYBOARD: Scene[] = [
  { layout: 'hook', text: 'People queue without knowing', say: 'Volunteers do not know what is coming.', source: 'Volunteers do not know what is coming.' },
  { layout: 'statement', text: 'Book slots online before arriving', say: 'Visitors book a repair slot online.', source: 'visitors book a repair slot online' },
  { layout: 'statement', text: 'Explain FixSlot', say: 'FixSlot is a pop-up repair café booking tool for neighbourhoods.', source: 'FixSlot is a pop-up repair café booking tool for neighbourhoods' },
  { layout: 'statement', text: 'Volunteers fix toasters, bikes and clothes', say: 'Volunteers fix toasters, bikes and clothes during pop-up evenings.', source: 'volunteers fix toasters, bikes and clothes' },
  { layout: 'statement', text: 'People queue at the door', say: 'Today people queue at the door without knowing.', source: 'Today people queue at the door' },
  { layout: 'cta', text: 'People queue without knowing', say: 'People queue without knowing.', source: 'People queue without knowing' },
];
const shown = (spec: Spec) => spec.scenes.flatMap((one) => [one.text, one.heading]).filter((one): one is string => !!one);

describe('a headline is a line of the film', () => {
  it('reads an order and the ask\'s own words as no headline', () => {
    expect(bossy('Visit a repair café every week')).toBe(true);
    expect(bossy('visit a repair café every week')).toBe(true);
    expect(bossy('Volunteers fix toasters')).toBe(false);
    expect(bossy('Visitors book a repair slot online')).toBe(false);
    expect(bossy('Nothing leaves the machine')).toBe(false);
    expect(offScript('Explain FixSlot')).toBe(true);
    expect(offScript('FixSlot')).toBe(true);
    expect(offScript('Visit a repair café every week', 'Visitors book a repair slot online.')).toBe(true);
    // An order the line itself gives is the line: "Book a slot" over "Book a slot and say what is broken".
    expect(offScript('Book a slot', 'Book a slot and say what is broken.')).toBe(false);
    expect(offScript('A list per volunteer', 'The café gets a list per volunteer.')).toBe(false);
  });

  it('never offers the team\'s habit or the ask as a phrase for a headline', () => {
    const phrases = phrasesOf(ASK, material.lines);
    const all = [...phrases.brief, ...phrases.lines].map((one) => one.toLowerCase());
    expect(all).not.toContain('explain fixslot');
    expect(all).not.toContain('visit a repair café every week');
  });

  it('takes "Explain FixSlot" and "Visit a repair café every week" off the frames', () => {
    const scenes: Scene[] = [
      { layout: 'statement', text: 'Visit a repair café every week', say: 'Visitors book a repair slot online.' },
      { layout: 'statement', text: 'Explain FixSlot', say: 'FixSlot is a pop-up repair café booking tool for neighbourhoods.' },
    ];
    const { scenes: made, notes } = freshHeadlines(scenes, true, phrasesOf(ASK, material.lines));
    const texts = made.map((one) => one.text ?? '');
    expect(texts).not.toContain('Visit a repair café every week');
    expect(texts).not.toContain('Explain FixSlot');
    for (const text of texts.filter(Boolean)) expect(offScript(text)).toBe(false);
    expect(notes.join(' ')).toContain('was not a line of the film');
  });

  it('runs the journey storyboard through the critic with no invented headline', () => {
    const { spec } = repair({ title: 'FixSlot Repair Cafes', scenes: STORYBOARD.map((one) => ({ ...one })) }, want());
    const lines = shown(spec);
    expect(lines).not.toContain('Explain FixSlot');
    expect(lines.join(' | ')).not.toMatch(/visit a repair café every week/i);
    for (const line of lines.slice(0, -1)) expect(offScript(line)).toBe(false);
  });
});

describe('a film ends on the product, never the problem', () => {
  it('finds the product\'s line in a pitch too long to close on, at the writer\'s own colon', () => {
    expect(closeLineOf(ASK, material)).toEqual({ line: 'FixSlot is a pop-up repair café booking tool for neighbourhoods', asked: false });
  });

  it('knows a problem line from a product line', () => {
    expect(problemLine('People queue without knowing.', 'FixSlot')).toBe(true);
    expect(problemLine('Volunteers do not know what is coming.', 'FixSlot')).toBe(true);
    expect(problemLine('FixSlot ends the queue at the door.', 'FixSlot')).toBe(false);
    expect(problemLine('Visitors book a repair slot online.', 'FixSlot')).toBe(false);
  });

  it('orders the journey storyboard problem, product, close and closes on the pitch', () => {
    const { spec, notes } = repair({ title: 'FixSlot Repair Cafes', scenes: STORYBOARD.map((one) => ({ ...one })) }, want());
    const says = spec.scenes.map((one) => one.say ?? '');
    expect(says.at(-1)).toBe('FixSlot is a pop-up repair café booking tool for neighbourhoods.');
    expect(problemLine(says.at(-1), 'FixSlot')).toBe(false);
    // Once the product is said, the film never goes back to the queue.
    const first = says.findIndex((one) => /\bbook|FixSlot\b/.test(one));
    expect(first).toBeGreaterThanOrEqual(0);
    for (const line of says.slice(first)) expect(problemLine(line, 'FixSlot')).toBe(false);
    expect(notes.join(' ')).toMatch(/problem/);
  });

  it('turns a close left on the problem into the product\'s line even when it names the brief', () => {
    const scenes: Scene[] = [
      { layout: 'hook', text: 'Nobody knows what is coming', say: 'Volunteers do not know what is coming.', source: 'volunteers do not know what is coming' },
      { layout: 'statement', text: 'Book a slot online', say: 'Visitors book a repair slot online.', source: 'visitors book a repair slot online' },
      { layout: 'cta', text: 'People queue at the door', say: 'People queue at the door.', source: 'people queue at the door' },
    ];
    const { spec } = repair({ title: 'FixSlot', scenes }, want());
    expect(spec.scenes.at(-1)!.say).toBe('FixSlot is a pop-up repair café booking tool for neighbourhoods.');
  });

  it('closes on the product\'s own line, not the model\'s shorthand for it', () => {
    // Journey 20's live rerun: the director closed on "Neighborhood repair booking tool".
    const scenes: Scene[] = [
      { layout: 'hook', text: 'FixSlot lets a visitor book a slot', say: 'FixSlot lets a visitor book a slot and say what is broken.', source: 'FixSlot lets a visitor book a slot and say what is broken' },
      { layout: 'statement', text: 'The café gets a list per volunteer', say: 'Volunteers fix toasters, bikes and clothes.', source: 'volunteers fix toasters, bikes and clothes' },
      { layout: 'cta', text: 'Neighborhood repair booking tool', say: 'Neighborhood repair booking tool.' },
    ];
    expect(repair({ title: 'FixSlot', scenes }, want()).spec.scenes.at(-1)!.say).toBe('FixSlot is a pop-up repair café booking tool for neighbourhoods.');
  });

  it('tells the director the order', () => {
    const prompt = planPrompt({ seconds: 20, purpose: 'explainer', audience: 'repair cafés', platform: 'the web', tone: 'calm', pace: 'calm', captions: true, pack: 'documentary' } as never, { brief: ASK } as never, material);
    expect(prompt).toMatch(/problem first, then what the product does about it, then the close/);
  });
});

describe('a product nobody can photograph is cast by what it does', () => {
  const shot = (line: string, scene: number, world: ReturnType<typeof worldOf>) =>
    groundedFor({ scene, take: 0, at: scene, line, subject: 'a man standing at a window in a dim room', kind: 'medium', room: 'foot' } as Visual, world).subject;

  it('casts a booking tool as the volunteer, the phone, the bench, the door and the booking card', () => {
    const world = worldOf('20 s explainer about our booking tool', productFacts(BRIEF));
    expect(world.cast).toEqual([
      'a volunteer at work in a pop-up repair café, turned away from the camera',
      "a close-up of a smartphone with a plain blank glowing screen in a volunteer's hand in a pop-up repair café",
      'a workbench in a pop-up repair café with a broken toaster on it, tools beside it',
      'a visitor at the door of a pop-up repair café, carrying a broken toaster',
      'a close-up of a plain white card with nothing on it, held in a hand',
      'a close-up of a broken bike',
      'a close-up of torn clothes',
    ]);
    // The ask written long, as Maya passed it to the studio, casts the same film.
    expect(worldOf(ASK, productFacts(BRIEF)).cast).toEqual(world.cast);
  });

  it('draws every line of the journey film as the cast, never the man at the window', () => {
    const world = worldOf('20 s explainer about our booking tool', productFacts(BRIEF));
    const drawn = STORYBOARD.map((one, index) => shot(one.say!, index, world));
    for (const subject of drawn) expect(subject).not.toMatch(/window|dim room/);
    expect(drawn[0]).toMatch(/^a volunteer at work/);
    expect(drawn[1]).toMatch(/smartphone with a plain blank glowing screen/);
    expect(drawn.join(' | ')).toMatch(/workbench|broken toaster/);
    expect(shot('The café gets a list per volunteer.', 7, world)).toMatch(/plain white card/);
    expect(castFor({ line: 'Visitors book a repair slot online.', scene: 1 } as Visual, world)).toMatch(/smartphone/);
  });

  it('casts a quote tool as the phone and the quote, as journey 18 did', () => {
    const facts = productFacts([
      "What the company does: QuoteSnap turns a plumber's WhatsApp photos of a job into a written quote they can send the customer.",
      '## Idea', "A plumber forwards the photos of a job (a leaking pipe, a boiler, a bathroom) from WhatsApp to QuoteSnap. QuoteSnap writes a quote: parts, hours, price, in the plumber's own template, ready to send.",
    ].join('\n'));
    const cast = worldOf('20 s explainer about our quote tool', facts).cast ?? [];
    expect(cast.some((one) => /smartphone/.test(one))).toBe(true);
    expect(cast.some((one) => /printed quote/.test(one))).toBe(true);
  });

  it('casts a delivery tool as the box and the door', () => {
    const facts = productFacts('What the company does: PetalRun is a delivery app for florists: customers order a bouquet and a courier brings it to the door the same day.');
    const cast = worldOf('20 s explainer about our delivery app', facts).cast ?? [];
    expect(cast.some((one) => /cardboard box/.test(one))).toBe(true);
    expect(cast.some((one) => /front door/.test(one))).toBe(true);
  });

  it('casts any other tool as somebody using a phone where it is used', () => {
    const facts = productFacts('What the company does: TallyBee is a stock-count tool for corner shops: shopkeepers count the shelves at closing time.');
    const cast = worldOf('20 s explainer about our stock-count tool', facts).cast ?? [];
    expect(cast.some((one) => /smartphone with a plain blank glowing screen/.test(one))).toBe(true);
  });
});
