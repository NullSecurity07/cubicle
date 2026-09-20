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

  it('shows one to three words at a time, never a subtitle', () => {
    const words = 'Investors never fund an idea they fund evidence'.split(' ').map((word, index) => at(word, index * 0.32));
    const lines = capLines(words, 40, 3);
    for (const line of lines) expect(line.words.length).toBeLessThanOrEqual(3);
    expect(lines.flatMap((line) => line.words.map((one) => one.word))).toEqual(words.map((one) => one.word));
  });

  it('breaks by width too, so a line never wraps and strands a word underneath itself', () => {
    const lines = capLines([at('Rooms', 0), at('that', 0.4), at('remember', 0.8), at('everything', 1.2)], 20, 4);
    expect(lines.map((line) => line.words.map((one) => one.word).join(' '))).toEqual(['Rooms that remember', 'everything']);
  });

  it('ends a line at the end of a sentence and wherever the speaker stops for a beat', () => {
    const lines = capLines([at('Done.', 0), at('Next', 0.4), at('one', 3)], 40, 4);
    expect(lines).toHaveLength(3);
    expect(lines[0].words[0].word).toBe('Done.');
    expect(lines[2].words[0].word).toBe('one');
  });

  it('carries every word once and only once, whatever the budget', () => {
    const words = 'one two three four five six seven eight'.split(' ').map((word, index) => at(word, index * 0.3));
    for (const budget of [6, 12, 20, 40]) {
      expect(capLines(words, budget, 4).flatMap((line) => line.words.map((one) => one.word))).toEqual(words.map((one) => one.word));
    }
  });

  it('lights exactly one word in a line: the one the line turns on', () => {
    const lines = capLines([at('they', 0), at('fund', 0.3), at('evidence', 0.6)], 40, 3);
    expect(lines).toHaveLength(1);
    expect(lines[0].words[lines[0].pop!].word).toBe('evidence');
    // The director's own word beats the longest one.
    const marked = capLines([at('they', 0), at('fund', 0.3), at('evidence', 0.6)], 40, 3, ['fund']);
    expect(marked[0].words[marked[0].pop!].word).toBe('fund');
    // A line of nothing but small words lights none of them.
    expect(capLines([at('it', 0), at('is', 0.3), at('the', 0.6)], 40, 3)[0].pop).toBeUndefined();
  });
});

describe('captions in a film', () => {
  const said = (text: string, from = 0, each = 0.4) => text.split(' ').map((word, index) => ({ word, at: from + index * each, seconds: each * 0.85 }));
  const shot = (seconds: number, say: string): Shot => ({ scene: { layout: 'picture', image_prompt: 'a kite', say }, seconds, image: 'shot-0.png' });

  it('is one track on the frame, outside every scene, so a cut cannot carry it away', () => {
    const words = said('Hello there friend');
    const page = composition({
      title: 'One', shape: 'tall', look: 'clean', captions: true, words,
      voice: { file: 'say.wav', seconds: 3 }, shots: [shot(5, 'Hello there friend')],
    });
    expect(page).toContain('<div class="caps" aria-hidden="true">');
    expect(page).toMatch(/<span class="capword[^"]*" id="c0-0">Hello<\/span>/);
    // Outside the sections altogether, so nothing that moves a scene moves the words being said.
    expect(page.indexOf('class="caps"')).toBeGreaterThan(page.lastIndexOf('</section>'));
    // Held well off the bottom edge, where a phone's own furniture sits.
    expect(page).toContain(`--caps: ${FORMATS.tall.caps}px;`);
    // One recording for the whole film, placed once.
    expect(page).toContain('<audio id="say" src="assets/say.wav" data-start="0"');
  });

  it('takes the line going before the line coming arrives', () => {
    const lines = capLines(said('One two three four'), 20, 2);
    expect(lines.length).toBeGreaterThan(1);
    const steps = capSteps(lines, 4).join('\n');
    const goes = Number(/#c0", \{ opacity: 0, duration: [\d.]+[^}]*\}, ([\d.]+)\)/.exec(steps)![1]);
    const comes = Number(/fromTo\("#c1", \{ opacity: 0, y: 16[^}]*\}[^}]*\}, ([\d.]+)\)/.exec(steps)![1]);
    expect(goes).toBeLessThanOrEqual(comes);
  });

  it('says nothing over a scene that already writes out the line being said', () => {
    const page = composition({
      title: 'One', shape: 'tall', look: 'clean', captions: true, words: said('Hello there friend'),
      voice: { file: 'say.wav', seconds: 3 },
      shots: [{ scene: { layout: 'hook', text: 'Hello there friend', say: 'Hello there friend' }, seconds: 5 }],
    });
    expect(page).not.toContain('class="caps"');
  });

  it('writes none of it when nothing was said, or when the founder turned it off', () => {
    const silent = composition({ title: 'One', shape: 'wide', look: 'clean', captions: true, shots: [{ scene: { layout: 'statement', text: 'A line.' }, seconds: 4 }] });
    expect(silent).not.toContain('class="caps"');
    const off = composition({ title: 'One', shape: 'wide', look: 'clean', words: said('Hello there'), voice: { file: 'say.wav', seconds: 2 }, shots: [shot(5, 'Hello there')] });
    expect(off).not.toContain('class="caps"');
    expect(off).toContain('<audio id="say"');
  });
});
