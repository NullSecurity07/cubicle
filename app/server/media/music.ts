import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ff, FFMPEG } from './ff.ts';

// The bed under a film, found or made, and never one the founder could be sued over.
//
// The rule this whole file is built around: **a founder may sell the film.** So nothing here touches a track whose
// terms are non-commercial, no-derivatives, share-alike or simply not stated. Three layers, best first:
//
//  1. **Openverse** (`api.openverse.org`) searched for `cc0` and `pdm` music — no key, no account, no card. Every
//     candidate's licence field is read and checked against a short allow-list before a byte is downloaded; anything
//     unrecognised is dropped rather than guessed at. A track is fetched once into the cache and never again, so the
//     second film on a plane still has music. Freesound is the same idea behind a free key, and is only asked when
//     the founder has put one in `.env`.
//  2. **Nothing local, yet.** Of the models that could write a tune on this machine, MusicGen's weights are
//     CC-BY-NC — a founder could not sell the film — and Stable Audio Open is behind a gate and a community licence
//     of its own. ACE-Step is the one whose terms are fine (MIT), and `acestep.cpp` does have a processor backend,
//     but nobody has published what twenty seconds costs on a processor, and this box has four gigabytes of video
//     memory, which is to say none for this. Shipping several gigabytes of weights on an unmeasured guess is how a
//     card ends up spinning for twenty minutes, so there is no layer two — only a measurement waiting to be made.
//  3. **A bed made here, in this file, out of arithmetic.** No model, no network, no file: chords, a bass and a
//     little percussion written a sample at a time. It is the last resort and it is always there, so `bed()` never
//     fails for want of a network. Nobody owns arithmetic, so its credit says CC0 and means it.
//
// What comes back is a finished bed: exactly the seconds asked for, its seam folded so it loops, and normalised to
// about −23 LUFS so the ducking in `audio.ts` has room to work. It carries no musical fade in or out, because
// `musicBed()` puts those on the film's own clock and a bed faded twice arrives late.

export const MOODS = ['upbeat', 'calm', 'cinematic', 'tech', 'warm', 'playful', 'dramatic'] as const;
export type Mood = (typeof MOODS)[number];
// Who made the music, on what terms, and where it came from — recorded for every bed, including the made ones.
export type Credit = { title: string; by: string; licence: string; source: string };
export type Music = {
  bed(
    ask: { mood: Mood; seconds: number; bpm?: number },
    help: { report: (line: string) => void; signal?: AbortSignal },
  ): Promise<{ ext: 'wav' | 'mp3' | 'ogg'; bytes: Buffer; credit: Credit; bpm?: number; beats?: number[] }>;
};

const RATE = 44_100;
const MIN_SECONDS = 4;
const MAX_SECONDS = 300;
const TARGET_LUFS = -23;

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Licences: the short list of terms a founder may sell a film under, and nothing else.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Keyed by the lower-cased licence code the search gives back. `credit` means the film has to name the author, which
// is a cost, so those sort last — but they are still allowed, because the credit really is recorded and said out loud.
export const LICENCES: Record<string, { label: string; note: string; credit: boolean }> = {
  cc0: { label: 'CC0', note: 'public domain, no attribution asked', credit: false },
  'creative commons 0': { label: 'CC0', note: 'public domain, no attribution asked', credit: false },
  pdm: { label: 'Public Domain Mark', note: 'no known copyright', credit: false },
  'public domain': { label: 'Public domain', note: 'no known copyright', credit: false },
  by: { label: 'CC BY', note: 'commercial use allowed, the author must be credited', credit: true },
  attribution: { label: 'CC BY', note: 'commercial use allowed, the author must be credited', credit: true },
};

// Read strictly: a licence this does not recognise is a licence nobody has checked, and an unchecked licence is a
// lawsuit rather than a saving. `nc` forbids selling, `nd` forbids cutting it into a film, and `sa` would put the
// founder's own film under the same terms — all three are refused by name as well as by not being on the list.
export function licenceOf(code: unknown, version?: unknown): { name: string; credit: boolean } | null {
  if (typeof code !== 'string') return null;
  const clean = code.trim().toLowerCase();
  if (!clean) return null;
  if (/(^|[-\s])(nc|nd|sa|sampling|nc-sa|nc-nd)([-\s]|$)/.test(clean)) return null;
  const found = LICENCES[clean];
  if (!found) return null;
  const said = typeof version === 'string' && version.trim() ? ` ${version.trim()}` : '';
  return { name: `${found.label}${said} (${found.note})`, credit: found.credit };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A small deterministic dice, so two films in a row are not scored with the same track or the same key.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function hashOf(text: string): number {
  let hash = 2_166_136_261;
  for (let at = 0; at < text.length; at += 1) hash = Math.imul(hash ^ text.charCodeAt(at), 16_777_619);
  return hash >>> 0;
}
const diceOf = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mix = Math.imul(state ^ (state >>> 15), 1 | state);
    mix = (mix + Math.imul(mix ^ (mix >>> 7), 61 | mix)) ^ mix;
    return ((mix ^ (mix >>> 14)) >>> 0) / 4_294_967_296;
  };
};

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// What each mood is, musically and in words: how the bed is written, and what a search is asked for.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const CHORDS = {
  maj: [0, 4, 7], min: [0, 3, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10],
  add9: [0, 4, 7, 14], min9: [0, 3, 7, 10, 14], maj9: [0, 4, 7, 11, 14],
  six: [0, 4, 7, 9], sus2: [0, 2, 7], sus4: [0, 5, 7],
} as const;
type Quality = keyof typeof CHORDS;
type Step = [number, Quality];

type Shape = {
  bpm: number;
  keys: number[];               // the roots this mood sits well in, as semitones above C
  runs: Step[][];               // a few progressions; one is picked per film
  wave: 'saw' | 'tri' | 'sine'; // what the pad is made of
  attack: number; release: number; cut: number; glow: number; // how the pad breathes, how bright it is, how much air
  bass: 'sub' | 'round' | 'pulse' | 'none';
  beat: 'none' | 'soft' | 'four' | 'tick' | 'pulse';
  arp: number;                  // how much of an arpeggio sits over the pad, 0 to 1
  room: number;                 // how much of it is reverberation
  terms: string[];              // what a search is asked for, best first
};

