// The studio's eyes: two small models that run here, on the processor, and look at a picture after it is drawn.
//
// Everything this studio knew about a picture it knew from the words the picture was asked for with. The words
// were policed hard — no "portrait", no "looking at the camera", no noun that summons lettering — and a proof film
// still came back with two strangers staring down the lens and a sheet of handwriting, because a picture model
// does what it likes and nothing ever looked at what it did. A rule about a picture that is only ever applied to
// a sentence is a rule about sentences.
//
// So it looks. One model answers questions about a picture in plain words (CLIP, MIT): is somebody looking
// straight at the camera, is there writing in it. The other says how far away every part of it is (Depth
// Anything V2 Small, Apache-2.0), which is what lets a still be cut into a far plane, a middle and a near one and
// moved the way a camera moving through a room moves them — the 2.5D parallax the long-form register is built on.
//
// Both are fetched once, about 180 MB together, and kept beside the voice model. Neither is needed: a machine
// that cannot load them makes the film it always made, from flat stills nobody looked at.

import { basename, join } from 'node:path';

// What was seen in one picture, each a share of certainty between nought and one.
export type Seen = { facing: number; lettered: number };
// A still in three planes, as file names beside the still itself.
export type Plies = { back: string; mid: string; fore: string };

export type Sight = {
  // Begin loading, so the models are in memory by the time the first picture arrives. Never throws, never waits.
  warm(): void;
  look(file: string): Promise<Seen | null>;
  plies(file: string): Promise<Plies | null>;
  // Why the last call came back with nothing, in words for the card: a first download still running, say.
  why(): string | null;
};

// --- the questions, and where the line is ---------------------------------------------------------------------

// Each question is its own set of answers, because certainty is shared out across whatever answers are offered:
// asked "facing, turned away, nobody, or writing?" in one go, a screen full of gibberish scored 0.16 for writing;
// asked about writing alone it scored 0.89.
export const ASKS = {
  gaze: ['a person looking straight at the camera', 'a person looking away from the camera', 'a photograph with no people in it'],
  text: ['handwriting on paper, a sign, a screen of text or a document', 'a photograph of a place, a thing or a person'],
} as const;

// Measured on this studio's own stills, not guessed. The portrait that opened a real reel scored 0.56 facing; two
// silhouettes in profile 0.31, and five documentary stills of people at work and turned away between 0.16 and
// 0.25. A sheet of writing and a screen of text scored 0.86 and 0.89 lettered, three typeset posters 0.75 to
// 0.77; a desk of blank paper and closed books 0.58, which is a desk and not a fault, and the portrait 0.32. The
// lines sit in the gaps, nearer the faults than the pictures that are fine: a needless redraw here is most of a
// minute.
export const FACING = 0.45;
export const LETTERED = 0.70;
export const facesLens = (seen: Seen | null | undefined): boolean => !!seen && seen.facing >= FACING;
export const isLettered = (seen: Seen | null | undefined): boolean => !!seen && seen.lettered >= LETTERED;
// The one number a redraw is judged by: how far over either line a picture is. Nought is a picture to keep.
export const fault = (seen: Seen | null | undefined): number =>
  (!seen ? 0 : Math.max(0, seen.facing - FACING) + Math.max(0, seen.lettered - LETTERED));

// --- where the planes are ---------------------------------------------------------------------------------------

