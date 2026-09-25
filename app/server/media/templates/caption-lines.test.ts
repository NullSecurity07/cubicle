import { describe, expect, it } from 'vitest';
import { captionLines, type Film } from './index.ts';

// The fourth hero film: "You decide, and nothing leaves your computer." was said across a cut into a scene that
// writes "Nothing leaves your computer" on screen, so its captions are hushed — and "You" was left alone in the band.
describe('the caption track around a scene that writes its own words', () => {
  const said = 'I have a company of my own. You decide, and nothing leaves your computer.'.split(' ')
    .map((word, index) => ({ word, at: 0.3 + index * 0.35, seconds: 0.3 }));
  const film = (quietFrom: number): Film => ({
    title: 'One', shape: 'wide', look: 'brand', captions: true, shots: [], words: said,
    quiet: [{ at: quietFrom, seconds: 10 }],
  });

  it('does not leave the start of a phrase alone when the rest of it is hushed', () => {
    // The hush starts on "decide," — one word after "You".
    const quietFrom = said[8].at - 0.05;
    const shown = captionLines(film(quietFrom)).map((line) => line.words.map((one) => one.word).join(' '));
    expect(shown).not.toContain('You');
    expect(shown.join(' ')).toBe('I have a company of my own.');
  });

  it('keeps a whole sentence that ends before the hush', () => {
    const quietFrom = said[7].at - 0.05;
    const shown = captionLines(film(quietFrom)).map((line) => line.words.map((one) => one.word).join(' '));
    expect(shown.join(' ')).toBe('I have a company of my own.');
  });
});
