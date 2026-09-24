import { describe, expect, it } from 'vitest';
import {
  afforded, aboutTheLine, criticiseVisuals, drawnAs, fillerShot, kindFor, lineUnder, repairVisuals,
  shareOut, shares, slotsFor, somebodyIn, unlettered, visualFrom, visualsOf, visualsPrompt, type Visual, shotKey,
} from './visuals.ts';
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
    expect(aboutTheLine(one(0, 'rain filling a gutter', 'investors read the summary first', { metaphor: 'money running away' }))).toBe(true);
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
