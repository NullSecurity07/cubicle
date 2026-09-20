// Live check, needs real keys and this machine: one picture, one spoken line, one two-scene film and, when there is a
// Hugging Face token, one moving shot and one talking head from the free Spaces. Nothing is written into the
// workspace. Run with `pnpm check:media`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
try { process.loadEnvFile(resolve(import.meta.dirname, '../../.env')); } catch { /* no keys: every backend says what it needs */ }
const { imageMakers } = await import('../server/media/image.ts');
const { DEFAULT_VOICE, voiceMakers, wavSeconds } = await import('../server/media/voice.ts');
const { hyperframesVideos } = await import('../server/media/video.ts');
const { createClips } = await import('../server/media/spaces.ts');
const { localClips, CLIP_SECONDS, MINUTES_EACH } = await import('../server/media/local-clips.ts');
const { localImages, DOWNLOAD_GB, SECONDS_EACH } = await import('../server/media/local-image.ts');
const { createMusic } = await import('../server/media/music.ts');
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

  // The bed under a film, both ways it can arrive. First the real one: a live search of the public domain and a real
  // download into the cache beside the voice model, which is where a founder's own run would put it. Then the one
  // written here, with the search switched off, which is what happens on a plane and must never fail.
  const music = createMusic({ cacheDir: resolve(import.meta.dirname, '../.cache') });
  const offline = createMusic({ cacheDir: dir, env: { STAGE_NO_MUSIC_SEARCH: '1' } });
  for (const [what, maker] of [['Music (found)', music], ['Music (written here)', offline]] as const) {
    const started = Date.now();
    try {
      const bed = await maker.bed({ mood: 'upbeat', seconds: 20 }, { report: (line: string) => console.log('  ·', line) });
      const found = bed.credit.source.startsWith('http');
      console.log(what, 'OK', `${wavSeconds(bed.bytes).toFixed(1)} seconds · ${(bed.bytes.length / 1024).toFixed(0)} KB · ${bed.bpm ?? '?'} bpm · ${bed.beats?.length ?? 0} beats`,
        `· ${((Date.now() - started) / 1000).toFixed(1)}s`);
      console.log(`  "${bed.credit.title}" by ${bed.credit.by} — ${bed.credit.licence}`);
      // The one line that matters: a live search that quietly fell back has not proven anything about the network.
      if (what.includes('found') && !found) console.log('  (nothing was found online, so this was written here too)');
    } catch (error) { console.log(what, 'ERROR', String((error as Error).message).slice(0, 200)); }
  }

  // Pictures made here on this machine: the one backend that never runs out, and the one that takes a minute. Like
  // the clips it is run only when the founder asks, so a check does not keep anybody waiting.
  const drawsHere = localImages();
  const drawHint = drawsHere.ready();
  if (drawHint) console.log('Local pictures NOT SET UP:', drawHint);
  else if (!process.argv.includes('--local')) console.log(`Local pictures READY (not run: ${DOWNLOAD_GB} GB once, then about ${SECONDS_EACH}s a picture; pass --local to draw one)`);
  else {
    const started = Date.now();
    try {
      const made = await drawsHere.make({ prompt: 'a paper plane over a desk, soft morning light, photo', shape: 'square' }, { report: (line: string) => console.log('  ·', line) });
      console.log(`Local pictures OK a ${made.ext} · ${(made.bytes.length / 1024).toFixed(0)} KB · ${((Date.now() - started) / 1000).toFixed(0)}s`);
    } catch (error) { console.log('Local pictures ERROR', String((error as Error).message).slice(0, 200)); }
  }

  // Moving pictures made here on this machine. It is the slow one, so it is asked for the shortest thing it makes,
  // and only when the founder passes --local: three minutes is a long time to keep somebody waiting on a check.
  const here = localClips();
  const hereHint = here.ready();
  if (hereHint) console.log('Local clips NOT SET UP:', hereHint);
  else if (!process.argv.includes('--local')) console.log(`Local clips READY (not run: about ${MINUTES_EACH} minutes a clip; pass --local to make one)`);
  else {
    const started = Date.now();
    try {
      const made = await here.broll({ prompt: 'slow drifting clouds over a quiet city at dawn', seconds: CLIP_SECONDS }, { report: (line: string) => console.log('  ·', line) });
      console.log(`Local clips OK an mp4 · ${(made.bytes.length / 1024).toFixed(0)} KB · ${((Date.now() - started) / 1000).toFixed(0)}s`);
    } catch (error) { console.log('Local clips ERROR', String((error as Error).message).slice(0, 200)); }
  }

  // Footage from the free ZeroGPU Spaces. A talking head needs a face and a line before it can say anything, so those
  // are made first by whichever picture and voice backends are already set up here.
  const clips = createClips();
  const hint = clips.ready();
  if (hint) console.log('Hugging Face NOT SET UP:', hint);
  else {
    const say = (line: string) => console.log('  ·', line);
    const timed = async (what: string, make: () => Promise<Piece>) => {
      const started = Date.now();
      try {
        console.log(`Hugging Face ${what} OK an mp4 · ${size(await make())} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } catch (error) { console.log(`Hugging Face ${what} ERROR`, String((error as Error).message).slice(0, 200)); }
    };
    await timed('b-roll', () => clips.broll({ prompt: 'slow drifting clouds over a quiet city at dawn', seconds: 3 }, { report: say }));
    const face = imageMakers().find((maker) => !maker.ready());
    const voice = voiceMakers(resolve(import.meta.dirname, '../.cache/voice')).find((maker) => !maker.ready());
    if (!face || !voice) console.log('Hugging Face presenter SKIPPED: it needs a picture and a voice backend set up to make the face and the line first');
    else {
      const portrait = await face.make({ prompt: 'head and shoulders portrait photograph of a person facing the camera, plain grey background' }, { report: say });
      const speech = await voice.make({ prompt: 'The studios are working.', voice: DEFAULT_VOICE }, { report: say });
      await timed('presenter', () => clips.presenter({ portrait: portrait.bytes, speech: speech.bytes }, { report: say }));
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
