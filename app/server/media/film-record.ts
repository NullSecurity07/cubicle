import type { Shape } from '../../shared/model.ts';
import type { Mood } from './audio.ts';
import { lineHash, type FilmRecord, type RecordLine, type RecordPicture, type RecordScene, type RecordShot } from './edits.ts';
import type { Scene, Spec } from './spec.ts';
import type { Pack, Pace } from './templates/looks.ts';
import type { Word } from './timings.ts';
import { wavOf } from './voice.ts';

// What a film writes down about itself, so a note on it can be acted on without making it again: the storyboard
// it was rendered from, every shot's own picture in the parts folder, and where each scene's line sits in the one
// reading. Nothing here reads a disk or runs a program.

// A file's name inside the parts folder, which is flat. The hand-editable export names them the same way, so the
// `.mlt`, the record and the folder always agree.
export const partName = (name: string): string => {
  const safe = (name.split(/[\\/]/).pop() ?? '').replace(/[^\w.-]+/g, '-');
  return safe && !safe.startsWith('.') ? safe : '';
};

// Where each scene's line starts and stops in the one reading. A cut between two lines goes half way through the
// breath between them, so every line keeps its own breath and nothing of the next one.
export function lineSegments(words: Word[], counts: number[], total: number): ({ from: number; to: number; words: Word[] } | undefined)[] {
  const spans: { from: number; to: number }[] = [];
  let counted = 0;
  for (const count of counts) { spans.push({ from: counted, to: counted + count }); counted += count; }
  const spoken = spans.map((span, at) => (span.to > span.from && words[span.to - 1] ? at : -1)).filter((at) => at >= 0);
  return spans.map((span, at) => {
    const place = spoken.indexOf(at);
    if (place < 0) return undefined;
    const first = words[span.from];
    const last = words[span.to - 1];
    const before = place > 0 ? spans[spoken[place - 1]] : null;
    const after = place < spoken.length - 1 ? spans[spoken[place + 1]] : null;
    const from = before ? (words[before.to - 1].at + words[before.to - 1].seconds + first.at) / 2 : 0;
    const to = after ? (last.at + last.seconds + words[after.from].at) / 2 : Math.max(total, last.at + last.seconds);
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return { from: round(from), to: round(to), words: words.slice(span.from, span.to).map((one) => ({ ...one, at: round(one.at - from) })) };
  });
}

// One film's record, from what the studio knew when it rendered it. `pictures` says what made each file; a file
// the studio cannot account for is a founder's own and is never drawn again.
export function recordOf(film: {
  title: string; spec: Spec; shape: Shape; look: Pack; pace: Pace; captions: boolean; sfx: boolean; music: Mood; bible: string;
  // Every shot as rendered, with the scene it belongs to.
  shots: (RecordShot & { scene: number })[];
  narrator?: { voice: string; engine?: string; design?: string; file: string; seconds: number };
  words?: Word[];
  pictures: Record<string, RecordPicture>;
  bed?: FilmRecord['bed'];
  brand?: FilmRecord['brand'];
  // How many of the words are each scene's, where that is not simply the words of its line: a line that could not
  // be said again is a silence, and has none.
  counts?: number[];
}): FilmRecord {
  const counts = film.counts ?? film.spec.scenes.map((scene) => (scene.say ?? '').trim().split(/\s+/).filter(Boolean).length);
  const segments = film.narrator && film.words?.length ? lineSegments(film.words, counts, film.narrator.seconds) : [];
  const name = (file?: string) => (file ? partName(file) || undefined : undefined);
  const scenes: RecordScene[] = film.spec.scenes.map((scene: Scene, at): RecordScene => {
    const shots = film.shots.filter((one) => one.scene === at).map(({ scene: _scene, ...shot }): RecordShot => ({
      ...shot,
      image: name(shot.image), bg: name(shot.bg), video: name(shot.video),
      plies: shot.plies ? { back: partName(shot.plies.back), mid: partName(shot.plies.mid), fore: partName(shot.plies.fore) } : undefined,
      voice: shot.voice ? { file: partName(shot.voice.file), seconds: shot.voice.seconds } : undefined,
    }));
    const segment = segments[at];
    const line: RecordLine | undefined = segment && film.narrator
      ? { ...segment, hash: lineHash(scene.say ?? '', film.narrator.voice, film.narrator.engine, film.narrator.design) }
      : undefined;
    return { shots, ...(line ? { line } : {}) };
  });
  const pictures: Record<string, RecordPicture> = {};
  for (const [file, what] of Object.entries(film.pictures)) if (partName(file)) pictures[partName(file)] = what;
  return {
    kind: 'film', version: 1,
    title: film.title, spec: film.spec, shape: film.shape, look: film.look, pace: film.pace, captions: film.captions, sfx: film.sfx, music: film.music,
    bible: film.bible,
    // A product's typeface stays with the product; a remade film sets the brand's colours in the look's own type.
    ...(film.brand ? { brand: { ...film.brand, fontFile: undefined } } : {}),
    ...(film.narrator ? { narrator: { ...film.narrator, file: partName(film.narrator.file) } } : {}),
    scenes, pictures,
    ...(film.bed ? { bed: { ...film.bed, source: partName(film.bed.source) } } : {}),
  };
}

