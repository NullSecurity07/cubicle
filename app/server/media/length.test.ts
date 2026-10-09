import { describe, expect, it } from 'vitest';
import { CLOSE_TAIL, MOST_TAIL, settleLength, VOICE_TAIL } from './length.ts';
import type { Take } from './editor.ts';
import type { Word } from './timings.ts';

// Five scenes read in fifteen seconds, asked for as a twenty-second film: the shape of the site's hero film.
const scene = { layout: 'statement' as const, text: 'Words', say: 'Some words said.' };
const takesOf = (): Take[] => [0, 3, 6, 9, 12].map((from, index) => ({ scene, index, from, to: from + 3 }));
const words: Word[] = Array.from({ length: 36 }, (_one, at) => ({ word: at === 35 ? 'research.' : 'word', at: 0.35 + at * 0.4, seconds: 0.3 }));
const lastWord = words.at(-1)!.at + words.at(-1)!.seconds;

describe('the length of a narrated film', () => {
  it('follows the reading, with a short tail, instead of padding to the length asked for', () => {
    const takes = takesOf();
    const said = settleLength(takes, words, 20);
    const end = takes.at(-1)!.to;
    expect(end).toBeGreaterThanOrEqual(lastWord);
    expect(end - lastWord).toBeLessThanOrEqual(MOST_TAIL);
    expect(end).toBeLessThan(17);
    // No scene is stretched to make up the difference: every take keeps the room it was given.
    takes.slice(0, -1).forEach((one, index) => expect(one.to - one.from).toBeCloseTo(takesOf()[index].to - takesOf()[index].from, 3));
    expect(said).toMatch(/15 seconds against 20/);
  });

  it('holds the close long enough to read, but never longer than the tail', () => {
    const takes = takesOf();
    takes.at(-1)!.to = lastWord + 0.1;
    settleLength(takes, words, 15);
    expect(takes.at(-1)!.to).toBeCloseTo(lastWord + CLOSE_TAIL, 3);
  });

  it('still spreads a silent film of timed cards to its length, since nothing there can be held over', () => {
    const takes = takesOf();
    settleLength(takes, [], 20);
    expect(takes.at(-1)!.to).toBeGreaterThan(19);
  });
});

// Journey 18 and 19: the close line stopped mid-thought. A long close read past where its words were guessed to end
// must never be cut: the film runs until the recording is over, and a breath after.
describe('the close of a narrated film', () => {
  it('covers the whole recording of a long close line, whatever the word times said', () => {
    const takes = takesOf();
    // The words were guessed to end at 14.65 s; the voice file of the long last line runs to 17.9 s.
    const voiced = 17.9;
    settleLength(takes, words, 15, voiced);
    expect(takes.at(-1)!.to).toBeGreaterThanOrEqual(voiced + VOICE_TAIL);
  });

  it('leaves a close alone that already outlasts the recording', () => {
    const takes = takesOf();
    settleLength(takes, words, 15, lastWord - 0.5);
    expect(takes.at(-1)!.to).toBeCloseTo(Math.min(Math.max(15, lastWord + CLOSE_TAIL), lastWord + MOST_TAIL), 3);
  });
});
