import { describe, expect, it } from 'vitest';
import {
  afforded, aboutTheLine, criticiseVisuals, drawnAs, fillerShot, kindFor, lineUnder, photoOfTheLine, repairVisuals, sceneLine, stockQueries, thingsOf, topicOf,
  shareOut, shares, slotsFor, somebodyIn, unlettered, visualFrom, visualsOf, visualsPrompt, type Visual, shotKey,
  closeHolds, settingOf, standInOf, worldOf, worldScore,
} from './visuals.ts';
import { productFacts } from './gather.ts';
import { foreignIn } from './places.ts';
import type { Scene } from './spec.ts';

const BIBLE = 'bright high-contrast editorial photography, clean directional key light, shot on 35mm';

const one = (at: number, subject: string, line: string, extra: Partial<Visual> = {}): Visual => ({
  at, scene: at, take: 0, line, subject, kind: 'medium', room: 'foot', ...extra,
});

describe('what may not be in a picture', () => {
  it('names the stock shot a picture model reaches for when it has been told nothing', () => {
    // Every one of these was on a real film this studio made, and five frames of one reel were the first.
    expect(fillerShot('a hand holding a phone filming a street at night')).toBe('hand holding a phone');
    expect(fillerShot('an open laptop on a desk beside a coffee cup')).toMatch(/laptop/);
    expect(fillerShot('a partner sliding one sheet of paper back across a table')).toBeNull();
  });

  it('lets a line that really is about a phone have a phone in it', () => {
    const found = criticiseVisuals([one(0, 'a hand holding a phone at arm\'s length', 'the phone in your pocket is the whole studio')]);
    expect(found.some((note) => note.rule === 'filler')).toBe(false);
  });

  it('takes the writing out rather than asking for none of it', () => {
    // A picture model cannot write and has no negative prompt, so "no text" summons text. The only thing that
    // works is never naming the surfaces that carry words.
    expect(unlettered('a founder reading a pitch deck slide in an empty room')).toBe('a founder reading a pitch in an empty room');
    expect(unlettered('a wooden sign reading Open at the door')).not.toMatch(/reading|sign/i);
    // A verb with nothing literal after it is somebody doing something, and stays.
    expect(unlettered('a partner reading across a table')).toBe('a partner reading across a table');
    expect(unlettered('a bare table by a window')).toBe('a bare table by a window');
  });
});

describe('is this picture of what is being said', () => {
  it('counts what two subjects share', () => {
    expect(shares('a founder at a table', 'a founder at a desk')).toBeGreaterThanOrEqual(0.5);
    expect(shares('a founder at a table', 'rain on a loading bay')).toBe(0);
  });

  it('passes a picture that uses one of the line\'s own words, or declares what it stands for', () => {
    expect(aboutTheLine(one(0, 'a partner reading a summary', 'investors read the summary first'))).toBe(true);
    expect(aboutTheLine(one(0, 'rain filling a gutter', 'investors read the summary first'))).toBe(false);
    // A stand-in says which of the line's words it stands for. One that names none of them ("money running away" under
    // a line about investors) is the pocket watch under "nothing leaves your computer": a picture of something else.
    expect(aboutTheLine(one(0, 'rain filling a gutter', 'investors read the summary first', { metaphor: 'what investors lose while they read' }))).toBe(true);
    expect(aboutTheLine(one(0, 'rain filling a gutter', 'investors read the summary first', { metaphor: 'money running away' }))).toBe(false);
  });
});

describe('the critic', () => {
  const film: Visual[] = [
    one(0, 'a partner sliding one sheet back across a bare table', 'investors want proof'),
    one(1, 'a partner pushing a sheet across a table', 'most founders never get a second meeting', { kind: 'wide' }),
    one(2, 'a hand holding a phone filming a street', 'the numbers have to be yours', { kind: 'detail' }),
    one(3, 'a whiteboard covered in figures', 'forty per cent never make it', { kind: 'object' }),
  ];

  it('catches the same picture twice, the generic one and the one asking for writing', () => {
    const found = criticiseVisuals(film);
    expect(found.map((note) => note.rule)).toEqual(expect.arrayContaining(['same', 'filler', 'lettering']));
  });

  it('catches a film framed the same way from end to end', () => {
    const flat = film.map((visual) => ({ ...visual, kind: 'medium' as const }));
    expect(criticiseVisuals(flat).some((note) => note.rule === 'framing')).toBe(true);
  });

  it('says nothing about a film whose pictures are all different and all of their own lines', () => {
    const good: Visual[] = [
      one(0, 'a partner sliding one sheet back across a bare table', 'investors want proof', { metaphor: 'proof handed over and handed back' }),
      one(1, 'rain running off a loading bay at dusk', 'most founders never get a second meeting', { kind: 'wide', metaphor: 'the meeting ending' }),
      one(2, 'a kettle boiling dry on a cold ring', 'the money runs out quietly', { kind: 'detail', metaphor: 'money running out' }),
    ];
    expect(criticiseVisuals(good)).toEqual([]);
  });
});

