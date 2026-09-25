import { describe, expect, it } from 'vitest';
import { repair, type Want } from './critic.ts';
import { briefWants, closeLineOf, endOnOf } from './close.ts';
import type { Material } from './director.ts';
import { fromBrief, realLine, saysMostOf, sourcesOf } from './grounding.ts';
import { HERO_BRIEF } from './hero-fixture.ts';
import { LAYOUTS, type Layout, type Scene, type Spec } from './spec.ts';

// Run 2 of the site's hero film: the director wrote the promise the brief asked to end on, with two words of its own
// in it ("approve", "instantly"). The truth pass could not point at those, and put the README's next unused sentence
// in its place — a line about something else — so the film no longer ended on the promise.
const README: Material = {
  pitch: 'A company of your own, on your own machine.',
  lines: [
    'README of cubicle:\nRooms hold people. A board holds the work and the founder runs it.\n'
    + 'Each person runs on a model you choose, free by default.\nWire them to what they may read, and they draft, research, film and follow up.\n'
    + 'You decide, and nothing leaves your computer that you did not wire.\nThe stage is one canvas, saved as plain files.',
  ],
  assets: [], using: ['cubicle project'],
};
const PROMISE = 'Approve every output, and nothing leaves your computer instantly.';
const want = (brief: string): Want => ({
  seconds: 20, pace: 'calm', purpose: 'launch', captions: true, bible: 'studio photography', layouts: [...LAYOUTS] as Layout[],
  reel: false, product: true, sources: sourcesOf(README, brief), ...briefWants(README, brief),
});
const film = (scenes: Scene[]): Spec => ({ title: 'Your AI team', scenes: scenes.map((one) => ({ ...one })) });
const RUN2: Scene[] = [
  { layout: 'hook', text: 'Wires are access', say: 'Wire them to what they may read, and they draft and research.' },
  { layout: 'statement', text: 'A small team beside you', say: 'A company of your own, on your own machine.' },
  { layout: 'device', heading: 'The stage', say: 'The stage is one canvas, saved as plain files.', asset: 'screen-1', frame: 'laptop' },
  { layout: 'picture', image_prompt: 'a desk lamp', say: PROMISE },
  { layout: 'cta', text: 'Get it, free, on your own machine', say: 'Get it, free, on your own machine.' },
];
const said = (scenes: Scene[]) => scenes.map((one) => one.say ?? '');

describe('"end on the promise" is read out of the brief', () => {
  it('resolves the promise to the brief\'s own clause, and leaves the quoted call to action as the close', () => {
    expect(endOnOf(HERO_BRIEF)).toBe('Nothing leaves the machine');
    expect(closeLineOf(HERO_BRIEF, README)).toEqual({ line: 'Get it, free, on your own machine', asked: true });
    expect(endOnOf('A calm film. End on how little it costs. It costs nothing to run.')).toBe('It costs nothing to run');
    expect(endOnOf('close with the call to action "Book a demo"')).toBeUndefined();
    expect(endOnOf('a calm launch film')).toBeUndefined();
  });

  it('makes the promise the close itself when the brief has no call to action', () => {
    const brief = 'A calm film about a canvas of AI people; nothing leaves the machine. End on the promise.';
    expect(closeLineOf(brief, README)).toEqual({ line: 'Nothing leaves the machine', asked: true });
    const close = repair(film(RUN2), want(brief)).spec.scenes.at(-1)!;
    expect(close.layout).toBe('cta');
    expect(close.say).toBe('Nothing leaves the machine.');
  });
});

describe('a founder\'s line is never swapped out', () => {
  it('knows a line of the brief, and one that says most of a brief sentence again', () => {
    const sources = sourcesOf(README, HERO_BRIEF);
    expect(fromBrief('Nothing leaves the machine.', sources)).toBe(true);
    expect(fromBrief('Wires are access, so each person reads only what is wired.', sources)).toBe(true);
    expect(fromBrief('Live cursor tracking for every team.', sources)).toBe(false);
  });

  it('keeps the hero film\'s promise, last before the call to action', () => {
    const { spec, notes } = repair(film(RUN2), want(HERO_BRIEF));
    const lines = said(spec.scenes);
    expect(lines.at(-1)).toBe('Get it, free, on your own machine.');
    expect(saysMostOf(lines.at(-2)!, 'Nothing leaves the machine')).toBe(true);
    // Nothing unrelated out of the README stands where the promise was.
    expect(lines).not.toContain('Rooms hold people.');
    expect(lines).not.toContain('A board holds the work and the founder runs it.');
    expect(notes.join(' ')).not.toMatch(/nowhere in your material/);
  });

  it('moves a promise the director put earlier to the end, and adds one when the storyboard has none', () => {
    const early = [RUN2[0], RUN2[3], RUN2[1], RUN2[2], RUN2[4]];
    const moved = said(repair(film(early), want(HERO_BRIEF)).spec.scenes);
    expect(saysMostOf(moved.at(-2)!, 'Nothing leaves the machine')).toBe(true);
    expect(moved.filter((line) => saysMostOf(line, 'Nothing leaves the machine'))).toHaveLength(1);

    const none = said(repair(film([RUN2[0], RUN2[1], RUN2[2], RUN2[4]]), want(HERO_BRIEF)).spec.scenes);
    // The founder's own sentence for it, out of the material.
    expect(none.at(-2)).toBe('You decide, and nothing leaves your computer that you did not wire.');
    expect(none.at(-1)).toBe('Get it, free, on your own machine.');
  });
});

describe('a line that has to go is replaced by one about the same thing', () => {
  it('picks the material sentence that shares a thing with the dropped line, not the next unused one', () => {
    const sources = sourcesOf(README, 'a calm launch film');
    expect(realLine(sources, new Set(), { line: PROMISE })).toBe('You decide, and nothing leaves your computer that you did not wire.');
    // The part of the material the scene pointed at comes first.
    expect(realLine(sources, new Set(), { line: 'Every person gets a model, instantly.', source: 'a model you choose' }))
      .toBe('Each person runs on a model you choose, free by default.');
    // Nothing in the material is about cursors: no replacement.
    expect(realLine(sources, new Set(), { line: 'Live cursor tracking.' })).toBeNull();
  });

  it('puts the same-subject sentence in when the brief did not pin the line', () => {
    const scenes = repair(film(RUN2), want('a calm launch film about a canvas of AI people')).spec.scenes;
    expect(said(scenes)).toContain('You decide, and nothing leaves your computer that you did not wire.');
    expect(said(scenes)).not.toContain('Rooms hold people.');
  });
});
