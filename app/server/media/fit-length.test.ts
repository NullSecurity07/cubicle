import { describe, expect, it } from 'vitest';
import type { Want } from './critic.ts';
import { briefWants } from './close.ts';
import { fitLength, understandingOf, type Understanding } from './director.ts';
import { sourcesOf } from './grounding.ts';
import { HERO_BRIEF, HERO_MATERIAL } from './hero-fixture.ts';
import { lengthFit, readingOf } from './length.ts';
import { LAYOUTS, type Layout, type Scene, type Spec } from './spec.ts';

// The hero film ran anywhere from twelve to twenty seconds for the same twenty-second ask: the director wrote fewer
// words some runs, and a film follows its reading. A storyboard that reads short is sent back once for more lines.
const understanding: Understanding = understandingOf({}, { brief: HERO_BRIEF, seconds: 20, pace: 'calm', purpose: 'launch', captions: true }, {});
const want: Want = {
  seconds: 20, pace: 'calm', purpose: 'launch', captions: true, bible: 'studio photography',
  layouts: [...LAYOUTS].filter((one) => !['clip', 'presenter', 'footage'].includes(one)) as Layout[], reel: false, product: true,
  sources: sourcesOf(HERO_MATERIAL, HERO_BRIEF), ...briefWants(HERO_MATERIAL, HERO_BRIEF),
};
const short: Spec = { title: 'Hero', scenes: [
  { layout: 'hook', text: 'Wires are access', say: 'Wire them to what they may read.' },
  { layout: 'device', heading: 'The stage', say: 'They draft, research and film.', asset: 'screen-repo-1', frame: 'browser' },
  { layout: 'cta', text: 'Get it, free, on your own machine', say: 'Get it, free, on your own machine.' },
] };
const more = JSON.stringify({ scenes: [
  { layout: 'picture', say: 'Rooms hold people, and wires carry context between the cards on the canvas.', image_prompt: 'a spool of copper wire on a desk', source: 'Wires carry context.' },
  { layout: 'statement', text: 'Nothing leaves the machine', say: 'You decide, and nothing leaves your computer that you did not wire.', source: 'nothing leaves your computer that you did not wire' },
] });

describe('the length a storyboard reads at', () => {
  it('finds a twenty-second ask that reads at twelve', () => {
    expect(readingOf(short, 'calm')).toBeLessThan(20 * 0.85);
    const fit = lengthFit(short, 20, 'calm');
    expect(fit && 'more' in fit && fit.more).toBeGreaterThanOrEqual(1);
  });

  it('asks the director once for the lines that fill it, and sets them before the close', async () => {
    const asked: string[] = [];
    const think = async (prompt: string) => { asked.push(prompt); return more; };
    const lines: string[] = [];
    const filled = await fitLength(short, want, understanding, HERO_MATERIAL, think, (line) => lines.push(line));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/more line/);
    expect(filled.scenes.length).toBe(5);
    expect(filled.scenes.at(-1)!.text).toBe('Get it, free, on your own machine');
    expect(filled.scenes[0].say).toBe(short.scenes[0].say);
    expect(readingOf(filled, 'calm')).toBeGreaterThanOrEqual(20 * 0.85);
    expect(lines[0]).toMatch(/director is asked for \d more line/);
  });

  it('asks only once, and says so, when the model has nothing more to give', async () => {
    let calls = 0;
    const lines: string[] = [];
    const same = await fitLength(short, want, understanding, HERO_MATERIAL, async () => { calls += 1; return 'no'; }, (line) => lines.push(line));
    expect(calls).toBe(1);
    expect(same.scenes).toHaveLength(3);
    expect(lines.at(-1)).toMatch(/as long as what it already says/);
  });

  it('trims a long storyboard from the middle acts, never the opening or the close, and asks nobody', async () => {
    const line = 'Rooms hold people and wires carry context, so every person reads only what the founder wired to them.';
    const scenes: Scene[] = [
      { layout: 'hook', text: 'Wires are access', say: 'Wire them to what they may read.' },
      ...Array.from({ length: 6 }, (_one, at): Scene => ({ layout: at === 1 ? 'device' : 'statement', text: `Beat ${at}`, say: line, ...(at === 1 ? { asset: 'screen-repo-1', frame: 'browser' as const } : {}) })),
      { layout: 'cta', text: 'Get it, free, on your own machine', say: 'Get it, free, on your own machine.' },
    ];
    const long: Spec = { title: 'Hero', scenes };
    expect(readingOf(long, 'calm')).toBeGreaterThan(20 * 1.15);
    let calls = 0;
    const trimmed = await fitLength(long, want, understanding, HERO_MATERIAL, async () => { calls += 1; return more; }, () => {});
    expect(calls).toBe(0);
    expect(trimmed.scenes[0]).toEqual(long.scenes[0]);
    expect(trimmed.scenes.at(-1)).toEqual(long.scenes.at(-1));
    expect(trimmed.scenes.some((one) => one.layout === 'device')).toBe(true);
    expect(readingOf(trimmed, 'calm')).toBeLessThanOrEqual(20 * 1.15);
  });
});
