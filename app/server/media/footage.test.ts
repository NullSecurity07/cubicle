import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cover, fitStill, normalise, thumbOf } from './footage.ts';
import { ffReady, probe } from './ff.ts';

describe('cutting a clip to the frame', () => {
  it('fills the frame and trims it, and never squeezes it', () => {
    // Increase, then crop: a portrait clip in a wide film loses its sides, it does not become an oval.
    expect(cover(1280, 720)).toBe('scale=1280:720:force_original_aspect_ratio=increase:flags=bicubic,crop=1280:720,setsar=1');
  });
});

const dir = await mkdtemp(join(tmpdir(), 'footage-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(await ffReady())('the founder\'s own footage, for real', () => {
  // A tiny piece of footage of the wrong shape, the wrong frame rate and the wrong codec, with sound on it.
  const from = join(dir, 'phone.mkv');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=480x854:rate=24:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', from]);

  it('reads what a dropped file really is out of the file, not out of its name', async () => {
    const track = await probe(from);
    expect(track.kind).toBe('video');
    expect(track.width).toBe(480);
    expect(track.height).toBe(854);
    expect(track.sound).toBe(true);
    expect(track.seconds).toBeCloseTo(6, 0);
  }, 60_000);

  it('cuts a piece out of it, into the film\'s own frame, silent by default', async () => {
    const to = join(dir, 'cut.mp4');
    await normalise({ from, to, width: 1280, height: 720, start: 2, seconds: 2.5 });
    const track = await probe(to);
    expect(track.width).toBe(1280);
    expect(track.height).toBe(720);
    expect(track.seconds).toBeCloseTo(2.5, 0);
    // Silent unless the founder said to keep the sound, because a film already has narration over it.
    expect(track.sound).toBe(false);
  }, 120_000);

  it('keeps the clip\'s own sound when the scene asked for it', async () => {
    const to = join(dir, 'loud.mp4');
    await normalise({ from, to, width: 720, height: 1280, seconds: 1.5, mute: false });
    const track = await probe(to);
    expect(track.sound).toBe(true);
    expect(track.width).toBe(720);
  }, 120_000);

  it('makes a small thumbnail for the tray, and a still fitted to the frame', async () => {
    const thumb = join(dir, 'thumb.jpg');
    await thumbOf(from, thumb, 1);
    expect((await stat(thumb)).size).toBeGreaterThan(300);
    expect((await probe(thumb)).width).toBe(320);

    const still = join(dir, 'still.png');
    await fitStill(from, still, 1080, 1080);
    const fitted = await probe(still);
    expect([fitted.width, fitted.height]).toEqual([1080, 1080]);
  }, 120_000);

  it('says what went wrong in one line when the file is not a film at all', async () => {
    const { writeFile } = await import('node:fs/promises');
    const junk = join(dir, 'notes.txt');
    await writeFile(junk, 'this is not a video');
    await expect(normalise({ from: junk, to: join(dir, 'no.mp4'), width: 640, height: 360 })).rejects.toThrow();
    await expect(probe(junk)).rejects.toThrow();
  }, 60_000);
});