// Seven moods, each a different piece of music rather than the same piece at a different speed. The progressions are
// ordinary — I–V–vi–IV and its cousins — on purpose: a bed is furniture, and furniture that asks to be looked at is
// bad furniture.
export const SHAPES: Record<Mood, Shape> = {
  upbeat: {
    bpm: 112, keys: [0, 2, 5, 7], wave: 'saw', attack: 0.06, release: 0.5, cut: 2600, glow: 0.5,
    bass: 'round', beat: 'four', arp: 0.7, room: 0.22,
    runs: [
      [[0, 'add9'], [7, 'maj'], [9, 'min7'], [5, 'maj9']],
      [[5, 'maj9'], [7, 'maj'], [0, 'add9'], [9, 'min7']],
      [[0, 'six'], [9, 'min7'], [5, 'maj7'], [7, 'sus4']],
    ],
    terms: ['upbeat loop', 'happy music', 'energetic loop', 'pop instrumental'],
  },
  calm: {
    bpm: 68, keys: [0, 5, 7, 9], wave: 'tri', attack: 1.6, release: 2.4, cut: 1400, glow: 0.8,
    bass: 'sub', beat: 'none', arp: 0.25, room: 0.5,
    runs: [
      [[0, 'maj9'], [9, 'min9'], [5, 'maj9'], [7, 'sus4']],
      [[5, 'maj7'], [0, 'maj9'], [9, 'min7'], [2, 'min9']],
      [[0, 'sus2'], [5, 'maj9'], [0, 'sus2'], [7, 'sus4']],
    ],
    terms: ['calm ambient', 'ambient loop', 'peaceful music', 'relaxing loop'],
  },
  cinematic: {
    bpm: 76, keys: [0, 2, 4, 9], wave: 'saw', attack: 1.1, release: 2.2, cut: 1800, glow: 0.75,
    bass: 'sub', beat: 'soft', arp: 0.2, room: 0.55,
    runs: [
      [[0, 'min9'], [8, 'maj7'], [3, 'maj9'], [10, 'maj']],
      [[0, 'min7'], [5, 'min7'], [8, 'maj7'], [7, 'sus4']],
      [[8, 'maj9'], [10, 'maj'], [0, 'min9'], [3, 'maj7']],
    ],
    terms: ['cinematic music', 'epic orchestral', 'cinematic loop', 'orchestral music'],
  },
  tech: {
    bpm: 120, keys: [0, 2, 7, 10], wave: 'saw', attack: 0.02, release: 0.35, cut: 2200, glow: 0.4,
    bass: 'pulse', beat: 'pulse', arp: 0.85, room: 0.3,
    runs: [
      [[0, 'min9'], [8, 'maj7'], [3, 'maj'], [10, 'maj']],
      [[0, 'min7'], [10, 'maj'], [8, 'maj7'], [0, 'min7']],
      [[0, 'sus4'], [0, 'min7'], [5, 'min9'], [10, 'maj']],
    ],
    terms: ['electronic loop', 'synth loop', 'techno loop', 'electronic music'],
  },
  warm: {
    bpm: 84, keys: [0, 5, 7, 9], wave: 'tri', attack: 0.5, release: 1.4, cut: 1700, glow: 0.65,
    bass: 'round', beat: 'soft', arp: 0.55, room: 0.38,
    runs: [
      [[5, 'maj7'], [0, 'add9'], [9, 'min7'], [7, 'sus4']],
      [[0, 'maj7'], [2, 'min7'], [7, 'sus4'], [0, 'six']],
      [[9, 'min7'], [5, 'maj9'], [0, 'add9'], [7, 'maj']],
    ],
    terms: ['acoustic loop', 'guitar loop', 'warm instrumental', 'lounge music'],
  },
  playful: {
    bpm: 126, keys: [0, 2, 5, 7], wave: 'tri', attack: 0.02, release: 0.3, cut: 3000, glow: 0.45,
    bass: 'round', beat: 'tick', arp: 0.95, room: 0.25,
    runs: [
      [[0, 'maj'], [9, 'min7'], [2, 'min7'], [7, 'maj']],
      [[0, 'six'], [5, 'maj'], [7, 'maj'], [0, 'add9']],
      [[2, 'min7'], [7, 'sus4'], [0, 'six'], [9, 'min7']],
    ],
    terms: ['playful music', 'quirky loop', 'ukulele loop', 'chiptune music'],
  },
  dramatic: {
    bpm: 96, keys: [0, 2, 4, 9], wave: 'saw', attack: 0.25, release: 1.1, cut: 1600, glow: 0.6,
    bass: 'sub', beat: 'pulse', arp: 0.5, room: 0.45,
    runs: [
      [[0, 'min'], [5, 'min7'], [8, 'maj'], [7, 'maj']],
      [[0, 'min9'], [8, 'maj'], [5, 'min7'], [10, 'maj']],
      [[0, 'min7'], [0, 'min7'], [8, 'maj7'], [7, 'sus4']],
    ],
    terms: ['dramatic music', 'tension loop', 'dark ambient', 'suspense music'],
  },
};

export const isMood = (word: unknown): word is Mood => MOODS.includes(word as Mood);
// "a upbeat bed" is a line nobody wrote on purpose.
const article = (word: string) => ('aeiou'.includes(word[0]) ? 'an' : 'a');

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The instrument. Everything below here writes numbers into two arrays of samples; nothing else is involved.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const TABLE = 2048;
// How much of a note escapes its filter unchanged, and where a hat's band begins. Both were set by looking at a
// spectrogram of a real render rather than by reasoning about them.
const AIR = 0.07;
// A one-pole high-pass keeps `c/(1-c)` of what it had: 0.7 puts the corner near three kilohertz, which is where a
// hat starts and below which it is only mud under the bass.
const HAT_HIGH = 0.7;
// One cycle of a wave, built out of its harmonics rather than drawn as a shape, so it has no edges to alias. Four
// tables a wave, each with half the harmonics of the last: a high note reads a plain one and stays clean.
const cycles = new Map<string, Float32Array>();
function cycleOf(wave: 'saw' | 'tri' | 'sine', partials: number): Float32Array {
  const key = `${wave}:${partials}`;
  const known = cycles.get(key);
  if (known) return known;
  const made = new Float32Array(TABLE);
  for (let harmonic = 1; harmonic <= partials; harmonic += 1) {
    if (wave === 'sine' && harmonic > 1) break;
    if (wave === 'tri' && harmonic % 2 === 0) continue;
    const level = wave === 'saw' ? 1 / harmonic : wave === 'tri' ? (harmonic % 4 === 1 ? 1 : -1) / (harmonic * harmonic) : 1;
    for (let at = 0; at < TABLE; at += 1) made[at] += level * Math.sin((2 * Math.PI * harmonic * at) / TABLE);
  }
  let loudest = 0;
  for (const value of made) loudest = Math.max(loudest, Math.abs(value));
  if (loudest > 0) for (let at = 0; at < TABLE; at += 1) made[at] /= loudest;
  cycles.set(key, made);
  return made;
}
// How many harmonics this note can carry before they fold back down as noise.
const partialsFor = (hz: number) => (hz < 120 ? 48 : hz < 320 ? 24 : hz < 900 ? 12 : 6);

const hzOf = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

// One note: what it is made of, when it starts, how long it is held, and where it sits.
type Note = { at: number; held: number; hz: number; wave: 'saw' | 'tri' | 'sine'; gain: number; pan: number; attack: number; release: number; cut: number; detune: number };

