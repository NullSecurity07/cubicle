import type { Credit, Mood } from './music.ts';
import { RATE, toLevel, wavOf } from './sound.ts';

// The bed made here, out of arithmetic: what each mood is musically, an instrument that writes numbers into two
// arrays of samples, the bed itself, and the few sounds a reel needs that the bundled set has not got. No model, no
// network, no file, so it is always there when the search finds nothing.

// The shortest and the longest bed the studio makes or keeps.
export const MIN_SECONDS = 4;
export const MAX_SECONDS = 300;

// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A small deterministic dice, so two films in a row are not scored with the same track or the same key.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function hashOf(text: string): number {
  let hash = 2_166_136_261;
  for (let at = 0; at < text.length; at += 1) hash = Math.imul(hash ^ text.charCodeAt(at), 16_777_619);
  return hash >>> 0;
}
export const diceOf = (seed: number) => {
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

// "a upbeat bed" is a line nobody wrote on purpose.
export const article = (word: string) => ('aeiou'.includes(word[0]) ? 'an' : 'a');

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
