import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BED, duckExpr, MOODS, musicBed, SFX, sfxFile, SFX_DIR } from './audio.ts';
import { ffReady } from './ff.ts';
import { cuesOf } from './templates/index.ts';
import type { Shot } from './templates/index.ts';
import type { Scene } from './video.ts';
import { wavSeconds } from './voice.ts';
import { readFile } from 'node:fs/promises';

const shots = (scenes: Scene[], seconds = 4): Shot[] => scenes.map((scene) => ({ scene, seconds }));
const startsOf = (list: Shot[]) => list.map((_, index) => index * 4);

describe('the bed under a film', () => {
  it('holds full volume between the lines and drops under every one of them', () => {
    const quiet = 0.3;
    const expr = duckExpr([{ at: 4, seconds: 2 }], quiet);
    // The shape is `quiet + (1 - quiet) * (1 - duck)`, so it is exactly `quiet` while somebody is speaking.
    expect(expr.startsWith('0.300+0.700*(1-(')).toBe(true);
    expect(expr).toContain('min((t-(3.620))/0.380');
    expect(expr).toContain('((6.380)-t)/0.380');
    // Nothing said, nothing ducked.
    expect(duckExpr([], quiet)).toBe('1');
    expect(duckExpr([{ at: 1, seconds: 0 }], quiet)).toBe('1');
  });

  it('treats lines a breath apart as one duck, and keeps distant ones apart', () => {
    // Two sentences half a second apart: the bed coming up between them would be heard as a bump.
    const near = duckExpr([{ at: 2, seconds: 3 }, { at: 5.4, seconds: 2 }], 0.3);
    // One clamp per duck, and one more to combine two of them: a merged pair has exactly one.
    expect(near.match(/max\(/g)).toHaveLength(1);
    expect(near).toContain('((7.780)-t)/0.380');
    // Ten seconds apart is two ducks.
    const far = duckExpr([{ at: 2, seconds: 3 }, { at: 15, seconds: 2 }], 0.3);
    expect(far.match(/max\(/g)).toHaveLength(3);
  });

  it('gives every mood a gain, a duck and fades, and never bundles music it may not redistribute', async () => {
    for (const mood of MOODS.filter((one) => one !== 'none')) {
      const shape = BED[mood as keyof typeof BED];
      expect(shape.gain).toBeGreaterThan(0);
      expect(shape.quiet).toBeLessThan(shape.gain + 1);
      expect(shape.in + shape.out).toBeGreaterThan(1);
    }
    // The studio ships sounds, not songs: see templates/assets/CREDITS.md for why.
    const { readdir } = await import('node:fs/promises');
    const bundled = await readdir(join(SFX_DIR, '..'), { recursive: true });
    expect(bundled.filter((name) => /\.(mp3|m4a|flac|aac)$/i.test(String(name)))).toEqual([]);
    expect(bundled).toContain('CREDITS.md');
  });
});

describe('the sounds a film is cut with', () => {
  it('names a real bundled file for every cue it can raise', async () => {
    for (const sound of Object.keys(SFX) as (keyof typeof SFX)[]) {
      const bytes = await readFile(join(SFX_DIR, sfxFile(sound)));
      // Every one is a short WAV, which is all a cut needs and all that fits in a repository.
      expect(wavSeconds(bytes)).toBeGreaterThan(0);
      expect(wavSeconds(bytes)).toBeLessThan(2);
      expect(bytes.length).toBeLessThan(120_000);
    }
  });

  it('cuts into every scene, and marks what the scene itself does', () => {
    const list = shots([
      { layout: 'hook', text: 'Stop scrolling.' },
      { layout: 'checklist', heading: 'Three', bullets: ['a', 'b', 'c'] },
      { layout: 'stat', heading: '3x' },
      { layout: 'compare', bullets: ['before', 'after'] },
      { layout: 'logo', heading: 'Relay' },
    ]);
    const punchy = cuesOf(list, startsOf(list), 'punchy');
    // The opener of a reel is the one place a hard, bright sound belongs.
    expect(punchy[0]).toEqual({ sound: 'hard', at: 0 });
    expect(punchy.filter((one) => one.sound === 'mark')).toHaveLength(3);
    expect(punchy.some((one) => one.sound === 'accent')).toBe(true);
    expect(punchy.some((one) => one.sound === 'turn')).toBe(true);
    expect(punchy.some((one) => one.sound === 'sting')).toBe(true);
    // A calm film opens softly and cuts softly.
    const calm = cuesOf(list, startsOf(list), 'calm');
    expect(calm[0]).toEqual({ sound: 'soft', at: 0 });
    expect(calm.filter((one) => one.sound === 'cut-soft').length).toBeGreaterThan(0);
    expect(calm.some((one) => one.sound === 'cut-hard')).toBe(false);
    // A film that ticks forty times is a film nobody finishes.
    const many = shots(Array(24).fill({ layout: 'bullets', heading: 'x', bullets: ['a', 'b', 'c', 'd', 'e', 'f'] }));
    expect(cuesOf(many, startsOf(many), 'calm').length).toBeLessThanOrEqual(64);
  });

  it('carries no sound at all through a scene that moves by itself, except the cut into it', () => {
    const list = shots([{ layout: 'footage', asset: 'walk' }, { layout: 'clip', clip_prompt: 'a kite' }]);
    const cues = cuesOf(list, startsOf(list), 'calm');
    expect(cues).toHaveLength(2);
    expect(cues.every((one) => one.sound === 'cut-wood')).toBe(true);
  });
});

const dir = await mkdtemp(join(tmpdir(), 'bed-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(await ffReady())('mixing the bed, for real', () => {
  it('loops a short track to the length of the film, fades it and ducks it under the words', async () => {
    const from = join(dir, 'track.wav');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-ac', '2', from]);
    const to = join(dir, 'bed.wav');
    await musicBed({ from, to, seconds: 12, mood: 'calm', windows: [{ at: 3, seconds: 4 }] });
    const made = await readFile(to);
    // Four seconds of track, twelve seconds of film: it goes round three times and stops on the frame.
    expect(wavSeconds(made)).toBeCloseTo(12, 1);
    expect((await stat(to)).size).toBeGreaterThan(1000);
  }, 60_000);
});