// A note played into the two channels. Three copies a note, a few cents apart, is what makes a pad a pad rather than
// an organ; a one-pole filter takes the fizz off the top and opens a little as the note arrives.
function play(left: Float32Array, right: Float32Array, note: Note) {
  const start = Math.max(0, Math.round(note.at * RATE));
  const length = Math.round((note.held + note.release) * RATE);
  const stop = Math.min(left.length, start + length);
  if (stop <= start) return;
  const table = cycleOf(note.wave, partialsFor(note.hz));
  const copies = note.detune > 0 ? 3 : 1;
  const spread = [0, -note.detune, note.detune];
  const phases = [0, 0.31, 0.67];
  const level = note.gain / copies;
  const heldFor = Math.round(note.held * RATE);
  const attackFor = Math.max(1, Math.round(note.attack * RATE));
  const releaseFor = Math.max(1, Math.round(note.release * RATE));
  const leftGain = Math.cos(((note.pan + 1) * Math.PI) / 4);
  const rightGain = Math.sin(((note.pan + 1) * Math.PI) / 4);
  for (let copy = 0; copy < copies; copy += 1) {
    // The copies sit a few cents apart, not a few semitones: that small a difference is width, not a chord.
    const step = ((note.hz * 2 ** (spread[copy] / 1200)) * TABLE) / RATE;
    let phase = phases[copy] * TABLE;
    let held = 0;
    for (let at = start; at < stop; at += 1) {
      const age = at - start;
      // A shape that rises over the attack, sits, and lets go: no clicks at either end.
      const envelope = age < attackFor
        ? age / attackFor
        : age < heldFor
          ? 1 - 0.18 * Math.min(1, (age - attackFor) / (RATE * 2))
          : Math.max(0, 1 - (age - heldFor) / releaseFor) ** 2;
      // The filter opens with the note and closes again with it, which is most of what "warm" means.
      const open = note.cut * (0.55 + 0.45 * Math.min(1, age / (attackFor * 1.5)));
      const coefficient = 1 - Math.exp((-2 * Math.PI * open) / RATE);
      const whole = phase | 0;
      const fraction = phase - whole;
      const first = table[whole % TABLE];
      const raw = first + (table[(whole + 1) % TABLE] - first) * fraction;
      held += coefficient * (raw - held);
      // A little of it left unfiltered. Without this a pad is a blanket over the speaker: the ear reads the top of a
      // sound as the sound being there at all, and a bed you cannot hear is a bed the founder turns up.
      const value = (held * (1 - AIR) + raw * AIR) * envelope * level;
      left[at] += value * leftGain;
      right[at] += value * rightGain;
      phase += step;
      if (phase >= TABLE) phase -= TABLE;
    }
  }
}

// The drums, such as they are: a bed's percussion is felt rather than heard, so every one of these is short, quiet
// and made of the two things a drum really is — a falling sine and a burst of noise.
function hit(left: Float32Array, right: Float32Array, kind: 'kick' | 'hat' | 'shaker' | 'tom', at: number, gain: number, dice: () => number) {
  const start = Math.round(at * RATE);
  const length = Math.round((kind === 'kick' ? 0.42 : kind === 'tom' ? 0.34 : kind === 'hat' ? 0.06 : 0.09) * RATE);
  const stop = Math.min(left.length, start + length);
  const pan = kind === 'hat' ? 0.22 : kind === 'shaker' ? -0.26 : 0;
  const leftGain = Math.cos(((pan + 1) * Math.PI) / 4);
  const rightGain = Math.sin(((pan + 1) * Math.PI) / 4);
  let phase = 0;
  let high = 0;
  let low = 0;
  let last = 0;
  for (let index = start; index < stop; index += 1) {
    if (index < 0) continue;
    const age = (index - start) / RATE;
    let value = 0;
    if (kind === 'kick') {
      const hz = 46 + 120 * Math.exp(-age * 38);
      phase += (2 * Math.PI * hz) / RATE;
      value = Math.sin(phase) * Math.exp(-age * 9);
    } else if (kind === 'tom') {
      const hz = 58 + 58 * Math.exp(-age * 16);
      phase += (2 * Math.PI * hz) / RATE;
      value = Math.sin(phase) * Math.exp(-age * 7);
    } else {
      // A hat is noise with a band taken out of the middle of it: the bottom removed so it does not muddy the bass,
      // and the very top removed too, because white noise all the way to twenty kilohertz is a hiss, not a cymbal.
      const noise = dice() * 2 - 1;
      high = HAT_HIGH * (high + noise - last);
      last = noise;
      low += (kind === 'hat' ? 0.52 : 0.34) * (high - low);
      value = low * Math.exp(-age * (kind === 'hat' ? 110 : 60)) * (kind === 'hat' ? 1.6 : 1.1);
    }
    const level = value * gain;
    left[index] += level * leftGain;
    right[index] += level * rightGain;
  }
}

// A plain Schroeder reverberation: four comb filters into two all-pass filters, a few samples apart between the two
// channels so it has a width. It is old and it is cheap and on a pad it is the difference between a sound and a room.
function room(left: Float32Array, right: Float32Array, wet: number, size: number) {
  if (wet <= 0) return;
  const combs = [1557, 1617, 1491, 1422];
  const allpass = [225, 556];
  const feedback = 0.74 + 0.16 * size;
  for (const [channel, offset] of [[left, 0], [right, 23]] as [Float32Array, number][]) {
    const wetted = new Float32Array(channel.length);
    for (const length of combs) {
      const line = new Float32Array(length + offset);
      let cursor = 0;
      let damp = 0;
      for (let at = 0; at < channel.length; at += 1) {
        const out = line[cursor];
        wetted[at] += out * 0.25;
        damp += 0.42 * (out - damp);
        line[cursor] = channel[at] + damp * feedback;
        cursor = (cursor + 1) % line.length;
      }
    }
    for (const length of allpass) {
      const line = new Float32Array(length + offset);
      let cursor = 0;
      for (let at = 0; at < channel.length; at += 1) {
        const out = line[cursor];
        const value = wetted[at];
        line[cursor] = value + out * 0.5;
        wetted[at] = out - value;
        cursor = (cursor + 1) % line.length;
      }
    }
    for (let at = 0; at < channel.length; at += 1) channel[at] = channel[at] * (1 - wet * 0.4) + wetted[at] * wet;
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Loudness, measured the way broadcasters measure it (ITU-R BS.1770-4), so "quiet enough to talk over" is a number
// rather than an opinion. K-weighting, four-hundred-millisecond blocks, the absolute gate and then the relative one.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function kWeighted(samples: Float32Array, rate: number): Float32Array {
  const out = Float32Array.from(samples);
  const biquad = (data: Float32Array, b0: number, b1: number, b2: number, a1: number, a2: number) => {
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    for (let at = 0; at < data.length; at += 1) {
      const x0 = data[at];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      data[at] = y0;
    }
  };
  // Stage one, the shelf that stands in for a head; stage two, the high-pass that stands in for not hearing the sub.
  const shelfK = Math.tan((Math.PI * 1681.974450955533) / rate);
  const shelfQ = 0.7071752369554196;
  const high = 10 ** (3.999843853973347 / 20);
  const band = high ** 0.4996667741545416;
  const shelf0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  biquad(out,
    (high + (band * shelfK) / shelfQ + shelfK * shelfK) / shelf0,
    (2 * (shelfK * shelfK - high)) / shelf0,
    (high - (band * shelfK) / shelfQ + shelfK * shelfK) / shelf0,
    (2 * (shelfK * shelfK - 1)) / shelf0,
    (1 - shelfK / shelfQ + shelfK * shelfK) / shelf0);
  const passK = Math.tan((Math.PI * 38.13547087602444) / rate);
  const passQ = 0.5003270373238773;
  const pass0 = 1 + passK / passQ + passK * passK;
  biquad(out, 1, -2, 1, (2 * (passK * passK - 1)) / pass0, (1 - passK / passQ + passK * passK) / pass0);
  return out;
}

export function loudness(left: Float32Array, right: Float32Array, rate = RATE): number {
  const block = Math.round(rate * 0.4);
  const hop = Math.round(block / 4);
  if (left.length < block) return -70;
  const channels = [kWeighted(left, rate), kWeighted(right, rate)];
  const powers: number[] = [];
  for (let start = 0; start + block <= left.length; start += hop) {
    let sum = 0;
    for (const channel of channels) {
      let square = 0;
      for (let at = start; at < start + block; at += 1) square += channel[at] * channel[at];
      sum += square / block;
    }
    powers.push(sum);
  }
  if (!powers.length) return -70;
  const loud = (power: number) => -0.691 + 10 * Math.log10(Math.max(power, 1e-20));
  const above = (gate: number) => powers.filter((power) => loud(power) > gate);
  const mean = (list: number[]) => list.reduce((sum, one) => sum + one, 0) / Math.max(1, list.length);
  const first = above(-70);
  if (!first.length) return -70;
  const second = above(loud(mean(first)) - 10);
  return loud(mean(second.length ? second : first));
}

// Bring a bed to the level a narrated film wants: one gain for the whole thing (loudness moves with gain, so one pass
// is enough), then a soft ceiling so a stray peak rounds over instead of squaring off.
export function toLevel(left: Float32Array, right: Float32Array, target = TARGET_LUFS, rate = RATE): number {
  const measured = loudness(left, right, rate);
  if (measured <= -69) return 0;
  const gain = 10 ** ((target - measured) / 20);
  for (let at = 0; at < left.length; at += 1) {
    left[at] = Math.tanh((left[at] * gain) / 0.85) * 0.85;
    right[at] = Math.tanh((right[at] * gain) / 0.85) * 0.85;
  }
  return gain;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// WAV in and out. Sixteen bits, two channels: what ffmpeg, WebKit and every player on earth read without argument.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function wavOf(left: Float32Array, right: Float32Array, rate = RATE): Buffer {
  const body = Buffer.alloc(left.length * 4);
  for (let at = 0; at < left.length; at += 1) {
    body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[at])) * 32_767), at * 4);
    body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[at])) * 32_767), at * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

