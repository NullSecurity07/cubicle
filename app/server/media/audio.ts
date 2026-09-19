import { join } from 'node:path';
import { ff, FFMPEG } from './ff.ts';

// The ten sounds the films are cut with. They are Kenney's, public domain, and they live in the folder beside this
// file; see templates/assets/CREDITS.md for where each came from and why no music is bundled with them.
export const SFX = {
  'cut-soft': { file: 'cut-soft.wav', gain: 0.34 },
  'cut-hard': { file: 'cut-hard.wav', gain: 0.30 },
  'cut-wood': { file: 'cut-wood.wav', gain: 0.30 },
  accent: { file: 'accent-bong.wav', gain: 0.30 },
  tick: { file: 'tick.wav', gain: 0.24 },
  turn: { file: 'switch.wav', gain: 0.24 },
  sting: { file: 'drop.wav', gain: 0.38 },
  mark: { file: 'select.wav', gain: 0.26 },
  soft: { file: 'rollover.wav', gain: 0.22 },
  hard: { file: 'glitch.wav', gain: 0.26 },
} as const;
export type Sfx = keyof typeof SFX;
export const SFX_DIR = join(import.meta.dirname, 'templates/assets/sfx');
export const sfxFile = (sound: Sfx): string => SFX[sound].file;
// One sound placed on the film's clock: which one, when it lands, and how loud against the narration.
export type Cue = { sound: Sfx; at: number; gain?: number };

// The moods a storyboard can ask its bed for. Nothing is bundled to play them (the licence of the one free set we
// could find is unverified), so a mood is what the founder's own dropped track is chosen and mixed *for*: how loud it
// sits under the words, and how long it takes to arrive and to leave.
export const MOODS = ['none', 'calm', 'warm', 'drive', 'bright'] as const;
export type Mood = (typeof MOODS)[number];
export const BED: Record<Exclude<Mood, 'none'>, { gain: number; quiet: number; in: number; out: number }> = {
  calm: { gain: 0.24, quiet: 0.30, in: 2.2, out: 2.6 },
  warm: { gain: 0.30, quiet: 0.32, in: 1.6, out: 2.2 },
  drive: { gain: 0.38, quiet: 0.34, in: 0.9, out: 1.6 },
  bright: { gain: 0.34, quiet: 0.30, in: 1.2, out: 1.8 },
};

// When somebody is speaking, and for a breath either side of it.
export type Window = { at: number; seconds: number };

// The bed's own volume, written as one expression on the film's clock: full between the lines, down to `quiet` under
// them, and a ramp of `ramp` seconds into and out of every duck so the drop is never heard as a drop. ffmpeg reads
// this a frame at a time, which is why it has to be an expression and not a chain of fades.
export function duckExpr(windows: Window[], quiet: number, ramp = 0.38): string {
  const clean = windows.filter((one) => one.seconds > 0).sort((a, b) => a.at - b.at);
  if (!clean.length) return '1';
  // Lines that all but touch are one duck: the bed coming up for a third of a second between two sentences is a bump.
  const merged: Window[] = [];
  for (const one of clean) {
    const last = merged.at(-1);
    if (last && one.at <= last.at + last.seconds + ramp * 2) last.seconds = Math.max(last.at + last.seconds, one.at + one.seconds) - last.at;
    else merged.push({ ...one });
  }
  const at = (value: number) => value.toFixed(3);
  // Per window: nothing, ramping to one over `ramp` before it starts, one throughout, ramping back after it ends.
  const one = (window: Window) => `min(1,max(0,min((t-(${at(window.at - ramp)}))/${at(ramp)},((${at(window.at + window.seconds + ramp)})-t)/${at(ramp)})))`;
  const duck = merged.map(one).reduce((all, next) => `max(${all},${next})`);
  return `${at(quiet)}+${at(1 - quiet)}*(1-(${duck}))`;
}

// The founder's own track, cut to the film's length, faded in and out, and ducked under every line said over it. One
// file, handed to the renderer as a single sound; nothing about it is decided in the page.
export async function musicBed(ask: {
  from: string; to: string; seconds: number; mood: Exclude<Mood, 'none'>; windows: Window[]; signal?: AbortSignal;
}): Promise<void> {
  const shape = BED[ask.mood];
  const out = Math.max(0, ask.seconds - shape.out);
  const filter = [
    `volume='${duckExpr(ask.windows, shape.quiet)}':eval=frame`,
    `afade=t=in:st=0:d=${shape.in.toFixed(2)}`,
    `afade=t=out:st=${out.toFixed(2)}:d=${shape.out.toFixed(2)}`,
    `volume=${shape.gain.toFixed(2)}`,
  ].join(',');
  // A track shorter than the film simply goes round again; a longer one is cut where the film ends.
  await ff(FFMPEG, ['-y', '-loglevel', 'error', '-stream_loop', '-1', '-i', ask.from, '-t', ask.seconds.toFixed(2),
    '-af', filter, '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', ask.to], ask.signal, 240);
}
