import { describe, expect, it } from 'vitest';
import { criticise, repair, type Want } from './critic.ts';
import { briefWants, closeLineOf, ctaInBrief, firstHeadline, namesTheBrief } from './close.ts';
import { planPrompt, understandingOf, type Material } from './director.ts';
import { sourcesOf } from './grounding.ts';
import { HERO_BRIEF, HERO_MATERIAL, heroSpec, HERO_SCENES } from './hero-fixture.ts';
import { LAYOUTS, type Layout, type Scene } from './spec.ts';

// The site's hero film closed on "Try it this week", a line nobody asked for. A close is the founder's call to
// action, else the product's positioning line, else the film's first headline said again.
const want = (material: Material, brief: string, over: Partial<Want> = {}): Want => ({
  seconds: 20, pace: 'calm', purpose: 'launch', captions: true, bible: 'studio photography',
  layouts: [...LAYOUTS] as Layout[], reel: false, product: true,
  sources: sourcesOf(material, brief), ...briefWants(material, brief), ...over,
});
const last = (scenes: Scene[]) => scenes.at(-1)!;

describe('the line a film closes on', () => {
  it('reads the call to action the founder quoted in the brief, and not "end on the promise"', () => {
    expect(ctaInBrief(HERO_BRIEF)).toBe('Get it, free, on your own machine');
    expect(ctaInBrief('Calm and confident, end on the promise.')).toBeUndefined();
    expect(ctaInBrief('A launch reel. CTA: "Book a demo"')).toBe('Book a demo');
    expect(closeLineOf(HERO_BRIEF, HERO_MATERIAL)).toEqual({ line: 'Get it, free, on your own machine', asked: true });
  });

  it('takes a wired document\'s call to action when the brief has none, then the positioning line', () => {
    const doc: Material = { ...HERO_MATERIAL, lines: [...HERO_MATERIAL.lines, 'Launch notes\nCall to action: Start your company tonight'] };
    expect(closeLineOf('a calm launch film', doc)).toEqual({ line: 'Start your company tonight', asked: true });
    expect(closeLineOf('a calm launch film', HERO_MATERIAL)).toEqual({ line: 'A company of your own, on your own machine', asked: false });
  });

  it('closes the hero storyboard on the brief\'s call to action, word for word, said and shown', () => {
    const made = repair(heroSpec(), want(HERO_MATERIAL, HERO_BRIEF)).spec.scenes;
    expect(last(made).layout).toBe('cta');
    expect(last(made).text).toBe('Get it, free, on your own machine');
    expect(last(made).say).toBe('Get it, free, on your own machine.');
    expect(made.some((one) => /try it this week/i.test(`${one.text} ${one.say}`))).toBe(false);
  });

  it('replaces a director\'s close to a made-up website with the call to action, not a stock line', () => {
    const scenes = [...HERO_SCENES.slice(0, -1), { layout: 'cta' as const, text: 'See it work on cubicle.app', say: 'See it work on cubicle.app now and start building your own.' }];
    const made = repair(heroSpec(scenes), want(HERO_MATERIAL, HERO_BRIEF)).spec.scenes;
    expect(last(made).text).toBe('Get it, free, on your own machine');
  });

  it('with no call to action anywhere, closes on the positioning line, and failing that on the first headline', () => {
    const brief = 'A 20 second launch film, calm, captions on.';
    const positioned = repair(heroSpec(), want(HERO_MATERIAL, brief)).spec.scenes;
    expect(last(positioned).text).toBe('A company of your own, on your own machine');
    const bare: Material = { ...HERO_MATERIAL, pitch: undefined };
    const restated = repair(heroSpec([{ layout: 'statement', text: 'Your own team', say: 'A small team of AI people works beside you.' }, ...HERO_SCENES.slice(1)]), want(bare, brief)).spec.scenes;
    // The first headline of the film as it will be seen, said again; never a line that fits every film.
    expect(last(restated).text).toBe(firstHeadline(restated) ?? 'Private AI Team on Your Machine');
    expect(last(restated).text).not.toMatch(/try it this week|follow for more|what you get/i);
    expect(last(restated).say).toBe(`${last(restated).text}.`);
  });

  it('keeps a close that already names the brief when the founder asked for no call to action', () => {
    const brief = 'A calm launch film: nothing leaves the machine.';
    const scenes = [...HERO_SCENES.slice(0, -1), { layout: 'cta' as const, text: 'Nothing leaves the machine', say: 'And nothing leaves the machine.' }];
    expect(last(repair(heroSpec(scenes), want(HERO_MATERIAL, brief)).spec.scenes).say).toBe('And nothing leaves the machine.');
  });

  it('the critic rejects a close that names nothing from the brief', () => {
    const sources = sourcesOf(HERO_MATERIAL, 'A calm launch film: nothing leaves the machine.');
    expect(namesTheBrief({ layout: 'cta', text: 'Try it this week', say: 'Try it this week.' }, sources)).toBe(false);
    expect(namesTheBrief({ layout: 'cta', text: 'See the stage', say: 'See the stage.', source: 'Wires carry context' }, sources)).toBe(true);
    expect(namesTheBrief({ layout: 'cta', text: 'Follow for more', say: 'Follow for more.' }, sources, true)).toBe(true);
    expect(namesTheBrief({ layout: 'cta', text: 'Nothing leaves the machine' }, sources)).toBe(true);
    const found = criticise(heroSpec(), want(HERO_MATERIAL, HERO_BRIEF));
    expect(found.find((one) => one.rule === 'close')?.says).toMatch(/Get it, free, on your own machine/);
    const plain = criticise(heroSpec(), want(HERO_MATERIAL, 'A calm launch film: nothing leaves the machine.'));
    expect(plain.find((one) => one.rule === 'close')?.says).toMatch(/names nothing from the brief/);
  });

  it('tells the director the close before it writes a beat', () => {
    const understanding = understandingOf({}, { brief: HERO_BRIEF, seconds: 20, pace: 'calm', purpose: 'launch' }, {});
    expect(planPrompt(understanding, { brief: HERO_BRIEF }, HERO_MATERIAL)).toMatch(/call to action, said and shown word for word: "Get it, free, on your own machine"/);
  });
});

describe('the close, as the founder wrote it', () => {
  it('drops a heading the model put beside the founder\'s call to action', () => {
    const scenes = [...HERO_SCENES.slice(0, -1), { layout: 'cta' as const, heading: 'Get started today', text: 'Get it free on your own machine', say: 'Get it free on your own machine' }];
    const close = last(repair(heroSpec(scenes), want(HERO_MATERIAL, HERO_BRIEF)).spec.scenes);
    expect(close.heading).toBeUndefined();
    expect(close.text).toBe('Get it, free, on your own machine');
  });
});
