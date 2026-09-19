// Live check, needs real keys and this machine: one picture, one spoken line and one two-scene film, each from the
// backend that would make it for a studio card. Nothing is written into the workspace. Run with `pnpm check:media`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
try { process.loadEnvFile(resolve(import.meta.dirname, '../../.env')); } catch { /* no keys: every backend says what it needs */ }
const { imageMakers } = await import('../server/media/image.ts');
const { DEFAULT_VOICE, voiceMakers, wavSeconds } = await import('../server/media/voice.ts');
const { hyperframesVideos } = await import('../server/media/video.ts');
import type { Ask, Maker, Piece } from '../server/media/jobs.ts';

const dir = await mkdtemp(join(tmpdir(), 'stage-media-'));
const size = (piece: Piece) => `${(piece.bytes.length / 1024).toFixed(0)} KB`;

// A backend either says what it still needs, or is asked to make the smallest real thing it can.
async function check(maker: Maker, ask: Ask, tell: (piece: Piece) => string) {
  const hint = maker.ready();
  if (hint) { console.log(maker.name, 'NOT SET UP:', hint); return; }
  const started = Date.now();
  try {
    const piece = await maker.make(ask, { report: () => {} });
    console.log(maker.name, 'OK', tell(piece), `· ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) { console.log(maker.name, 'ERROR', String((error as Error).message).slice(0, 200)); }
}

const film = { title: 'A check', scenes: [{ layout: 'title' as const, heading: 'A check' }, { layout: 'outro' as const, text: 'It renders.' }] };
try {
  for (const maker of imageMakers()) await check(maker, { prompt: 'a paper plane over a desk, soft morning light', shape: 'square' }, (piece) => `a ${piece.ext} · ${size(piece)}`);
  for (const maker of voiceMakers(resolve(import.meta.dirname, '../.cache/voice'))) await check(maker, { prompt: 'The studios are working.', voice: DEFAULT_VOICE }, (piece) => `${wavSeconds(piece.bytes).toFixed(1)} seconds spoken · ${size(piece)}`);
  await check(hyperframesVideos({ dir, think: async () => { throw new Error('the storyboard is written here, not asked for'); } }),
    { prompt: film.title, spec: film, format: 'wide', look: 'clean', narrate: false }, (piece) => `an mp4 · ${size(piece)}${piece.poster ? ' · with a poster frame' : ''}`);
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
