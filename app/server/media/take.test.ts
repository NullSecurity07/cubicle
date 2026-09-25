import { describe, expect, it, vi } from 'vitest';
import { readPcm } from './film-record.ts';
import { readAround } from './take.ts';
import { wavOf } from './voice.ts';
import { wavSeconds } from './wav.ts';

const wav = (seconds: number, rate = 24_000, level = 0.5) => wavOf(new Float32Array(Math.round(seconds * rate)).fill(level), rate);

describe('a film read around a recorded take', () => {
  it('reads what comes before and after the take, each in one go, and joins the three in order', async () => {
    const say = vi.fn(async (text: string) => ({ ext: 'wav', bytes: wav(text.length / 10, 24_000, 0.1), parts: [{ text, seconds: text.length / 10 }] }));
    const said = await readAround(['One two.', 'The take.', 'Three.', 'Four.'], 1, wav(2, 24_000, 0.9), say);
    expect(say.mock.calls.map(([text]) => text)).toEqual(['One two.', 'Three. Four.']);
    expect(said!.parts).toEqual([{ text: 'One two.', seconds: 0.8 }, { text: 'The take.', seconds: 2 }, { text: 'Three. Four.', seconds: 1.2 }]);
    expect(wavSeconds(said!.bytes)).toBeCloseTo(0.8 + 2 + 1.2, 2);
    // The take sits between the two readings, exactly where its line falls.
    const pcm = readPcm(said!.bytes)!;
    expect(pcm.samples[Math.round(0.4 * 24_000)]).toBeCloseTo(0.1, 2);
    expect(pcm.samples[Math.round(1.8 * 24_000)]).toBeCloseTo(0.9, 2);
    expect(pcm.samples[Math.round(3.5 * 24_000)]).toBeCloseTo(0.1, 2);
  });

  it("brings a take made at another rate to the film's own, and reads nothing when it is the whole script", async () => {
    const say = vi.fn(async (text: string) => ({ ext: 'wav', bytes: wav(1), parts: [{ text, seconds: 1 }] }));
    const mixed = await readAround(['The take.', 'After.'], 0, wav(1, 48_000), say);
    expect(readPcm(mixed!.bytes)!.rate).toBe(24_000);
    expect(wavSeconds(mixed!.bytes)).toBeCloseTo(2, 2);
    const whole = vi.fn();
    const alone = await readAround(['', 'The take.', ''], 1, wav(1.5, 48_000), whole);
    expect(whole).not.toHaveBeenCalled();
    expect(readPcm(alone!.bytes)!.rate).toBe(48_000);
    expect(alone!.parts).toEqual([{ text: 'The take.', seconds: 1.5 }]);
  });

  it('carries a non-commercial licence from the voice that read the rest', async () => {
    const said = await readAround(['Before.', 'Take.'], 1, wav(1), async (text) => ({ ext: 'wav', bytes: wav(1), parts: [{ text, seconds: 1 }], noncommercial: true, credits: 'CC-BY-NC' }));
    expect(said).toMatchObject({ noncommercial: true, credits: 'CC-BY-NC' });
  });

  it('gives up on a take it cannot read, so the film is read whole', async () => {
    expect(await readAround(['Take.'], 0, Buffer.from('not a wav'), async () => { throw new Error('unused'); })).toBeNull();
  });
});
