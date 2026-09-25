import { describe, expect, it } from 'vitest';
import { repair, type Want } from './critic.ts';
import { briefWants } from './close.ts';
import { specFromPlan, understandingOf, type Plan } from './director.ts';
import { sourcesOf } from './grounding.ts';
import { HERO_BRIEF, HERO_MATERIAL } from './hero-fixture.ts';
import { LAYOUTS, type Layout, type Scene, type Spec } from './spec.ts';
import { stockHeading, STOCK_HEADINGS, wholeBullet } from './wording.ts';

// Run 2 of the hero film showed a checklist headed "What you get" with a second line reading "right here." — a heading
// out of a table that fits every product, and the tail of the spoken sentence set as a list line.
const want = (over: Partial<Want> = {}): Want => ({
  seconds: 20, pace: 'calm', purpose: 'launch', captions: true, bible: 'studio photography', layouts: [...LAYOUTS] as Layout[],
  reel: false, product: true, sources: sourcesOf(HERO_MATERIAL, HERO_BRIEF), ...briefWants(HERO_MATERIAL, HERO_BRIEF), ...over,
});
const film = (middle: Scene[]): Spec => ({
  title: 'Your AI team',
  scenes: [
    { layout: 'hook', text: 'Wires are access', say: 'Wire them to what they may read, and they draft and research.' },
    ...middle,
    { layout: 'statement', text: 'Nothing leaves your computer', say: 'You decide, and nothing leaves your computer that you did not wire.' },
    { layout: 'cta', text: 'Get it, free, on your own machine', say: 'Get it, free, on your own machine.' },
  ],
});
const everything = (scenes: Scene[]) => scenes.flatMap((one) => [one.heading, one.text, ...(one.bullets ?? [])]).filter(Boolean).join(' | ');

describe('a list line is a thing, two to six words', () => {
  it('takes the full stop off a whole line and refuses the tail of a sentence', () => {
    expect(wholeBullet('Your own AI team')).toBe('Your own AI team');
    expect(wholeBullet('a board that holds the work,')).toBe('A board that holds the work');
    expect(wholeBullet('right here.')).toBeNull();
    expect(wholeBullet('and they draft')).toBeNull();
    expect(wholeBullet('research')).toBeNull();
    expect(wholeBullet('works beside you quietly')).toBeNull();
    expect(wholeBullet('one two three four five six seven')).toBeNull();
    // A step may be an instruction, and may end on its particle.
    expect(wholeBullet('Wire a person in', 'step')).toBe('Wire a person in');
    expect(wholeBullet('Wire a person to the', 'step')).toBeNull();
  });

  it('knows the headings nobody wrote', () => {
    expect(stockHeading('What you get')).toBe(true);
    expect(stockHeading('What you get:')).toBe(true);
    expect(stockHeading('Wires are access')).toBe(false);
    expect(STOCK_HEADINGS.has('what you get')).toBe(true);
  });
});

describe('the hero film\'s checklist', () => {
  it('sets a list with a fragment line in it as plain words, with no stock heading anywhere', () => {
    const run2: Scene = { layout: 'checklist', heading: 'What you get', bullets: ['Your own AI team', 'right here.'], say: 'Your own AI team, right here.' };
    const scenes = repair(film([run2]), want()).spec.scenes;
    const shown = everything(scenes);
    expect(shown).not.toMatch(/what you get/i);
    expect(shown).not.toMatch(/right here\./i);
    expect(scenes.find((one) => /own AI team/i.test(one.say ?? ''))!.layout).toBe('statement');
  });

  it('gives a good list the founder\'s own phrase for a heading, never the stock one', () => {
    const good: Scene = { layout: 'checklist', heading: 'What you get', bullets: ['A small AI team', 'Wires that grant access'], say: 'A small AI team, and wires that grant access.' };
    const scenes = repair(film([good]), want()).spec.scenes;
    const list = scenes.find((one) => one.layout === 'checklist')!;
    expect(list.bullets).toEqual(['A small AI team', 'Wires that grant access']);
    expect(stockHeading(list.heading)).toBe(false);
    // The founder's own words: the brief's phrase first, a phrase of the material when the brief has none about it.
    const theirs = [HERO_BRIEF, HERO_MATERIAL.pitch, ...HERO_MATERIAL.lines].join(' ').toLowerCase();
    if (list.heading) expect(theirs).toContain(list.heading.toLowerCase());
  });

  it('never reaches for the stock heading when a paragraph is recast as a list', () => {
    const listy: Scene = { layout: 'statement', text: 'Rooms, wires and a board', say: 'Rooms hold people, wires carry context, and a board holds the work.' };
    const scenes = repair(film([listy]), want()).spec.scenes;
    expect(scenes.every((one) => !stockHeading(one.heading) && !stockHeading(one.text))).toBe(true);
  });

  it('builds a list out of a plan without a heading of its own for the critic to fill', () => {
    const plan: Plan = {
      angle: 'a team beside you', hook: 'Wires are access', bible: 'studio photography',
      beats: [
        { beat: 'hook', on_screen: 'the stage', say: 'Wires are access.' },
        { beat: 'list', on_screen: 'a board', say: 'Your own AI team, right here.' },
        { beat: 'ask', on_screen: 'the close', say: 'Get it, free, on your own machine.' },
      ],
    };
    const mind = understandingOf({}, { brief: HERO_BRIEF }, {});
    const spec = specFromPlan(plan, mind, [...LAYOUTS] as Layout[]);
    expect(spec.scenes.every((one) => !stockHeading(one.heading))).toBe(true);
  });
});