describe('putting it right without asking anybody', () => {
  it('replaces every fault with a picture built out of the line itself, and keeps what was fine', () => {
    const { visuals, notes } = repairVisuals([
      one(0, 'a partner sliding one sheet back across a bare table', 'investors want proof', { metaphor: 'proof handed back' }),
      one(1, 'a hand holding a phone filming a street', 'most founders never get a second meeting'),
      one(2, 'a partner sliding a sheet across a table', 'the money runs out quietly', { kind: 'detail' }),
    ]);
    expect(visuals[0].subject).toBe('a partner sliding one sheet back across a bare table');
    expect(criticiseVisuals(visuals).filter((note) => note.rule !== 'framing')).toEqual([]);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('builds the same picture from the same line every time', () => {
    const line = 'most founders never get a second meeting';
    expect(visualFrom(line, 2, new Set())).toBe(visualFrom(line, 2, new Set()));
  });

  it('never reuses a word it has already built a picture out of', () => {
    const used = new Set<string>();
    const first = visualFrom('the money runs out quietly', 0, used);
    const second = visualFrom('the money runs out slowly', 1, used);
    expect(first).not.toBe(second);
    expect(shares(first, second)).toBeLessThan(0.5);
  });
});

describe('the shot list, before anything is drawn', () => {
  const scenes = [
    { layout: 'hook', text: 'Investors want proof', say: 'Investors want proof.' },
    { layout: 'checklist', bullets: ['One', 'Two'], say: 'Two things matter.' },
  ] as Scene[];

  it('assigns the framing rather than asking for it, so a short film has several', () => {
    const kinds = new Set([0, 1, 2, 3, 4, 5].map((at) => kindFor(at, 'statement')));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });

  it('gives a frame already full of words something quiet behind them', () => {
    expect(['detail', 'environment']).toContain(kindFor(1, 'checklist'));
  });

  it('numbers one slot a shot and carries the phrase said under it', () => {
    const slots = slotsFor([
      { scene: 0, take: 0, line: 'Investors want proof', layout: 'hook' },
      { scene: 0, take: 1, line: 'and they want it fast', layout: 'hook' },
      { scene: 1, take: 0, line: 'Two things matter', layout: 'checklist' },
    ], true, scenes);
    expect(slots.map((one) => one.at)).toEqual([0, 1, 2]);
    expect(slots[1].take).toBe(1);
    expect(slots.every((one) => one.room !== 'none')).toBe(true);
  });
});

describe('the words a picture model is handed', () => {
  it('puts the film\'s own look first and asks for nothing written', () => {
    const drawn = drawnAs(one(0, 'a founder reading a report at a bare table', 'the numbers have to be yours'), BIBLE);
    expect(drawn.startsWith(BIBLE)).toBe(true);
    expect(drawn).not.toMatch(/report|no text|lettering/i);
    expect(drawn).toContain('turned away from the camera');
  });

  it('composes a hole where the words are going to sit', () => {
    expect(drawnAs(one(0, 'a kettle boiling dry', 'it runs out quietly', { room: 'foot' }), BIBLE)).toContain('lower third');
    expect(drawnAs(one(0, 'a kettle boiling dry', 'it runs out quietly', { room: 'top' }), BIBLE)).toContain('upper third');
  });

  it('puts a scene asking to be drawn back into the film it belongs to', () => {
    expect(drawnAs(one(0, 'a cartoon of a founder at a table', 'founders sit alone'), BIBLE)).not.toMatch(/cartoon/i);
  });
});

describe('what the film can afford', () => {
  it('draws one a shot away from this machine and rations them on it', () => {
    expect(afforded(11, false)).toBe(11);
    expect(afforded(11, true)).toBeLessThan(11);
    expect(afforded(11, true)).toBeGreaterThanOrEqual(2);
  });

  it('gives the opening its own picture and shares the rest out by length', () => {
    const owners = shareOut([2, 1.4, 3.8, 1.3, 2.2], 3);
    expect(owners).toHaveLength(5);
    expect(owners[0]).toBe(0);
    expect(new Set(owners).size).toBe(3);
  });

  it('draws a draft on four pictures at the most, and on three when this computer has to draw them', () => {
    expect(afforded(11, false, 8, true)).toBe(4);
    expect(afforded(11, true, 8, true)).toBe(3);
    expect(afforded(3, true, 8, true)).toBe(3);
  });

  it('never throws away a picture that is already being drawn to draw its neighbour instead', () => {
    // Against the guessed cut the third shot was the long one. Measured, the fourth is — but the third is paid for.
    const owners = shareOut([2, 1.4, 1.3, 3.8, 2.2], 3, new Set([0, 2]));
    expect(owners[0]).toBe(0);
    expect(owners[2]).toBe(2);
    expect(new Set(owners).size).toBe(3);
    expect(new Set(owners).has(3)).toBe(true);
    // And when more are under way than the measured cut would have asked for, every one of them is still used.
    expect(new Set(shareOut([2, 2, 2, 2], 2, new Set([0, 1, 3]))).size).toBe(3);
    // A shot keeps its name across two cuts: which scene, which take.
    expect(shotKey({ scene: 2, take: 1 })).toBe('2:1');
  });

  it('gives every shot its own picture when there is room for one', () => {
    expect(shareOut([2, 2, 2], 5)).toEqual([0, 1, 2]);
  });
});

describe('the phrase under one shot', () => {
  const words = [
    { word: 'investors', at: 0, seconds: 0.5 }, { word: 'want', at: 0.5, seconds: 0.3 },
    { word: 'proof', at: 0.8, seconds: 0.4 }, { word: 'never', at: 2.0, seconds: 0.3 },
    { word: 'promises', at: 2.3, seconds: 0.6 },
  ];

  it('takes the words whose middle falls inside the shot', () => {
    expect(lineUnder(words, 0, 1.4, 'the whole line')).toBe('investors want proof');
    expect(lineUnder(words, 1.9, 3, 'the whole line')).toBe('never promises');
  });

  it('gives a film nobody narrates the words on its screen as each shot\'s line', () => {
    expect(sceneLine({ say: ' Investors want proof. ', text: 'Proof' })).toBe('Investors want proof.');
    expect(sceneLine({ heading: 'Clay', text: 'A pottery class' })).toBe('Clay. A pottery class');
    expect(sceneLine(undefined)).toBe('');
    // The silent film's picture is held to its words: hand washing is not a pottery class.
    const line = lineUnder([], 0, 3, sceneLine({ text: 'A pottery class' }));
    expect(photoOfTheLine('Soap bubbles gather pair hands', { line })).toBe(false);
    expect(photoOfTheLine('Pottery class at the community centre', { line })).toBe(true);
  });

  it('falls back to the scene\'s own line when the shot lands in a gap', () => {
    expect(lineUnder(words, 1.4, 1.9, 'the whole line')).toBe('the whole line');
  });
});

describe('asking the model', () => {
  it('lists every moment with its framing and the line said over it', () => {
    const prompt = visualsPrompt(slotsFor([{ scene: 0, take: 0, line: 'Investors want proof', layout: 'hook' }], true,
      [{ layout: 'hook', text: 'Investors want proof' } as Scene]), BIBLE, 'proof beats promises');
    expect(prompt).toContain('Investors want proof');
    expect(prompt).toContain('proof beats promises');
    expect(prompt).toContain(BIBLE);
  });

  it('reads an answer back onto the slots, whatever order it came in', () => {
    const slots = slotsFor([
      { scene: 0, take: 0, line: 'one', layout: 'hook' },
      { scene: 1, take: 0, line: 'two', layout: 'statement' },
    ], false, [{ layout: 'hook' } as Scene, { layout: 'statement' } as Scene]);
    const read = visualsOf({ pictures: [{ at: 2, subject: 'the second picture' }, { at: 1, subject: 'the first picture' }] }, slots);
    expect(read[0].subject).toBe('the first picture');
    expect(read[1].subject).toBe('the second picture');
  });

  it('leaves a slot empty rather than inventing one, so the repair builds it', () => {
    const slots = slotsFor([{ scene: 0, take: 0, line: 'one', layout: 'hook' }], false, [{ layout: 'hook' } as Scene]);
    expect(visualsOf({}, slots)[0].subject).toBe('');
  });
});

describe('a film has one person in it', () => {
  it('reads somebody off the words a picture was written from', () => {
    expect(somebodyIn('a partner sliding one sheet across a table')).toBe('partner');
    expect(somebodyIn('rain running off a loading bay at dusk')).toBeNull();
  });

  it('catches the second one, because in a fixed look it is the same stranger', () => {
    const found = criticiseVisuals([
      one(0, 'a partner sliding one sheet across a bare table', 'investors want the partner to see proof'),
      one(1, 'a founder waiting in a stairwell', 'a founder waits months for an answer', { kind: 'wide' }),
      one(2, 'rain filling a gutter at dusk', 'the rain never stops', { kind: 'detail' }),
    ]);
    expect(found.filter((note) => note.rule === 'crowd').map((note) => note.at)).toEqual([1]);
  });

  it('turns every later one into the place it was set in', () => {
    const { visuals } = repairVisuals([
      one(0, 'a partner sliding one sheet across a bare table', 'investors want the partner to see proof'),
      one(1, 'a founder waiting in a cold stairwell', 'a founder waits months for an answer', { kind: 'medium' }),
    ]);
    expect(somebodyIn(visuals[0].subject)).not.toBeNull();
    expect(somebodyIn(visuals[1].subject)).toBeNull();
    expect(visuals[1].kind).toBe('environment');
  });

  it('only writes the clause that invites a person onto the picture allowed one', () => {
    const withOne = drawnAs(one(0, 'a partner sliding one sheet across a table', 'investors want proof'), BIBLE);
    const without = drawnAs(one(0, 'rain filling a gutter at dusk', 'the rain never stops'), BIBLE);
    expect(withOne).toContain('turned away from the camera');
    expect(without).not.toContain('turned away from the camera');
  });
});

describe('a glyph is lettering too', () => {
  it('strikes the symbols a picture model draws as characters', () => {
    expect(unlettered('a huge question mark painted on a beige wall')).not.toMatch(/question mark/i);
    expect(unlettered('an arrow icon over a bare desk')).not.toMatch(/icon/i);
  });
});

describe('a shot that lands in the middle of a sentence', () => {
  it('is judged against the sentence it came out of, not only the fragment on it', () => {
    // A real run threw a good picture away over the fragment "sales. Prove customers", which has two words in it
    // and no room to be wrong about.
    const fragment = one(0, 'a partner sliding one sheet back across a bare table', 'sales. Prove customers',
      { about: 'Show them the sales, and prove the customers came back to the table.' });
    expect(aboutTheLine(fragment)).toBe(true);
    expect(criticiseVisuals([fragment]).some((note) => note.rule === 'unrelated')).toBe(false);
  });

  it('still asks for a stand-in where neither the fragment nor the sentence is in the picture', () => {
    expect(aboutTheLine(one(0, 'rain filling a gutter', 'sales. Prove customers',
      { about: 'Show them the sales, and prove the customers came back.' }))).toBe(false);
  });

  it('carries the sentence onto every slot of a scene', () => {
    const slots = slotsFor([
      { scene: 0, take: 0, line: 'Investors want', layout: 'hook' },
      { scene: 0, take: 1, line: 'proof, not promises', layout: 'hook' },
    ], true, [{ layout: 'hook', say: 'Investors want proof, not promises.' } as Scene]);
    expect(slots.every((slot) => slot.about === 'Investors want proof, not promises.')).toBe(true);
  });
});

describe('the framing is where a person really gets in', () => {
  const scenes = Array.from({ length: 8 }, () => ({ layout: 'statement', say: 'a line is said here.' } as Scene));
  const slots = Array.from({ length: 8 }, (_one, at) => ({ scene: at, take: 0, line: 'a line is said here', layout: 'statement' as const }));

  it('frames exactly one shot in a film as a person, however long the film is', () => {
    const made = slotsFor(slots, true, scenes);
    expect(made.filter((one) => one.kind === 'medium')).toHaveLength(1);
  });

  it('still cuts between distances with the rest', () => {
    const made = slotsFor(slots, true, scenes);
    expect(new Set(made.map((one) => one.kind)).size).toBeGreaterThanOrEqual(3);
  });

  it('only the person framing says there is a person in the frame', () => {
    const person = drawnAs(one(0, 'a founder waiting for an answer', 'the wait is the hard part', { kind: 'medium' }), BIBLE);
    expect(person).toMatch(/one person at work/);
    for (const kind of ['wide', 'detail', 'object', 'environment'] as const) {
      expect(drawnAs(one(0, 'a cold kettle on a ring', 'it runs out quietly', { kind }), BIBLE), kind).not.toMatch(/\bperson\b/);
    }
  });
});

describe('the size and the lens the storyboard chose', () => {
  it('frames a scene\'s first shot at the size it was given, and lets its later shots keep the deal', () => {
    const scenes: Scene[] = [{ layout: 'picture', image_prompt: 'a kettle', shot: 'ecu', lens: 135 }];
    const made = slotsFor([
      { scene: 0, take: 0, line: 'it runs out quietly', layout: 'picture' },
      { scene: 0, take: 1, line: 'and nobody notices', layout: 'picture' },
    ], false, scenes);
    expect(made[0]).toMatchObject({ kind: 'detail', size: 'ecu', lens: 135 });
    expect(made[1].size).toBeUndefined();
    expect(made[1].lens).toBeUndefined();
    // A wide size keeps a dealt framing of the same family.
    const wide = slotsFor([{ scene: 0, take: 0, line: 'one', layout: 'picture' }, { scene: 1, take: 0, line: 'two', layout: 'picture' }], false,
      [{ layout: 'picture', image_prompt: 'x' }, { layout: 'picture', image_prompt: 'y', shot: 'ews' }]);
    expect(wide[1].kind).toBe('environment');
  });

  it('says the lens in the picture\'s words, and drops it once the shot has been re-framed', () => {
    const close = drawnAs(one(0, 'a cold kettle on a ring', 'it runs out quietly', { kind: 'detail', size: 'ecu', lens: 135 }), BIBLE);
    expect(close).toContain('an extreme close-up, shallow depth of field, compressed background:');
    const wide = drawnAs(one(0, 'an empty loading bay', 'it runs out quietly', { kind: 'wide', size: 'ws', lens: 35 }), BIBLE);
    expect(wide).toContain('wide view, deep focus:');
    const fifty = drawnAs(one(0, 'a bench by a station', 'it runs out quietly', { kind: 'medium', size: 'ms', lens: 50 }), BIBLE);
    expect(fifty).not.toMatch(/depth of field|deep focus/);
    // A close-up that was stepped back to a wide keeps none of its close-up words.
    const moved = drawnAs(one(0, 'a cold kettle on a ring', 'it runs out quietly', { kind: 'wide', size: 'cu', lens: 85 }), BIBLE);
    expect(moved).not.toMatch(/shallow depth|close-up/);
  });
});

// Journey 12: the director's subjects for number lines were "an eighty beside a seven, on a linen cloth" and "a
// thousand beside euros, on a stone step", and Openverse answered with a Klondike scan of fish and a Euromaidan photo.
describe('photographs asked for by the things a line names', () => {
  const topic = topicOf('A 20 second documentary clip about a pottery class, with real photographs.');
  const cash = { line: 'Seven thousand two hundred euros in cash.', subject: 'an eighty beside a seven, on a linen cloth' };
  const mrr = { line: 'We have reached eighty seven euros MRR.', subject: 'a thousand beside euros, on a stone step' };
  const clay = { line: 'Wet hands find the shape of a bowl on the wheel.', subject: 'wet hands shaping a clay bowl on a potter\'s wheel' };

  it('reads the film\'s topic out of the brief', () => {
    expect(topic).toEqual(['pottery', 'class']);
  });

  it('never asks a library for a number, a sum or a date', () => {
    expect(thingsOf(cash.line)).not.toEqual(expect.arrayContaining(['seven', 'thousand', 'euros']));
    for (const query of [...stockQueries(cash, topic), ...stockQueries(mrr, topic)]) {
      expect(query).not.toMatch(/\b(?:seven|eighty|thousand|hundred|euros?|mrr|linen|stone)\b/);
    }
    expect(stockQueries(mrr, topic)).toEqual(['pottery class']);
    expect(stockQueries(clay, topic)).toEqual(['hands pottery', 'pottery class']);
  });

  it('refuses a photograph that shares no thing with the line or the topic', () => {
    expect(photoOfTheLine("scanned image from 'On the Cars and Off ... Klondike' seven fish", cash, topic)).toBe(false);
    expect(photoOfTheLine('Kyiv, Euro Maidan 2013 euro protest', mrr, topic)).toBe(false);
    expect(photoOfTheLine('Pottery class at the community centre', mrr, topic)).toBe(true);
    // A line of nothing but numbers, in a film with no topic, is drawn rather than photographed.
    expect(photoOfTheLine('seven fish', { line: 'Seven thousand two hundred.' })).toBe(false);
  });
});

// Journey 13: "Kuay Makuach, farmer, Lankien, South Sudan" sat in a film about a farmers market, because "farmer" was
// one of the film's two words.
describe('photographs of the whole topic, and of nowhere the brief never went', () => {
  const brief = 'A 20 second documentary about a farmers market, with real footage clips of the stalls.';
  const topic = topicOf(brief);
  const question = { line: 'Why do grocery tomatoes taste like water?' };

  it('takes a two-word topic whole, not one word of it', () => {
    expect(topic).toEqual(['farmers', 'market']);
    expect(photoOfTheLine('Kuay Makuach, farmer, Lankien', question, topic, brief)).toBe(false);
    expect(photoOfTheLine("Arcata Farmer's Market", question, topic, brief)).toBe(true);
    expect(photoOfTheLine('Tomatoes at a market stall', question, topic, brief)).toBe(true);
    // A line's thing alone is not enough beside a two-word topic: a concert crowd is not a market crowd.
    expect(photoOfTheLine('DJ Snake looking down to the crowd', { line: 'You plan a stop, avoiding crowds.' }, topic, brief)).toBe(false);
  });

  it('refuses a picture of a country, a city or a news day the brief does not name', () => {
    expect(photoOfTheLine('Kuay Makuach, farmer, Lankien, South Sudan, tomatoes', question, topic, brief)).toBe(false);
    expect(photoOfTheLine('CCTV video of pager explosion in a Beirut market', { line: 'Stalls at the farmers market' }, topic, brief)).toBe(false);
    expect(photoOfTheLine('Farmers market in Kenya', question, topic, 'A film about a farmers market in Kenya')).toBe(true);
  });
});

// Journey 14: "A 30 second explainer about voicemail chaos at a dental practice front desk" for Callback came back with
// a brass paperweight, a brass bell, a vintage rotary telephone and a bronze anchor, the anchor held for the last 8 s.
describe("the film's world", () => {
  const ASK = 'A 30 second explainer about voicemail chaos at a dental practice front desk: phones ringing, voicemails piling up, patients booking elsewhere. Use real footage clips.';
  const BRIEF = [
    '# Company brief', '', 'Everyone on the stage reads this.', '',
    "What the company does: Callback turns a dental practice's voicemail into booked appointments. It transcribes each voicemail left after hours or while the front desk is busy, works out what the caller wants, and offers them a slot in the practice calendar by text message.",
    '', '## Idea', '', 'Dentists miss calls; patients leave voicemails nobody returns for hours, and many book elsewhere. Callback answers every voicemail with a booking offer by text within minutes.',
    '', '## Numbers', '', '- Cash in the bank: €4,000',
  ].join('\n');
  const world = worldOf(ASK, productFacts(BRIEF));
  const DRAWN = [
    'A heavy brass paperweight resting on top of a thick stack of unused patient intake folders on a wooden filing cabinet',
    'A small brass bell sitting on a worn marble checkout counter near a ceramic jar of dental floss picks',
    'A vintage rotary dial telephone sitting unplugged and dusty on a steel storage shelf in a supply closet',
    'A weathered bronze sculpture of an anchor resting heavily on a burlap rug in the corner of an empty consultation room',
  ];
  const GOOD = [
    'An empty, ring-lighted dental examination chair with tilted instruments resting on the tray in an otherwise deserted treatment room',
    'A receptionist with her back turned, rapidly organizing overflowing paper folders behind a cluttered reception counter in a dimly lit dental clinic',
  ];

  it('is built from the ask and the product, without the abstract words or the money', () => {
    expect(world.words).toEqual(expect.arrayContaining(['voicemail', 'dental', 'practice', 'desk', 'phones', 'patients', 'appointments', 'calendar']));
    expect(world.words).not.toContain('chaos');
    expect(world.words).not.toContain('explainer');
    expect(world.words).not.toContain('cash');
    expect(world.setting).toBe('at a dental practice front desk');
    expect(topicOf(ASK)).not.toContain('chaos');
    expect(settingOf('A 20 second documentary clip about a pottery class, with real photographs')).toBeUndefined();
  });

  it('takes the product facts out of a company brief', () => {
    const facts = productFacts(BRIEF);
    expect(facts).toContain('offers them a slot in the practice calendar by text message');
    expect(facts).toContain('Callback answers every voicemail');
    expect(facts).not.toContain('4,000');
  });

  it('refuses a museum piece or a stand-in object unless the founder named it', () => {
    expect(DRAWN.map((one) => standInOf(one, world.named))).toEqual(['paperweight', 'bell', 'vintage', 'bronze']);
    for (const one of GOOD) expect(standInOf(one, world.named)).toBeNull();
    expect(standInOf('Rotary telephone, Science Museum Collection', world.named)).toBe('museum');
    expect(standInOf('Telephone handset, object no. 1984.12.3', world.named)).toBe('a catalogue number');
    expect(standInOf('A brass bell on the counter of a bicycle shop', 'a film about our bicycle bells')).toBeNull();
  });

  it('holds a photograph to the line and the world: a museum telephone and a phone alone are drawn instead', () => {
    const line = { line: 'Front desk phone chaos costs your dental practice new patients every single day.' };
    const topic = topicOf(ASK);
    expect(photoOfTheLine('Rotary dial telephone, bronze, Museum of Communication collection', line, topic, ASK, world)).toBe(false);
    expect(photoOfTheLine('Brass bell paperweight specimen', line, topic, ASK, world)).toBe(false);
    expect(photoOfTheLine('Old phone', { line: 'The phone keeps ringing.' }, topic, ASK, world)).toBe(false);
    expect(photoOfTheLine('Phone on the reception desk of a dental practice', { line: 'The phone keeps ringing.' }, topic, ASK, world)).toBe(true);
    expect(worldScore('Phone on the reception desk of a dental practice', world)).toBeGreaterThan(worldScore('Old phone', world));
    expect(worldScore('Bronze anchor', world)).toBeLessThan(0);
  });

  it('sends a stand-in back to the model and, failing that, draws the line where the film is set', () => {
    const lines = ['Unanswered calls turn into endless voicemails piling up while patients book elsewhere.', 'Our platform captures every missed call.',
      'Staff waste hours every week on callbacks.', 'Patients book with the practice down the street.'];
    const visuals = DRAWN.map((subject, at) => one(at, subject, lines[at], { metaphor: 'the weight of the backlog', kind: (['wide', 'detail', 'object', 'environment'] as const)[at] }));
    const found = criticiseVisuals(visuals, world);
    expect(found.filter((one) => one.rule === 'standin').map((one) => one.at)).toEqual([0, 1, 2, 3]);
    expect(found.find((one) => one.rule === 'standin')!.says).toContain("film's world");
    expect(visualsPrompt(visuals, BIBLE, 'missed calls cost patients', world)).toMatch(/no paperweight, bell, anchor/);
    const { visuals: mended, notes } = repairVisuals(visuals, world);
    for (const picture of mended) {
      expect(standInOf(picture.subject, world.named)).toBeNull();
      expect(worldScore(picture.subject, world)).toBeGreaterThan(0);
    }
    expect(mended[0].subject).toContain('at a dental practice front desk');
    // Rebuilt out of the world's things only: no product name, nothing a sentence merely does.
    expect(world.words).not.toContain('callback');
    for (const verb of ['transcribes', 'offers', 'turns', 'answers', 'works']) expect(world.words).not.toContain(verb);
    expect(visualFrom('Patients book here instead of going elsewhere.', 4, new Set(), world)).not.toMatch(/instead|elsewhere|patients/);
    expect(visualFrom('Callback returns every call within hours.', 2, new Set(), world)).not.toMatch(/returns|hours|callback/i);
    expect(notes.join(' ')).toMatch(/stand-in/);
    // A picture the model wrote well is kept beside a rebuilt one, though both are at the front desk.
    const pair = [one(0, DRAWN[0], lines[0], { kind: 'wide' }), one(1, 'A cordless phone ringing beside an appointment calendar at a dental practice front desk', 'The phones never stop at the front desk.', { kind: 'detail' })];
    expect(repairVisuals(pair, world).visuals[1].subject).toBe(pair[1].subject);
    expect(world.words).not.toContain('after');
    expect(world.words).not.toContain('miss');
    // Without a world the old rules stand: a declared metaphor still passes.
    expect(criticiseVisuals(visuals).some((one) => one.rule === 'standin')).toBe(false);
  });

  it('closes on the best picture of the world, never on the weakest or the shot before carried on', () => {
    const scores = new Map([[0, worldScore(GOOD[1], world)], [1, worldScore(GOOD[0], world)], [3, worldScore(DRAWN[3], world)]]);
    // The journey: the anchor (shot 3) carried on into the last shot.
    expect([0, 1]).toContain(closeHolds([0, 1, 1, 3, 3], scores).at(-1));
    // A close of its own, on the world, keeps it.
    const fine = new Map([[0, 1], [1, 3], [2, 2]]);
    expect(closeHolds([0, 1, 2], fine)).toEqual([0, 1, 2]);
    // A close of its own that is the weakest of three takes the best.
    expect(closeHolds([0, 1, 2], new Map([[0, 3], [1, 2], [2, 0]])).at(-1)).toBe(0);
    // A stand-in of its own takes the best too.
    expect(closeHolds([0, 1, 2], new Map([[0, 3], [1, 2], [2, -1]])).at(-1)).toBe(0);
    // Nothing better to hold: left alone.
    expect(closeHolds([0, 0], new Map([[0, 0]]))).toEqual([0, 0]);
  });
});

// Journey 15: "20 s explainer about our marketplace" for PrintNear (idle 3D printers rented to local makers) came back
// with the old market square of Poznań, a Waikiki shopping mall and drawn ceramic tiles. No 3D printer was shown.
describe('a film about a marketplace is a film of its printers and makers', () => {
  const ASK = '20 s explainer about our marketplace';
  const BRIEF = [
    '# Company brief', '',
    'What the company does: PrintNear is a marketplace where people rent out their idle 3D printers to local makers who need parts printed.',
    '', '## Idea', '', 'Makers send a print job, a nearby host prints it on their own printer with their own filament, and the maker collects the part from the workshop.',
  ].join('\n');
  const world = worldOf(ASK, productFacts(BRIEF));
  const topic = topicOf(ASK);
  const line = { line: 'PrintNear is a marketplace where people rent out their idle 3D printers.' };

  it('never makes a kind of business a thing of the world', () => {
    expect(topic).toEqual([]);
    expect(world.words).not.toContain('marketplace');
    expect(world.words).toEqual(expect.arrayContaining(['printers', 'makers', 'print', 'host']));
    expect(world.words).not.toContain('people');
    expect(thingsOf('our marketplace app is a platform and a service hub on a network')).toEqual([]);
  });

  it("refuses the journey's photographs and takes a printer", () => {
    for (const title of ['Old marketplace and city hall in Poznań', 'International Marketplace - Waikiki', 'Nine small ceramic tiles'])
      expect(photoOfTheLine(title, line, topic, ASK, world)).toBe(false);
    expect(photoOfTheLine('A maker loading filament into a 3D printer in a home workshop', line, topic, ASK, world)).toBe(true);
  });

  it('refuses a town or a landmark the brief never names, by its capital as well as by the list', () => {
    expect(foreignIn('Old marketplace and city hall in Poznań', ASK)).toEqual(expect.arrayContaining(['city hall', 'poznań']));
    expect(foreignIn('International Marketplace - Waikiki', ASK)).toEqual(['waikiki']);
    expect(foreignIn('3D printer workshop at Fab Lab Gdańsk', ASK)).toEqual(expect.arrayContaining(['fab', 'gdańsk']));
    expect(foreignIn('3D Printer On A Workbench', ASK)).toEqual([]);
    expect(foreignIn('A maker printing a bracket. The printer runs all night', ASK)).toEqual([]);
    expect(foreignIn('Maker space in Berlin', `${ASK} with makers in Berlin`)).toEqual([]);
  });

  it('draws a film whose world has no things at all', () => {
    const bare = worldOf('a 20 s explainer about our app');
    expect(bare.words).toEqual([]);
    expect(photoOfTheLine('A phone showing an app', { line: 'Our app does it for you.' }, [], 'a 20 s explainer about our app', bare)).toBe(false);
  });

  it('keeps the kind the founder wrote a thing with: a laser printer is not a 3D printer', () => {
    expect(world.kinds).toEqual({ printer: '3D' });
    const laser: Visual = { at: 0, scene: 0, take: 0, line: 'Idle printers sit unused.', subject: 'A desktop laser printer standing idle on a wooden desk in a home office', kind: 'object', room: 'foot' };
    expect(criticiseVisuals([laser], world).map((one) => one.rule)).toContain('offworld');
    expect(criticiseVisuals([{ ...laser, subject: 'A 3‑D printer standing idle on a wooden desk in a home office' }], world).map((one) => one.rule)).not.toContain('offworld');
    expect(repairVisuals([laser], world).visuals[0].subject).toMatch(/^3D printers, /);
  });

  it('draws the ceramic tiles again as a thing of the world', () => {
    const tiles: Visual = { at: 0, scene: 0, take: 0, line: 'Already nine printers are listed.', subject: 'Nine small ceramic tiles laid in a row on a stone table', metaphor: 'tiles stand for the printers listed', kind: 'object', room: 'foot' };
    expect(criticiseVisuals([tiles], world).map((one) => one.rule)).toContain('offworld');
    const { visuals } = repairVisuals([tiles], world);
    expect(visuals[0].subject).toMatch(/3D printers/);
    expect(criticiseVisuals(visuals, world).map((one) => one.rule)).not.toContain('offworld');
  });
});