// --- sound, as samples ---------------------------------------------------------------------------------------------
//
// A kept line is a slice of the old reading and a new one is a recording of its own, and the two are laid end to
// end here as plain samples. No program is run for it, so a test can check it and a machine without ffmpeg can do it.

export type Pcm = { rate: number; samples: Float32Array };

export function readPcm(bytes: Buffer): Pcm | null {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  let format = 0;
  let channels = 1;
  let rate = 0;
  let bits = 16;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      format = bytes.readUInt16LE(at + 8);
      channels = bytes.readUInt16LE(at + 10);
      rate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    } else if (id === 'data') {
      const end = Math.min(bytes.length, at + 8 + size);
      const width = bits / 8;
      const frames = Math.floor((end - at - 8) / (width * channels));
      const samples = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel += 1) {
          const where = at + 8 + (frame * channels + channel) * width;
          sum += format === 3 && bits === 32 ? bytes.readFloatLE(where) : bits === 16 ? bytes.readInt16LE(where) / 32768 : bits === 8 ? (bytes[where] - 128) / 128 : bits === 32 ? bytes.readInt32LE(where) / 2147483648 : 0;
        }
        samples[frame] = sum / channels;
      }
      return rate ? { rate, samples } : null;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

export const pcmSeconds = (pcm: Pcm): number => pcm.samples.length / pcm.rate;
export const silence = (seconds: number, rate: number): Pcm => ({ rate, samples: new Float32Array(Math.max(0, Math.round(seconds * rate))) });
export const slicePcm = (pcm: Pcm, from: number, to: number): Pcm => ({
  rate: pcm.rate,
  samples: pcm.samples.slice(Math.max(0, Math.round(from * pcm.rate)), Math.max(0, Math.min(pcm.samples.length, Math.round(to * pcm.rate)))),
});
// A recording at another rate, brought to this one by straight lines between samples: plenty for a spoken line.
export function atRate(pcm: Pcm, rate: number): Pcm {
  if (pcm.rate === rate) return pcm;
  const length = Math.round((pcm.samples.length * rate) / pcm.rate);
  const out = new Float32Array(length);
  for (let at = 0; at < length; at += 1) {
    const where = (at * pcm.rate) / rate;
    const low = Math.floor(where);
    const high = Math.min(pcm.samples.length - 1, low + 1);
    const part = where - low;
    out[at] = (pcm.samples[low] ?? 0) * (1 - part) + (pcm.samples[high] ?? 0) * part;
  }
  return { rate, samples: out };
}
export function joinPcm(pieces: Pcm[], rate: number): Pcm {
  const fitted = pieces.map((one) => atRate(one, rate));
  const out = new Float32Array(fitted.reduce((sum, one) => sum + one.samples.length, 0));
  let at = 0;
  for (const one of fitted) { out.set(one.samples, at); at += one.samples.length; }
  return { rate, samples: out };
}
export const wavOfPcm = (pcm: Pcm): Buffer => wavOf(pcm.samples, pcm.rate);
