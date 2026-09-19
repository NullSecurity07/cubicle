import { describe, expect, it } from 'vitest';
import { capHtml, capLines, capSteps, wordTimes } from './captions.ts';
import { composition, FORMATS, type Shot } from './index.ts';

describe('word timings', () => {
  it('spreads a sentence over its own length, by how long each word takes to say', () => {
    const words = wordTimes([{ text: 'A strategically enormous word.', seconds: 3 }]);
    expect(words.map((one) => one.word)).toEqual(['A', 'strategically', 'enormous', 'word.']);
    expect(words[0].at).toBe(0);
    // A long word holds the screen longer than a short one, and none of them is instant.
    expect(words[1].seconds).toBeGreaterThan(words[0].seconds * 2);
    expect(words[0].seconds).toBeGreaterThan(0.1);
    // The words fill the sentence bar the breath at the end of it.
    const end = words.at(-1)!.at + words.at(-1)!.seconds;
    expect(end).toBeGreaterThan(2.5);
    expect(end).toBeLessThanOrEqual(3);
  });

  it('starts each sentence where the last one really ended, and starts the lot where the sound does', () => {
    const words = wordTimes([{ text: 'One two.', seconds: 2 }, { text: 'Three four.', seconds: 4 }], 10);
    expect(words[0].at).toBe(10);
    expect(words[2].word).toBe('Three');
    expect(words[2].at).toBeCloseTo(12, 2);
    expect(words.at(-1)!.at + words.at(-1)!.seconds).toBeLessThanOrEqual(16);
  });

  it('says nothing about a sentence with no words in it, but still keeps its place on the clock', () => {
    const words = wordTimes([{ text: '   ', seconds: 1.5 }, { text: 'After.', seconds: 1 }]);
    expect(words).toHaveLength(1);
    expect(words[0].at).toBe(1.5);
  });
});

describe('caption lines', () => {
  const at = (word: string, from: number, seconds = 0.3) => ({ word, at: from, seconds });

  it('breaks by width, so a line never wraps and strands a word underneath itself', () => {
    const lines = capLines([at('Rooms', 0), at('that', 0.4), at('remember', 0.8), at('everything', 1.2)], 20);
    expect(lines.map((line) => line.words.map((one) => one.word).join(' '))).toEqual(['Rooms that remember', 'everything']);
  });

  it('ends a line at the end of a sentence and wherever the speaker stops for a beat', () => {
    const lines = capLines([at('Done.', 0), at('Next', 0.4), at('one', 3)], 40);
    expect(lines).toHaveLength(3);
    expect(lines[0].words[0].word).toBe('Done.');
    expect(lines[2].words[0].word).toBe('one');
  });

  it('carries every word once and only once, whatever the budget', () => {
    const words = 'one two three four five six seven eight'.split(' ').map((word, index) => at(word, index * 0.3));
    for (const budget of [6, 12, 20, 40]) {
      expect(capLines(words, budget).flatMap((line) => line.words.map((one) => one.word))).toEqual(words.map((one) => one.word));
    }
  });
});

describe('captions in a film', () => {
  const shot = (seconds: number, parts: { text: string; seconds: number }[]): Shot =>
    ({ scene: { layout: 'statement', text: 'A line.', say: parts.map((one) => one.text).join(' ') }, seconds, voice: { file: 'say-0.wav', seconds: parts.reduce((sum, one) => sum + one.seconds, 0), parts } });

  it('shows one line at a time, and takes the one going before the one coming arrives', () => {
    const lines = capLines(wordTimes([{ text: 'One two.', seconds: 2 }, { text: 'Three four.', seconds: 2 }]), 20);
    expect(lines).toHaveLength(2);
    const steps = capSteps(lines, 0, 4).join('\n');
    const goes = Number(/#c0-0", \{ opacity: 0, duration: 0.15[^}]*\}, ([\d.]+)\)/.exec(steps)![1]);
    const comes = Number(/fromTo\("#c0-1", \{ opacity: 0, y: 14[^}]*\}[^}]*\}, ([\d.]+)\)/.exec(steps)![1]);
    expect(goes + 0.15).toBeLessThanOrEqual(comes);
  });

  it('is on the frame, not in the scene, so it outlives the scene fading out', () => {
    const page = composition({ title: 'One', shape: 'tall', look: 'clean', captions: true, shots: [shot(5, [{ text: 'Hello there.', seconds: 2 }])] });
    expect(page).toContain('<div class="caps" aria-hidden="true">');
    expect(page).toContain('<span class="capword" id="c0-0-0">Hello</span>');
    // The block that fades is `#f0`; the captions are outside it.
    expect(page.indexOf('class="caps"')).toBeGreaterThan(page.indexOf('id="f0"'));
    // Held well off the bottom edge, where a phone's own furniture sits.
    expect(page).toContain(`--caps: ${FORMATS.tall.caps}px;`);
  });

  it('writes none of it when nothing was said, or when the founder turned it off', () => {
    const silent = composition({ title: 'One', shape: 'wide', look: 'clean', captions: true, shots: [{ scene: { layout: 'statement', text: 'A line.' }, seconds: 4 }] });
    expect(silent).not.toContain('class="caps"');
    const off = composition({ title: 'One', shape: 'wide', look: 'clean', shots: [shot(5, [{ text: 'Hello there.', seconds: 2 }])] });
    expect(off).not.toContain('class="caps"');
    expect(off).toContain('<audio id="say0"');
  });
});