// The samples back out of a WAV, both channels. Anything with one channel hands the same array back twice, which is
// what a mono file is.
export function pcmOf(bytes: Buffer): { left: Float32Array; right: Float32Array; rate: number } {
  const nothing = { left: new Float32Array(0), right: new Float32Array(0), rate: RATE };
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') return nothing;
  const rate = bytes.readUInt32LE(24) || RATE;
  const channels = Math.max(1, bytes.readUInt16LE(22));
  const bits = bytes.readUInt16LE(34);
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString('ascii', at, at + 4) === 'data') {
      const from = at + 8;
      const bytesPer = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.length - from) / (bytesPer * channels));
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      const read = (cursor: number) => (bits === 16 ? bytes.readInt16LE(cursor) / 32_768 : bits === 32 ? bytes.readFloatLE(cursor) : (bytes[cursor] - 128) / 128);
      for (let frame = 0; frame < frames; frame += 1) {
        const first = from + frame * channels * bytesPer;
        left[frame] = read(first);
        right[frame] = channels > 1 ? read(first + bytesPer) : left[frame];
      }
      return { left, right, rate };
    }
    at += 8 + size + (size % 2);
  }
  return { ...nothing, rate };
}

// One channel out of two — all the beat finder needs.
export function monoOf(bytes: Buffer): { samples: Float32Array; rate: number } {
  const { left, right, rate } = pcmOf(bytes);
  const samples = new Float32Array(left.length);
  for (let at = 0; at < left.length; at += 1) samples[at] = (left[at] + right[at]) / 2;
  return { samples, rate };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Where the beats are. The editor cuts on them, so a bed that cannot say where its beats are is half a bed.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const HOP = 512;
// How much louder each moment is than the one before it, which is as much as an onset is. Rectified: getting quieter
// is not an onset, and counting it as one finds the beat between the beats.
export function onsetsOf(samples: Float32Array): Float32Array {
  const frames = Math.max(0, Math.floor(samples.length / HOP) - 1);
  const strength = new Float32Array(frames);
  let last = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let square = 0;
    for (let at = frame * HOP; at < (frame + 1) * HOP; at += 1) square += samples[at] * samples[at];
    const level = Math.log1p(Math.sqrt(square / HOP) * 200);
    strength[frame] = Math.max(0, level - last);
    last = level;
  }
  return strength;
}

