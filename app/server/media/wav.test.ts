import { describe, expect, it } from 'vitest';
import { wavHeader, wavSeconds } from './wav.ts';

describe('the one WAV header', () => {
  it('says what a mono and a stereo 16-bit file are, as the voice and the music each wrote it by hand', () => {
    const mono = wavHeader(48_000, 24_000, 1);
    expect([mono.readUInt16LE(22), mono.readUInt32LE(28), mono.readUInt16LE(32), mono.readUInt32LE(40)]).toEqual([1, 48_000, 2, 48_000]);
    const stereo = wavHeader(176_400, 44_100, 2);
    expect([stereo.readUInt16LE(22), stereo.readUInt32LE(28), stereo.readUInt16LE(32), stereo.readUInt32LE(4)]).toEqual([2, 176_400, 4, 176_436]);
    expect(wavSeconds(Buffer.concat([mono, Buffer.alloc(48_000)]))).toBeCloseTo(1, 5);
    expect(wavSeconds(Buffer.concat([stereo, Buffer.alloc(176_400)]))).toBeCloseTo(1, 5);
  });
});
