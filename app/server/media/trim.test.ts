import { describe, expect, it } from 'vitest';
import { repair, type Want } from './critic.ts';
import { LAYOUTS, type Layout, type Spec } from './spec.ts';
import { trimWhole } from './wording.ts';

// The hero film's second take lost the end of its promise to the length pass: "You decide, and nothing leaves." It
// also rendered two checklists that had lost their lines as empty frames.
describe('a line is shortened only by whole thoughts', () => {
  it('never cuts a sentence word by word into a fragment', () => {
    expect(trimWhole('You decide, and nothing leaves your computer that you did not wire.', 7)).toBe('You decide, and nothing leaves your computer that you did not wire.');
    expect(trimWhole('A canvas where a small team of AI people works beside you.', 7)).toBe('A canvas where a small team of AI people works beside you.');
    expect(trimWhole('Rooms hold people. Wires carry context. A board holds the work.', 7)).toBe('Rooms hold people. Wires carry context.');
    expect(trimWhole('Wire them to what they may read, and they draft and research for you.', 8)).toBe('Wire them to what they may read.');
  });

  it('the length pass keeps the promise whole', () => {
    const want: Want = { seconds: 12, pace: 'calm', purpose: 'launch', captions: true, bible: 'studio photography', layouts: [...LAYOUTS] as Layout[], reel: false };
    const long: Spec = { title: 'Hero', scenes: [
      { layout: 'hook', text: 'Your AI team', say: 'Your AI teammates sit right beside you, all day, every day, on one canvas.' },
      { layout: 'picture', say: 'You decide, and nothing leaves your computer that you did not wire.', image_prompt: 'a closed computer' },
      { layout: 'cta', text: 'Get it free', say: 'Get it free.' },
    ] };
    const says = repair(long, want).spec.scenes.map((one) => one.say);
    expect(says).toContain('You decide, and nothing leaves your computer that you did not wire.');
    expect(says.some((one) => /nothing leaves\.$/.test(one ?? ''))).toBe(false);
  });
});

describe('a list with nothing in it', () => {
  it('is set as its headline rather than an empty frame', () => {
    const want: Want = { seconds: 20, pace: 'calm', purpose: 'launch', captions: true, bible: 'studio photography', layouts: [...LAYOUTS] as Layout[], reel: false };
    const made = repair({ title: 'Hero', scenes: [
      { layout: 'hook', text: 'Your AI team', say: 'Your AI teammates sit right beside you.' },
      { layout: 'checklist', text: 'Wires are access', say: 'Wire them to what they may read, and they draft, research.' },
      { layout: 'checklist', say: 'You decide, and nothing leaves your computer that you did not wire.' },
      { layout: 'cta', text: 'Get it free', say: 'Get it free.' },
    ] }, want).spec.scenes;
    for (const scene of made) if (['checklist', 'steps', 'bullets', 'compare', 'chart'].includes(scene.layout)) expect(scene.bullets?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(made[1].text).toBe('Wires are access');
    expect(['checklist', 'steps', 'bullets', 'compare', 'chart']).not.toContain(made[1].layout);
  });
});