// A depth map is one number a pixel, bright for near. Three planes are three clusters of those numbers, found
// the dull reliable way — k-means on the histogram, started from the same three percentiles every time, so the
// same picture is always cut in the same places. What comes back is the two depths the cuts are made at.
//
// Not every picture has three planes in it. A wall photographed square-on is one plane, and cutting it in three
// and sliding the pieces is a special effect applied to a photograph of a wall. Such a picture is refused, and it
// gets the flat push it always got, which is the honest move for a flat subject.
export const LEAST_SPREAD = 46;
export function planes(depth: ArrayLike<number>): { mid: number; fore: number } | null {
  const bins = new Array<number>(256).fill(0);
  for (let at = 0; at < depth.length; at += 1) bins[Math.max(0, Math.min(255, Math.round(depth[at])))] += 1;
  const total = depth.length;
  if (!total) return null;
  const percentile = (share: number): number => {
    let seen = 0;
    for (let level = 0; level < 256; level += 1) { seen += bins[level]; if (seen >= total * share) return level; }
    return 255;
  };
  let centres = [percentile(0.15), percentile(0.5), percentile(0.85)];
  for (let round = 0; round < 24; round += 1) {
    const sums = [0, 0, 0];
    const counts = [0, 0, 0];
    for (let level = 0; level < 256; level += 1) {
      if (!bins[level]) continue;
      let nearest = 0;
      for (let one = 1; one < 3; one += 1) if (Math.abs(level - centres[one]) < Math.abs(level - centres[nearest])) nearest = one;
      sums[nearest] += level * bins[level];
      counts[nearest] += bins[level];
    }
    const next = centres.map((was, one) => (counts[one] ? sums[one] / counts[one] : was));
    if (next.every((one, at) => Math.abs(one - centres[at]) < 0.25)) { centres = next; break; }
    centres = next;
  }
  centres.sort((a, b) => a - b);
  if (centres[2] - centres[0] < LEAST_SPREAD) return null;
  const mid = (centres[0] + centres[1]) / 2;
  const fore = (centres[1] + centres[2]) / 2;
  if (fore - mid < 10) return null;
  let far = 0;
  let near = 0;
  for (let level = 0; level < 256; level += 1) { if (level < mid) far += bins[level]; if (level >= fore) near += bins[level]; }
  // A near plane that is a sliver is a stray highlight; one that is most of the frame is a close-up with nothing
  // behind it. A far plane that has all but vanished leaves nothing for the near ones to move against.
  if (near / total < 0.04 || near / total > 0.72 || far / total < 0.08) return null;
  return { mid: Math.round(mid), fore: Math.round(fore) };
}

// How much of a pixel belongs to a plane, from its depth: a soft step across the cut, so a plane's edge is a
// gradient a few levels deep rather than a staircase.
export const SOFT = 9;
// How far past a cut a pixel has to be before what is behind it is guessed rather than kept. See `plies`.
export const CLEAR = 26;
export function alphaOf(depth: ArrayLike<number>, cut: number): Uint8Array {
  const out = new Uint8Array(depth.length);
  for (let at = 0; at < depth.length; at += 1) {
    const share = (depth[at] - (cut - SOFT)) / (2 * SOFT);
    const held = share <= 0 ? 0 : share >= 1 ? 1 : share * share * (3 - 2 * share);
    out[at] = Math.round(held * 255);
  }
  return out;
}

// What is behind a hole, guessed from what is around it: every pixel outside the hole is spread outwards and the
// spread is divided by how much of it arrived, which is a blur that ignores the hole. It is soft and it is wrong in
// detail and it does not matter: it is only ever seen in the sliver a near plane uncovers as it moves, behind a
// feathered edge, and what belongs there is an out-of-focus background. Without it that sliver shows the far
// plane's own copy of the subject, which reads as a ghost walking a step behind everybody.
export function filled(rgb: Uint8Array, hole: Uint8Array, width: number, height: number, reach: number): Uint8Array {
  const count = width * height;
  const blur = (from: Float32Array, by: number): Float32Array => {
    const across = new Float32Array(count);
    const down = new Float32Array(count);
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      for (let x = -by; x < width; x += 1) {
        if (x + by < width) sum += from[y * width + x + by];
        if (x - by - 1 >= 0) sum -= from[y * width + x - by - 1];
        if (x >= 0) across[y * width + x] = sum;
      }
    }
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let y = -by; y < height; y += 1) {
        if (y + by < height) sum += across[(y + by) * width + x];
        if (y - by - 1 >= 0) sum -= across[(y - by - 1) * width + x];
        if (y >= 0) down[y * width + x] = sum;
      }
    }
    return down;
  };
  const kept = new Float32Array(count);
  const paint = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  let outside = 0;
  const mean = [0, 0, 0];
  for (let at = 0; at < count; at += 1) {
    kept[at] = 1 - hole[at] / 255;
    outside += kept[at];
    for (let channel = 0; channel < 3; channel += 1) { paint[channel][at] = rgb[at * 3 + channel] * kept[at]; mean[channel] += paint[channel][at]; }
  }
  const out = new Uint8Array(count * 3);
  const done = new Uint8Array(count);
  let left = count;
  // The surroundings are carried in a little way, then twice as far, then twice as far again, and a pixel takes
  // the first answer that reaches it — so the rim of a hole is guessed from what is right beside it and only the
  // middle of a large one from further off. One reach for everything either never gets to the middle of a
  // person or smears the whole room into their outline.
  for (let by = Math.max(1, reach); left > 0 && by < Math.max(width, height) * 2; by *= 2) {
    let colour: Float32Array[] = paint;
    let weight: Float32Array = kept;
    // Three passes of a box is near enough a Gaussian.
    for (let pass = 0; pass < 3; pass += 1) { colour = colour.map((one) => blur(one, by)); weight = blur(weight, by); }
    const enough = (2 * by + 1) ** 6 * 0.02;
    for (let at = 0; at < count; at += 1) {
      if (done[at] || weight[at] < enough) continue;
      for (let channel = 0; channel < 3; channel += 1) out[at * 3 + channel] = Math.max(0, Math.min(255, Math.round(colour[channel][at] / weight[at])));
      done[at] = 1;
      left -= 1;
    }
  }
  // Nothing outside the hole at all: the picture's own colour, or grey. It cannot happen to a picture with planes.
  for (let at = 0; at < count && left > 0; at += 1) {
    if (done[at]) continue;
    for (let channel = 0; channel < 3; channel += 1) out[at * 3 + channel] = outside > 0 ? Math.round(mean[channel] / outside) : 128;
  }
  return out;
}

