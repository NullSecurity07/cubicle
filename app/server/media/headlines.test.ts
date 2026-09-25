import { describe, expect, it } from 'vitest';
import { criticise, repair, type Want } from './critic.ts';
import { briefWants } from './close.ts';
import { sourcesOf } from './grounding.ts';
import { freshHeadlines, phrasesOf, repeatsCaptions } from './headlines.ts';
import { HERO_BRIEF, HERO_MATERIAL, heroSpec } from './hero-fixture.ts';
import { echoes, LAYOUTS, saysWhatItShows, type Layout, type Scene } from './spec.ts';

// The hero film's first scene set "Wire them to what they may read" large while its captions said "Wire them to what
// they may read, and they draft, research." A headline is never the words of the captions under it.
const want: Want = {
  seconds: 20, pace: 'calm', purpose: 'launch', captions: true, bible: 'studio photography',
  layouts: [...LAYOUTS] as Layout[], reel: false, product: true,
  sources: sourcesOf(HERO_MATERIAL, HERO_BRIEF), ...briefWants(HERO_MATERIAL, HERO_BRIEF),
};

describe('a headline that is its own captions', () => {
  const hook = heroSpec().scenes[0];

  it('is found on the hero film\'s opening scene, and not where the captions are hushed', () => {
    expect(repeatsCaptions(hook, true)).toBe('text');
    expect(repeatsCaptions(hook, false)).toBeNull();
    // The whole line set large hushes the captions, so nothing is said twice.
    expect(repeatsCaptions({ layout: 'cta', text: 'Get it, free, on your own machine', say: 'Get it, free, on your own machine.' }, true)).toBeNull();
    expect(repeatsCaptions({ layout: 'device', heading: 'They film and edit', say: 'They film, edit, and follow up automatically.' }, true)).toBe('heading');
  });

  it('the critic sends it back', () => {
    expect(criticise(heroSpec(), want).some((one) => one.rule === 'echo' && one.scene === 1)).toBe(true);
  });

  it('is given a phrase from the brief about the same thing, and the hero film opens without saying its line twice', () => {
    const made = repair(heroSpec(), want).spec.scenes[0];
    expect(made.text).toBe('Wires are access');
    expect(echoes(made.text!, made.say!)).toBeLessThan(0.6);
    expect(repeatsCaptions(made, true)).toBeNull();
    // No scene the repair hands back repeats its captions.
    for (const scene of repair(heroSpec(), want).spec.scenes) expect(repeatsCaptions(scene, true)).toBeNull();
  });

  it('leaves the brief\'s directions to the film out of the phrases', () => {
    const { brief } = phrasesOf(HERO_BRIEF);
    expect(brief).toContain('wires are access');
    expect(brief).toContain('nothing leaves the machine');
    expect(brief.some((one) => /film|website|sound off|calm|show the product|promise/i.test(one))).toBe(false);
  });

  it('with no phrase that fits, a short line is set whole and hushes its captions, and a long one loses the headline', () => {
    const none = { brief: [], lines: [] };
    const short: Scene = { layout: 'hook', text: 'Your own company', say: 'Your own company, tonight, on your machine.' };
    expect(repeatsCaptions(short, true)).toBe('text');
    const set = freshHeadlines([short], true, none).scenes[0];
    expect(set.text).toBe('Your own company, tonight, on your machine');
    expect(saysWhatItShows(set)).toBe(true);
    const long: Scene = { layout: 'picture', text: 'Wire them', say: 'Wire them to what they may read, and they draft and research for you.', image_prompt: 'a spool of wire' };
    expect(freshHeadlines([long], true, none).scenes[0].text).toBeUndefined();
  });
});
