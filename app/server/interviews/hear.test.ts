import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentWav } from './fixtures.ts';
import { fakeConvert, firstOf, linesOf, wavSeconds, type Ear } from './hear.ts';

const words = (text: string, from = 0, step = 0.3) => text.split(' ').map((word, index) => ({ text: word, start: from + index * step, end: from + index * step + 0.25 }));

describe('writing an interview down', () => {
  it('breaks words into lines at a pause, at the end of a long enough sentence, and when a line runs long', () => {
    const heard = [
      ...words('Thanks for making the time today, really.'),
      ...words('So tell me about the last time you closed the books at work.', 5),
      ...words('Short.', 9),
      ...words('Then more words after the short one', 9.3),
    ];
    const lines = linesOf(heard);
    expect(lines.map((line) => line.at)).toEqual([0, 5, 9]);
    expect(lines[1].text).toBe('So tell me about the last time you closed the books at work.');
    // "Short." is too short a sentence to stand alone, so the words after it join it.
    expect(lines[2].text).toBe('Short. Then more words after the short one');
    const long = linesOf(words(Array.from({ length: 90 }, (_, index) => `w${index}`).join(' ')));
    expect(long.map((line) => line.text.split(' ').length)).toEqual([40, 40, 10]);
  });

  it('puts loose punctuation back on the word before it', () => {
    expect(linesOf([{ text: 'Well', start: 0, end: 0.2 }, { text: ',', start: 0.2, end: 0.25 }, { text: 'no', start: 0.3, end: 0.5 }, { text: '.', start: 0.5, end: 0.55 }])[0].text).toBe('Well, no.');
  });

  it('measures a wav from its header, and says nothing about a file that is not one', async () => {
    expect(wavSeconds(silentWav(2.5))).toBeCloseTo(2.5);
    expect(wavSeconds(Buffer.from('not a wav at all, nothing like one, at any length whatsoever'))).toBeNull();
    const dir = await mkdtemp(join(tmpdir(), 'hear-'));
    await writeFile(join(dir, 'a.wav'), silentWav(3));
    await writeFile(join(dir, 'b.webm'), 'x');
    expect(await fakeConvert(join(dir, 'a.wav'))).toBeCloseTo(3);
    expect(await fakeConvert(join(dir, 'b.webm'))).toBe(60);
  });

  it('tries the next engine when one fails, and names both when both do', async () => {
    const broken: Ear = { name: 'one', hear: async () => { throw new Error('no cmake'); } };
    const works: Ear = { name: 'two', hear: async () => ({ lines: [{ at: 0, text: 'hi' }], engine: 'two' }) };
    expect((await firstOf([broken, works]).hear('x.wav', 1)).engine).toBe('two');
    await expect(firstOf([broken, broken]).hear('x.wav', 1)).rejects.toThrow('one: no cmake; one: no cmake');
  });
});