// The pulse, found by asking the onsets how well they agree with themselves at every spacing between 60 and 180 beats
// a minute, and then asking where in the bar to start. No library: an autocorrelation is eight lines.
export function beatsOf(samples: Float32Array, rate = RATE, seconds = samples.length / rate): { bpm: number; beats: number[] } | null {
  const strength = onsetsOf(samples);
  if (strength.length < 40) return null;
  const perFrame = HOP / rate;
  const lowest = Math.round(60 / 180 / perFrame);
  const highest = Math.round(60 / 60 / perFrame);
  // With its own average taken out. An onset strength is never negative, so leaving the average in makes every lag
  // agree with every other one and the shortest lag wins whatever the music is doing.
  let average = 0;
  for (const one of strength) average += one;
  average /= strength.length;
  const swing = Float32Array.from(strength, (one) => one - average);
  const scores = new Float64Array(highest + 2);
  let best = 0;
  let bestLag = 0;
  for (let lag = lowest; lag <= highest && lag < strength.length / 2; lag += 1) {
    let sum = 0;
    for (let at = 0; at + lag < swing.length; at += 1) sum += swing[at] * swing[at + lag];
    // Longer lags have fewer terms to add up; divide by how many there were, not by how many there could be. Then
    // lean towards the tempo a person would tap: a bed with the beat only implied agrees with itself just as well at
    // half and at double, and without this it picks whichever of the three the arithmetic happened to like.
    const bpm = 60 / (lag * perFrame);
    scores[lag] = (sum / (strength.length - lag)) * Math.exp(-(Math.log2(bpm / 112) ** 2) / 0.6);
    if (scores[lag] > best) { best = scores[lag]; bestLag = lag; }
  }
  if (!bestLag || best <= 0) return null;
  // A spacing measured in whole frames is measured to eleven milliseconds, and eleven milliseconds a beat is half a
  // second by the end of a thirty-second film — so the last beats of the film would be nowhere near the music. The
  // spacing and the first beat are therefore looked for together: lay a grid at each fine spacing and each start, and
  // keep the grid that lands on the most onset. A frame either side counts, because an onset is two frames wide.
  const landsOn = (spacing: number, phase: number) => {
    let sum = 0;
    for (let at = phase; at < strength.length; at += spacing) {
      const near = Math.round(at);
      sum += Math.max(strength[near - 1] ?? 0, strength[near] ?? 0, strength[near + 1] ?? 0);
    }
    return sum;
  };
  let lag = bestLag;
  let bestPhase = 0;
  let bestScore = -1;
  for (let spacing = bestLag - 1; spacing <= bestLag + 1; spacing += 0.02) {
    for (let phase = 0; phase < Math.ceil(spacing); phase += 1) {
      const sum = landsOn(spacing, phase);
      if (sum > bestScore) { bestScore = sum; bestPhase = phase; lag = spacing; }
    }
  }
  const period = lag * perFrame;
  const beats: number[] = [];
  for (let at = bestPhase * perFrame; at < seconds; at += period) beats.push(Math.round(at * 1000) / 1000);
  return { bpm: Math.round((60 / period) * 10) / 10, beats };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The bed made here: chords, a bass, a little percussion and a room, written a sample at a time.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function makeBed(mood: Mood, seconds: number, seed: number, askedBpm?: number): { bytes: Buffer; bpm: number; beats: number[] } {
  const shape = SHAPES[mood];
  const dice = diceOf(seed);
  const bpm = Math.max(50, Math.min(190, Math.round(askedBpm || shape.bpm * (0.96 + dice() * 0.08))));
  const length = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, seconds));
  const beat = 60 / bpm;
  const bar = beat * 4;
  const run = shape.runs[Math.floor(dice() * shape.runs.length) % shape.runs.length];
  const key = shape.keys[Math.floor(dice() * shape.keys.length) % shape.keys.length];
  // Two seconds past the end to catch the reverberation, which is then folded back onto the head so the loop joins.
  const tail = Math.round(2.5 * RATE);
  const frames = Math.round(length * RATE);
  const left = new Float32Array(frames + tail);
  const right = new Float32Array(frames + tail);

  const notes: Note[] = [];
  const base = 60 + (dice() < 0.4 ? 12 : 0); // middle C, or an octave up for a lighter film
  for (let index = 0; index * bar < length; index += 1) {
    const [root, quality] = run[index % run.length];
    const at = index * bar;
    // Every chord tone folded into one octave, with the ninth left on top: a voicing that never leaps about.
    const tones = [...new Set(CHORDS[quality].map((step) => (step >= 12 ? ((key + root + step) % 12) + 12 : (key + root + step) % 12)))].sort((a, b) => a - b);
    tones.forEach((tone, place) => {
      notes.push({
        at: at - (place === 0 ? 0 : dice() * 0.02),
        held: bar,
        hz: hzOf(base + tone),
        wave: shape.wave,
        gain: (0.5 - place * 0.05) * (place === tones.length - 1 ? 0.8 : 1),
        pan: tones.length > 1 ? (place / (tones.length - 1)) * 1.1 - 0.55 : 0,
        attack: shape.attack,
        release: shape.release,
        cut: shape.cut * (0.85 + 0.3 * dice()),
        detune: 5 + shape.glow * 6,
      });
    });
    // The bass, two octaves under the chord's own root.
    if (shape.bass !== 'none') {
      const low = hzOf(base - 24 + ((key + root) % 12));
      if (shape.bass === 'pulse') {
        for (let eighth = 0; eighth < 8; eighth += 1) {
          if (eighth % 2 === 1 && dice() < 0.4) continue;
          notes.push({ at: at + eighth * (beat / 2), held: beat * 0.3, hz: low, wave: 'sine', gain: 0.5, pan: 0, attack: 0.004, release: 0.12, cut: 900, detune: 0 });
        }
      } else {
        const held = shape.bass === 'sub' ? bar : beat * 1.6;
        for (let step = 0; step * held < bar - 0.01; step += 1) {
          notes.push({ at: at + step * held, held: held * 0.92, hz: low, wave: shape.bass === 'sub' ? 'sine' : 'tri', gain: shape.bass === 'sub' ? 0.62 : 0.5, pan: 0, attack: 0.02, release: 0.3, cut: 700, detune: 0 });
        }
      }
    }
    // A figure over the top, picked out of the same chord an octave up. Never on every eighth, or it is a melody.
    if (shape.arp > 0) {
      for (let eighth = 0; eighth < 8; eighth += 1) {
        if (dice() > shape.arp * 0.72) continue;
        const tone = tones[(index * 3 + eighth) % tones.length];
        notes.push({
          at: at + eighth * (beat / 2), held: beat * 0.22, hz: hzOf(base + 12 + tone), wave: 'tri',
          gain: 0.2 + 0.1 * dice(), pan: eighth % 2 === 0 ? -0.4 : 0.4, attack: 0.004, release: 0.34, cut: 3400, detune: 0,
        });
      }
    }
  }
  for (const note of notes) play(left, right, note);

  // The percussion, on the sixteenths of every bar.
  const drums: Record<Shape['beat'], { kind: 'kick' | 'hat' | 'shaker' | 'tom'; on: number[]; gain: number }[]> = {
    none: [],
    soft: [{ kind: 'kick', on: [0, 8], gain: 0.3 }, { kind: 'shaker', on: [4, 12], gain: 0.16 }],
    four: [{ kind: 'kick', on: [0, 4, 8, 12], gain: 0.34 }, { kind: 'hat', on: [2, 6, 10, 14], gain: 0.16 }, { kind: 'shaker', on: [3, 7, 11, 15], gain: 0.08 }],
    tick: [{ kind: 'kick', on: [0, 10], gain: 0.26 }, { kind: 'hat', on: [2, 4, 6, 8, 12, 14], gain: 0.12 }],
    pulse: [{ kind: 'kick', on: [0, 4, 8, 12], gain: 0.34 }, { kind: 'hat', on: [1, 3, 5, 7, 9, 11, 13, 15], gain: 0.09 }, { kind: 'tom', on: [14], gain: 0.16 }],
  };
  for (let index = 0; index * bar < length; index += 1) {
    for (const drum of drums[shape.beat]) {
      for (const sixteenth of drum.on) {
        if (drum.kind === 'tom' && index % 4 !== 3) continue;
        hit(left, right, drum.kind, index * bar + sixteenth * (beat / 4), drum.gain * (0.9 + 0.2 * dice()), dice);
      }
    }
  }

  room(left, right, shape.room, shape.glow);

  // The seam. Whatever is still ringing after the last bar is added back onto the first, so a bed played round twice
  // has no hole in it where the reverberation should have been. The fold is itself faded out over its whole length —
  // stopping it dead at two and a half seconds put a click there, which a spectrogram showed as a line from the floor
  // of the picture to the top of it.
  for (let at = 0; at < tail && at < frames; at += 1) {
    const ramp = 0.5 * (1 + Math.cos((Math.PI * at) / tail));
    left[at] += left[frames + at] * ramp;
    right[at] += right[frames + at] * ramp;
  }
  const bed = left.subarray(0, frames);
  const bedRight = right.subarray(0, frames);
  toLevel(bed, bedRight);
  // Twenty milliseconds at each end, which is a click removed rather than a fade: the film's own fades are
  // `musicBed`'s business, and a bed faded twice comes up late.
  const edge = Math.round(0.02 * RATE);
  for (let at = 0; at < edge && at < frames; at += 1) {
    const ramp = at / edge;
    bed[at] *= ramp; bedRight[at] *= ramp;
    bed[frames - 1 - at] *= ramp; bedRight[frames - 1 - at] *= ramp;
  }
  const beats: number[] = [];
  for (let at = 0; at < length; at += beat) beats.push(Math.round(at * 1000) / 1000);
  return { bytes: wavOf(Float32Array.from(bed), Float32Array.from(bedRight)), bpm, beats };
}

