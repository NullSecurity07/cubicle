import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { silentWav } from './fixtures.ts';
import { fakeConvert, firstOf, linesOf, wavSeconds, webmSeconds, type Ear } from './hear.ts';

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

  it('measures a WebM the browser recorded, which has no Duration, from its last block', async () => {
    // Built the way MediaRecorder writes one: a segment and clusters of unknown size, blocks with offsets.
    const el = (id: number[], body: Buffer) => Buffer.concat([Buffer.from(id), Buffer.from([0x08, 0, 0, 0, 0, 0, 0, 0]), body].map((part, index) => {
      if (index !== 1) return part;
      const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(body.length)); size[0] = 0x01; return size;
    }));
    const unknown = (id: number[]) => Buffer.from([...id, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const uint = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
    const block = (offset: number) => { const out = Buffer.from([0x81, 0, 0, 0x80, 0xfc]); out.writeInt16BE(offset, 1); return el([0xa3], out); };
    const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from('webm')));
    const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], uint(1_000_000)));
    const cluster = (at: number, offsets: number[]) => Buffer.concat([unknown([0x1f, 0x43, 0xb6, 0x75]), el([0xe7], uint(at)), ...offsets.map(block)]);
    const file = Buffer.concat([header, unknown([0x18, 0x53, 0x80, 0x67]), info, cluster(0, [0, 20, 40]), cluster(2000, [0, 500, 1080])]);
    expect(webmSeconds(file)).toBeCloseTo(3.1, 5);
    // A Duration in the header, when there is one, is the length.
    const timed = Buffer.concat([header, unknown([0x18, 0x53, 0x80, 0x67]), el([0x15, 0x49, 0xa9, 0x66], Buffer.concat([el([0x2a, 0xd7, 0xb1], uint(1_000_000)), el([0x44, 0x89], (() => { const d = Buffer.alloc(8); d.writeDoubleBE(4250); return d; })())])), cluster(0, [0])]);
    expect(webmSeconds(timed)).toBeCloseTo(4.25, 5);
    expect(webmSeconds(Buffer.from('not a webm at all'))).toBeNull();
    expect(webmSeconds(Buffer.concat([header, unknown([0x18, 0x53, 0x80, 0x67]), info]))).toBeNull();
    // The fake engine measures a WebM this way instead of calling it a minute.
    const dir = await mkdtemp(join(tmpdir(), 'webm-'));
    await writeFile(join(dir, 'call.webm'), file);
    expect(await fakeConvert(join(dir, 'call.webm'))).toBeCloseTo(3.1, 5);
  });
});