// --- the models ---------------------------------------------------------------------------------------------------

const LOOKS_WITH = process.env.STAGE_SIGHT_MODEL ?? 'Xenova/clip-vit-base-patch32';
const DEPTH_WITH = process.env.STAGE_DEPTH_MODEL ?? 'onnx-community/depth-anything-v2-small';
// A film does not wait for a download. A model that is not in memory by then is a model this film goes without;
// the fetch carries on behind it and the next film has it.
const PATIENCE = 25_000;
const RETRY_AFTER = 10 * 60_000;

type Answer = { label: string; score: number }[];
type Depth = { depth: { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: number } };

const within = <T>(job: Promise<T>, ms: number): Promise<T | 'late'> =>
  Promise.race([job, new Promise<'late'>((done) => { setTimeout(() => done('late'), ms).unref?.(); })]);

export function createSight(cacheDir: string): Sight {
  let clip: Promise<(file: string, labels: string[]) => Promise<Answer>> | null = null;
  let deep: Promise<(file: string) => Promise<Depth>> | null = null;
  let failed = 0;
  let said: string | null = null;
  // One picture at a time through either model: three hands draw at once, and three networks running at once on
  // the same cores each take three times as long.
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job, job);
    queue = next.catch(() => undefined);
    return next;
  };
  const load = async () => {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    return pipeline;
  };
  const resting = () => failed > 0 && Date.now() - failed < RETRY_AFTER;
  const broke = (which: 'clip' | 'deep') => () => { failed = Date.now(); if (which === 'clip') clip = null; else deep = null; return null; };
  const looker = () => {
    clip ??= (async () => (await (await load())('zero-shot-image-classification', LOOKS_WITH, { dtype: 'q8' })) as unknown as (file: string, labels: string[]) => Promise<Answer>)();
    clip.catch(broke('clip'));
    return clip;
  };
  const ranger = () => {
    deep ??= (async () => (await (await load())('depth-estimation', DEPTH_WITH, { dtype: 'q8' })) as unknown as (file: string) => Promise<Depth>)();
    deep.catch(broke('deep'));
    return deep;
  };
  const LEARNING = 'the studio is fetching what it needs to look at its own pictures (once, about 180 MB), so this film\'s pictures were not checked or cut into depth — the next film\'s will be';

  return {
    warm() { if (!resting()) { void looker().catch(() => undefined); void ranger().catch(() => undefined); } },
    why: () => { const was = said; said = null; return was; },
    async look(file) {
      if (resting()) return null;
      try {
        const ask = await within(looker(), PATIENCE);
        if (ask === 'late') { said = LEARNING; return null; }
        return await inTurn(async () => {
          const score = (answer: Answer, label: string) => answer.find((one) => one.label === label)?.score ?? 0;
          const gaze = await ask(file, [...ASKS.gaze]);
          const text = await ask(file, [...ASKS.text]);
          return { facing: score(gaze, ASKS.gaze[0]), lettered: score(text, ASKS.text[0]) };
        });
      } catch { return null; }
    },
    async plies(file) {
      if (resting()) return null;
      try {
        const range = await within(ranger(), PATIENCE);
        if (range === 'late') { said = LEARNING; return null; }
        return await inTurn(async () => {
          const { default: sharp } = await import('sharp');
          const { depth } = await range(file);
          const { data: rgb, info } = await sharp(file).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
          const { width, height } = info;
          // The map comes back at the picture's own size, one number a pixel; anything else is put right here.
          const map = depth.width === width && depth.height === height && depth.channels === 1
            ? depth.data
            : await sharp(Buffer.from(depth.data), { raw: { width: depth.width, height: depth.height, channels: depth.channels as 1 | 2 | 3 | 4 } })
              .extractChannel(0).resize(width, height, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer();
          const cuts = planes(map);
          if (!cuts) return null;

          const grey = (data: Uint8Array) => sharp(Buffer.from(data), { raw: { width, height, channels: 1 } });
          // One number a pixel, and said so: asked for raw bytes, a grey image comes back as three identical
          // channels unless it is told otherwise, and a mask read at a third of its length is stripes.
          const flat = (image: import('sharp').Sharp) => image.toColourspace('b-w').raw().toBuffer();
          const feather = Math.max(1.2, width / 640);
          const masks = {
            mid: await flat(grey(alphaOf(map, cuts.mid)).blur(feather)),
            fore: await flat(grey(alphaOf(map, cuts.fore)).blur(feather)),
          };
          // The hole a plane leaves in the one behind it is the plane grown by as far as it will ever travel
          // against it, and the guessing is done small: it is a blur, and a blur has no detail to lose.
          const small = { width: Math.max(32, Math.round(width / 6)), height: Math.max(32, Math.round(height / 6)) };
          const tiny = await sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } }).resize(small.width, small.height, { fit: 'fill' }).raw().toBuffer();
          const behind = async (mask: Buffer): Promise<Buffer> => {
            // Grown by as far as two neighbouring planes ever part company — a dozen pixels on a wide frame, from
            // the numbers in `DEPTH` — and no further: whatever is grown past the plane's own edge is guesswork
            // a viewer can see, a soft band round everybody, for the whole shot.
            const hole = await flat(grey(new Uint8Array(mask)).blur(Math.max(1.5, width * 0.006)).linear(5, 0));
            const holeSmall = await flat(grey(new Uint8Array(hole)).resize(small.width, small.height, { fit: 'fill' }));
            const guess = filled(new Uint8Array(tiny), new Uint8Array(holeSmall), small.width, small.height, Math.max(3, Math.round(small.width * 0.05)));
            const patch = await sharp(Buffer.from(guess), { raw: { width: small.width, height: small.height, channels: 3 } }).blur(1.6)
              .resize(width, height, { fit: 'fill', kernel: 'cubic' }).joinChannel(hole, { raw: { width, height, channels: 1 } }).png().toBuffer();
            return sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } }).composite([{ input: patch }]).removeAlpha().raw().toBuffer();
          };
          const cut = (pixels: Buffer, alpha: Buffer) => sharp(pixels, { raw: { width, height, channels: 3 } })
            .joinChannel(alpha, { raw: { width, height, channels: 1 } }).webp({ quality: 90, alphaQuality: 100 }).toBuffer();

          const stem = file.replace(/\.[a-z0-9]+$/i, '');
          const names = { back: `${stem}.back.webp`, mid: `${stem}.mid.webp`, fore: `${stem}.fore.webp` };
          const { writeFile } = await import('node:fs/promises');
          // What is filled in behind a plane is only what is well clear of the cut. At a real edge — a person
          // against a far wall — depth jumps straight past both lines and nothing changes. But a cut also runs
          // across things that have no edge there: a floor, a table, a torso leaning away. Filled right up to
          // such a cut, the plane behind shows its guess through the feathered seam, and a pale band of wall
          // colour lies across somebody's shoulders. Kept clear of it, the plane behind still has the real
          // pixels under the seam and the seam cannot be seen.
          const clear = async (cut: number) => flat(grey(alphaOf(map, Math.min(250, cut + CLEAR))).blur(feather));
          const farPlane = await behind(await clear(cuts.mid));
          const midPlane = await behind(await clear(cuts.fore));
          await writeFile(names.back, await sharp(farPlane, { raw: { width, height, channels: 3 } }).webp({ quality: 90 }).toBuffer());
          await writeFile(names.mid, await cut(midPlane, masks.mid));
          await writeFile(names.fore, await cut(Buffer.from(rgb), masks.fore));
          return { back: basename(names.back), mid: basename(names.mid), fore: basename(names.fore) };
        });
      } catch { return null; }
    },
  };
}

// Where the models are kept, beside the voice and the music.
export const sightDir = (cacheDir: string): string => join(cacheDir, 'sight');