// The credit a made bed carries. Nobody owns a chord progression played by arithmetic, so this one is honest about
// costing nothing and being nobody's.
export const madeCredit = (mood: Mood, bpm: number): Credit => ({
  title: `${mood[0].toUpperCase()}${mood.slice(1)} bed, ${bpm} bpm`,
  by: 'the Video studio',
  licence: 'CC0 1.0 (written here from nothing; no rights reserved)',
  source: 'app/server/media/music.ts',
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Sounds a reel needs that the bundled Kenney set has not got. Those ten are interface-sized — a click, a bong, a
// switch — and a launch reel also wants air moving: a whoosh across a cut, a riser into a reveal, an impact under a
// wordmark. Rather than fetch three more files and argue about their terms, they are made here, like the bed.
export type SfxKind = 'whoosh' | 'riser' | 'impact';
export function sfx(kind: SfxKind): { ext: 'wav'; bytes: Buffer; credit: Credit } {
  const seconds = kind === 'riser' ? 1.8 : kind === 'whoosh' ? 0.6 : 1.1;
  const frames = Math.round(seconds * RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const dice = diceOf(hashOf(kind));
  let low = 0; let high = 0; let last = 0; let phase = 0;
  for (let at = 0; at < frames; at += 1) {
    const age = at / RATE;
    const along = at / frames;
    const noise = dice() * 2 - 1;
    // One low-pass and one high-pass make a band, and sweeping the band is the whole trick.
    const band = kind === 'whoosh' ? 300 + 5200 * Math.sin(Math.PI * along) : 500 + 7000 * along ** 2;
    const coefficient = 1 - Math.exp((-2 * Math.PI * band) / RATE);
    low += coefficient * (noise - low);
    high = 0.86 * (high + low - last);
    last = low;
    let value = high;
    let envelope = 1;
    if (kind === 'whoosh') envelope = Math.sin(Math.PI * along) ** 1.4;
    if (kind === 'riser') envelope = along ** 2.2;
    if (kind === 'impact') {
      // A body as well as a burst: a sine falling from a hundred hertz to thirty is what a big hit is made of.
      const hz = 32 + 90 * Math.exp(-age * 12);
      phase += (2 * Math.PI * hz) / RATE;
      value = high * 0.45 * Math.exp(-age * 16) + Math.sin(phase) * Math.exp(-age * 5.5);
      envelope = 1;
    }
    // A little wider than centre, and wider still as it goes, because air is not a point.
    const width = 0.25 + 0.35 * along;
    left[at] = value * envelope * (1 - width * 0.5);
    right[at] = value * envelope * (1 - width * 0.5) * (1 - width * 0.4) + value * envelope * width * 0.4;
  }
  toLevel(left, right, -20);
  const edge = Math.round(0.006 * RATE);
  for (let at = 0; at < edge; at += 1) {
    const ramp = at / edge;
    left[at] *= ramp; right[at] *= ramp;
    left[frames - 1 - at] *= ramp; right[frames - 1 - at] *= ramp;
  }
  return {
    ext: 'wav',
    bytes: wavOf(left, right),
    credit: { title: `${article(kind)[0].toUpperCase()}${article(kind).slice(1)} ${kind}, made here`, by: 'the Video studio', licence: 'CC0 1.0 (written here from nothing; no rights reserved)', source: 'app/server/media/music.ts' },
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The search. Openverse first, because it needs no key at all; Freesound only when the founder has put a free key in.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const OPENVERSE = 'https://api.openverse.org/v1/audio/';
const FREESOUND = 'https://freesound.org/apiv2/search/text/';
const AGENT = 'stage-video-studio/1.0 (+https://github.com/; a founder tool looking for CC0 music)';
const SEARCH_TIMEOUT = 15_000;
const FETCH_TIMEOUT = 90_000;
const MAX_BYTES = 40 * 1024 * 1024;
// How many of the best-fitting candidates the dice gets to choose between.
const PICK_FROM = 6;

// One candidate, already reduced to the handful of things that decide whether it can be used.
export type Found = { id: string; title: string; by: string; licence: string; credit: boolean; source: string; url: string; seconds: number; ext: string; where: string };

// Anything that is plainly not music, told from its words alone. A bed under a founder's launch film must not turn
// out to be somebody reading a poem, and the cheap test catches nearly all of it.
// The second half of it is the field recordings. They are the commonest thing in a public-domain audio library and
// they are all beautifully licensed, and a marketing film with birdsong under it is a film nobody finishes.
const NOT_MUSIC = /\b(speech|spoken|voice|vocal|interview|podcast|lecture|talk|talking|audiobook|reading|sermon|narration|narrator|sample ?pack|sound ?effect|sfx|foley|noise|whitenoise|test tone|sine ?wave|asmr|announcement|tutorial|anthem|recitation|midi|bird|birds|birdsong|rain|thunder|storm|wind|water|waves|stream|ocean|river|forest|nature|wildlife|insect|animal|room ?tone|ambience|footstep|door|engine|traffic|machine|crack|creak)\b/i;
// And a word that says it is. Asking a search for "upbeat" comes back with a musical saw as happily as with a tune,
// so a candidate has to claim to be music somewhere in its own title or tags before it is even considered.
const IS_MUSIC = /\b(music|musical|song|track|tune|loop|beat|instrumental|background|bgm|soundtrack|ambient|theme|melody|groove|jingle|piano|guitar|synth|orchestra|orchestral|drum|bass|chord)\b/i;

// Every gate a track has to pass, in one place, so a reviewer can read the rules rather than find them. Strict on
// purpose: there is always the made bed underneath, so throwing a doubtful track away costs nothing.
export function keep(found: Found, seconds: number): boolean {
  if (!found.url || !/^https:\/\//.test(found.url)) return false;
  const said = `${found.title} ${found.where}`;
  if (NOT_MUSIC.test(said)) return false;
  if (!IS_MUSIC.test(said)) return false;
  // Long enough to be a piece of music, and short enough that fetching it is not an afternoon. A film may be longer
  // than its bed — the bed simply goes round again — but a nine-second clip looped six times is a ringtone.
  if (found.seconds < Math.max(20, Math.min(seconds, 45))) return false;
  if (found.seconds > 20 * 60) return false;
  return true;
}

// How much a track sounds like the mood it was asked for, counted in the only evidence there is: its own words. Every
// word of every search term this mood would use, found in the title or the tags, is a point.
export function fits(found: Found, mood: Mood): number {
  const said = `${found.title} ${found.where}`.toLowerCase();
  let score = 0;
  // Words of five letters or more only. "loop" and "pop" are in half the terms and in half the library, so counting
  // them counts nothing: what separates a guitar loop from a drum loop is the word "guitar".
  for (const term of SHAPES[mood].terms) for (const word of term.split(' ')) if (word.length > 4 && said.includes(word)) score += 1;
  return score;
}

type Raw = Record<string, unknown>;
// A field that is a word, whatever the search decided to send it as: these APIs write an id as a string in one place
// and a number in the next.
const text = (value: unknown, fallback = '') => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
};

// Openverse's own fields, read defensively: a field that is missing is a field this cannot judge, and anything it
// cannot judge about a licence is thrown away rather than assumed.
export function openverseResults(body: unknown, seconds: number): Found[] {
  const results = (body as { results?: Raw[] })?.results;
  if (!Array.isArray(results)) return [];
  const found: Found[] = [];
  for (const one of results) {
    const licence = licenceOf(one.license, one.license_version);
    if (!licence) continue;
    const tags = Array.isArray(one.tags) ? (one.tags as Raw[]).map((tag) => text(tag?.name)).join(' ') : '';
    // Openverse counts a track's length in milliseconds.
    const milliseconds = Number(one.duration);
    const bitRate = Number(one.bit_rate);
    const sampleRate = Number(one.sample_rate);
    const ext = text(one.filetype, 'mp3').toLowerCase();
    // A lossy file under ninety-six kilobits is a file somebody has already thrown away half of.
    if (Number.isFinite(bitRate) && bitRate > 0 && bitRate < 96_000 && /mp3|ogg|opus|m4a/.test(ext)) continue;
    if (Number.isFinite(sampleRate) && sampleRate > 0 && sampleRate < 32_000) continue;
    const candidate: Found = {
      id: `openverse-${text(one.id, String(found.length))}`,
      title: text(one.title, 'Untitled'),
      by: text(one.creator, 'unknown'),
      licence: licence.name,
      credit: licence.credit,
      source: text(one.foreign_landing_url, text(one.url)),
      url: text(one.url),
      seconds: Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 1000 : 0,
      ext: /^(mp3|ogg|wav|flac|oga|opus|m4a)$/.test(ext) ? ext : 'mp3',
      where: `${tags} ${text(one.category)}`,
    };
    if (keep(candidate, seconds)) found.push(candidate);
  }
  return found;
}

// Freesound is the optional tier: it wants a free key, which is a thing the founder has to go and get, so nothing
// depends on it. Its filter already asks for CC0 only, and the licence field is checked again anyway.
export function freesoundResults(body: unknown, seconds: number): Found[] {
  const results = (body as { results?: Raw[] })?.results;
  if (!Array.isArray(results)) return [];
  const found: Found[] = [];
  for (const one of results) {
    const said = text(one.license).toLowerCase();
    // Freesound writes its licences as URLs: `.../publicdomain/zero/1.0/`.
    const code = /publicdomain\/zero/.test(said) ? 'cc0' : /licenses\/by\/[\d.]+\/?$/.test(said) ? 'by' : said;
    const licence = licenceOf(code);
    if (!licence) continue;
    const candidate: Found = {
      id: `freesound-${text(one.id, String(found.length))}`,
      title: text(one.name, 'Untitled'),
      by: text(one.username, 'unknown'),
      licence: licence.name,
      credit: licence.credit,
      source: `https://freesound.org/s/${text(one.id)}/`,
      url: text((one.previews as Raw | undefined)?.['preview-hq-mp3']),
      seconds: Number(one.duration) || 0,
      ext: 'mp3',
      where: `${Array.isArray(one.tags) ? (one.tags as string[]).join(' ') : ''} music`,
    };
    if (keep(candidate, seconds)) found.push(candidate);
  }
  return found;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The cache: a folder of tracks and one JSON file saying, for each of them, exactly what it is and on what terms.
// That file is the record of credit. It is written before the film is, and it outlives the film.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Kept = Found & { file: string; mood: Mood; fetched: string };
type Index = { tracks: Kept[] };

const safeName = (id: string) => id.replace(/[^a-z0-9-]+/gi, '-').slice(0, 80);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function createMusic(deps: { cacheDir: string; env?: NodeJS.ProcessEnv; http?: typeof fetch }): Music {
  const env = deps.env ?? process.env;
  const http = deps.http ?? fetch;
  const dir = join(deps.cacheDir, 'music');
  const indexAt = join(dir, 'index.json');
  const creditsAt = join(dir, 'CREDITS.md');
  let picks = 0;

  const readIndex = async (): Promise<Index> => {
    try {
      const read = JSON.parse(await readFile(indexAt, 'utf8')) as Index;
      return { tracks: Array.isArray(read.tracks) ? read.tracks : [] };
    } catch { return { tracks: [] }; }
  };
  // Written through a temporary name, as the boards and the sidecars are, so a crash never leaves half an index.
  const writeIndex = async (index: Index) => {
    await mkdir(dir, { recursive: true });
    await writeFile(`${indexAt}.tmp`, JSON.stringify(index, null, 2));
    await rename(`${indexAt}.tmp`, indexAt);
    const lines = index.tracks.map((one) => `| ${one.title} | ${one.by} | ${one.licence} | ${one.source} | ${one.fetched.slice(0, 10)} |`);
    await writeFile(creditsAt, [
      '# Music this app has fetched, and on what terms',
      '',
      'Every track below was fetched from its own host onto this machine because its stated licence allows a founder',
      'to sell the film it is under. Nothing here is redistributed by this repository. A row whose licence says the',
      'author must be credited has to be named in the film or its description; the Video studio says so on the card',
      'when it uses one.',
      '',
      '| track | by | licence | where it came from | fetched |',
      '| --- | --- | --- | --- | --- |',
      ...lines,
      '',
    ].join('\n'));
  };

  async function search(mood: Mood, seconds: number, signal?: AbortSignal): Promise<Found[]> {
    if (env.STAGE_NO_MUSIC_SEARCH === '1') return [];
    const terms = SHAPES[mood].terms;
    const found: Found[] = [];
    const seen = new Set<string>();
    const add = (list: Found[]) => { for (const one of list) if (!seen.has(one.id)) { seen.add(one.id); found.push(one); } };
    const timeout = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT)]) : AbortSignal.timeout(SEARCH_TIMEOUT));
    for (const term of terms.slice(0, 3)) {
      // Asked for exactly what may be used, and asked the way the API really behaves rather than the way it reads.
      // Three things were measured against the live service before this line was written:
      //  · `category=music` and `license=cc0` together return **nothing**. Everything Openverse files under `music`
      //    is Jamendo, and Jamendo is by / by-sa / by-nc-nd — none of which a founder may sell a film under. The
      //    public-domain music is filed with no category at all, so the category is left off and the sorting out
      //    is done here, in `keep`.
      //  · The CC0 audio all comes from Freesound or Wikimedia, and Wikimedia's is anthems, recitations and MIDI.
      //    So Freesound is named: it is where the beds actually are.
      //  · `length` takes `shortest|short|medium|long`, and `long` reaches fifty-five minutes. A bed is a short or a
      //    medium. Anonymously, twenty results a page is the ceiling, twenty searches a minute and two hundred a day.
      const url = `${OPENVERSE}?${new URLSearchParams({
        q: term, license: 'cc0,pdm', source: 'freesound', length: 'short,medium',
        page_size: '20', mature: 'false', filter_dead: 'true',
      })}`;
      try {
        const answer = await http(url, { headers: { accept: 'application/json', 'user-agent': AGENT }, signal: timeout() });
        if (!answer.ok) continue;
        add(openverseResults(await answer.json(), seconds));
      } catch { /* the made bed is underneath; a search that fails is not an error */ }
      if (found.length >= 12) break;
    }
    const key = env.FREESOUND_API_KEY?.trim();
    if (key && found.length < 4) {
      const url = `${FREESOUND}?${new URLSearchParams({
        query: terms[0], filter: 'license:"Creative Commons 0" duration:[30 TO 600]',
        fields: 'id,name,username,license,duration,tags,previews', page_size: '20',
      })}`;
      try {
        const answer = await http(url, { headers: { accept: 'application/json', authorization: `Token ${key}` }, signal: timeout() });
        if (answer.ok) add(freesoundResults(await answer.json(), seconds));
      } catch { /* optional by design */ }
    }
    // A search matches on any word of the term, so asking for a warm acoustic loop comes back with drum loops as
    // happily as with guitars. Anything that claims none of the mood's own words is dropped outright when enough
    // that do are left — and what remains is sorted by needing no credit first (a film with nothing to say at the
    // end is a better film), then by how much of the mood it claims.
    const strong = found.filter((one) => fits(one, mood) > 0);
    const list = strong.length >= 3 ? strong : found;
    return list.sort((a, b) => Number(a.credit) - Number(b.credit) || fits(b, mood) - fits(a, mood));
  }

  async function download(found: Found, signal?: AbortSignal): Promise<Buffer> {
    const answer = await http(found.url, {
      headers: { 'user-agent': AGENT },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT)]) : AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!answer.ok) throw new Error(`the track answered ${answer.status}`);
    const bytes = Buffer.from(await answer.arrayBuffer());
    if (!bytes.length) throw new Error('the track came back empty');
    // Forty megabytes is a generous ten minutes of music; anything larger is a mistake, not a bed.
    if (bytes.length > MAX_BYTES) throw new Error('the track is far larger than a bed should be');
    return bytes;
  }

  // A fetched track cut to the film: looped if it is short, cut where the film ends, brought to the same level the
  // made bed is brought to, and handed over as a WAV so the beat finder and ffmpeg both read it without argument.
  async function fit(from: string, seconds: number, signal?: AbortSignal): Promise<Buffer> {
    const to = join(dir, `fit-${Date.now().toString(36)}.wav`);
    await ff(FFMPEG, [
      '-y', '-loglevel', 'error', '-stream_loop', '-1', '-i', from, '-t', seconds.toFixed(2),
      '-af', `afade=t=in:st=0:d=0.02,afade=t=out:st=${Math.max(0, seconds - 0.02).toFixed(2)}:d=0.02,loudnorm=I=${TARGET_LUFS}:TP=-2:LRA=11`,
      '-ac', '2', '-ar', String(RATE), '-c:a', 'pcm_s16le', to,
    ], signal, 180);
    const bytes = await readFile(to);
    await rm(to, { force: true }).catch(() => {});
    // ffmpeg's own `loudnorm` in one pass is an estimate — on a quiet pad it landed four decibels under, which under
    // a narrator is the difference between a bed and nothing at all. So it is measured again here, exactly, and
    // corrected with a single gain. The made bed goes through the same meter, so both arrive at the same level.
    const { left, right, rate } = pcmOf(bytes);
    if (!left.length) throw new Error('the track came back as something ffmpeg could not make a bed of');
    toLevel(left, right, TARGET_LUFS, rate);
    return wavOf(left, right, rate);
  }

  return {
    async bed(ask, help) {
      const mood: Mood = isMood(ask.mood) ? ask.mood : 'calm';
      const seconds = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Number(ask.seconds) || 20));
      // Films made one after the other must not all be scored with the same track. The founder can pin the dice with
      // STAGE_MUSIC_SEED when they want the same bed twice — a re-render of the same film, usually.
      picks += 1;
      const seed = hashOf(`${env.STAGE_MUSIC_SEED ?? `${Date.now()}-${picks}`}:${mood}:${Math.round(seconds)}`);
      const dice = diceOf(seed);
      const index = await readIndex();
      const already = index.tracks.filter((one) => one.mood === mood);

      if (env.STAGE_NO_MUSIC_SEARCH !== '1') {
        try {
          help.report(`looking for ${mood} music nobody minds you selling…`);
          const found = await search(mood, seconds, help.signal);
          // Anything already on this machine is free and instant; anything found is a fetch. Both go in the hat, with
          // what is here weighted a little, so the second film on a plane still has a bed and the tenth is not the
          // same as the first.
          const hat: (Found | Kept)[] = [...already, ...found.filter((one) => !index.tracks.some((kept) => kept.id === one.id))]
            .sort((a, b) => Number(a.credit) - Number(b.credit) || fits(b, mood) - fits(a, mood));
          if (hat.length) {
            // Out of the best handful rather than the best one: a bed that fits and a bed that is the same every time
            // are different things, and the founder wants the first without the second.
            const short = hat.slice(0, PICK_FROM);
            const pick = short[Math.floor(dice() * short.length) % short.length];
            const kept = 'file' in pick ? pick : null;
            let file = kept?.file ?? '';
            if (!kept) {
              help.report(`fetching "${pick.title}" by ${pick.by} — ${pick.licence}`);
              const bytes = await download(pick, help.signal);
              await mkdir(dir, { recursive: true });
              file = join(dir, `${safeName(pick.id)}.${pick.ext}`);
              await writeFile(file, bytes);
              await writeIndex({ tracks: [...index.tracks, { ...pick, file, mood, fetched: new Date().toISOString() }].slice(-120) });
            }
            const bytes = await fit(file, seconds, help.signal);
            const timing = beatsOf(monoOf(bytes).samples, RATE, seconds);
            const credit: Credit = { title: pick.title, by: pick.by, licence: pick.licence, source: pick.source };
            help.report(pick.credit
              ? `music: "${credit.title}" by ${credit.by} — ${credit.licence}. Name them in the film or its description.`
              : `music: "${credit.title}" by ${credit.by} — ${credit.licence}.`);
            return { ext: 'wav', bytes, credit, bpm: timing?.bpm, beats: timing?.beats };
          }
          help.report('nothing found that a founder could sell a film under; writing a bed here instead');
        } catch (error) {
          // Never a failure: the bed below needs no network, no key and no ffmpeg.
          help.report(`could not use a found track (${(error as Error).message}); writing a bed here instead`);
        }
      }

      const made = makeBed(mood, seconds, seed, ask.bpm);
      const credit = madeCredit(mood, made.bpm);
      help.report(`music: ${article(mood)} ${mood} bed written here at ${made.bpm} beats a minute — ${credit.licence}`);
      return { ext: 'wav', bytes: made.bytes, credit, bpm: made.bpm, beats: made.beats };
    },
  };
}

// Never the network, never ffmpeg, never a second of waiting: the bed the tests and the fake-model runs get. It is
// the real synthesiser at four seconds, so what a test hears is what a film gets, only shorter.
export const fakeMusic: Music = {
  async bed(ask, help) {
    const mood: Mood = isMood(ask.mood) ? ask.mood : 'calm';
    const seconds = Math.max(MIN_SECONDS, Math.min(60, Number(ask.seconds) || 8));
    help.report(`music: ${article(mood)} ${mood} bed written here`);
    const made = makeBed(mood, seconds, hashOf(`fake:${mood}:${seconds}`), ask.bpm);
    return { ext: 'wav', bytes: made.bytes, credit: madeCredit(mood, made.bpm), bpm: made.bpm, beats: made.beats };
  },
};
