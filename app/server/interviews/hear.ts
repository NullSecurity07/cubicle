import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TranscriptLine } from '../../shared/interviews.ts';
import { runLines } from '../media/proc.ts';

// Writing an interview down, on this machine and nowhere else. Two engines are here already and neither sends a
// sound anywhere: whisper.cpp, which the Video studio builds for its word timings (`hyperframes transcribe`), and the
// Whisper that the microphone in a conversation uses (transformers.js). whisper.cpp goes first: it reads a whole
// file in one go and says when every word falls. Measured on this box, a minute of talk took 6.5 s with its base.en
// model and 9 s with transformers.js. The second is the net for a machine that cannot build the first (no cmake).

export type Heard = { lines: TranscriptLine[]; engine: string };
// The sound as a 16 kHz mono wav on disk in, the lines out.
export type Ear = { name: string; hear(wav: string, seconds: number, signal?: AbortSignal): Promise<Heard> };
export type Word = { text: string; start: number; end: number };

// A line ends at a pause long enough to be a breath between thoughts, at the end of a sentence once it has some
// length, or when it is simply too long to read at a glance.
const PAUSE = 0.9;
const SENTENCE = 8;
const LONGEST = 40;
export function linesOf(words: Word[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let open: { at: number; words: string[] } | null = null;
  let last: Word | null = null;
  const close = () => { if (open?.words.length) lines.push({ at: round(open.at), text: tidy(open.words.join(' ')) }); open = null; };
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    if (open && last && (word.start - last.end > PAUSE || open.words.length >= LONGEST)) close();
    open ??= { at: word.start, words: [] };
    open.words.push(text);
    last = word;
    if (/[.?!]["')\]]?$/.test(text) && open.words.length >= SENTENCE) close();
  }
  close();
  return lines;
}
const round = (seconds: number) => Math.round(seconds * 10) / 10;
// whisper.cpp hands punctuation back on its own now and then (" ," " ."): it belongs to the word before it.
const tidy = (text: string) => text.replace(/\s+([,.?!;:%])/g, '$1').replace(/\s+/g, ' ').trim();

// A plain PCM wav's length from its header, without reading the rest. The fake engine and a check use this; the real
// engines are told the length the conversion measured.
export function wavSeconds(head: Buffer): number | null {
  if (head.length < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
  let at = 12;
  let rate = 0;
  let block = 0;
  while (at + 8 <= head.length) {
    const id = head.toString('ascii', at, at + 4);
    const size = head.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= head.length) { block = head.readUInt16LE(at + 20); rate = head.readUInt32LE(at + 12); }
    if (id === 'data') return rate && block ? size / (rate * block) : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

// Anything with sound in it, as the one shape both engines read: a 16 kHz mono 16-bit wav.
export async function toWav(input: string, output: string, signal?: AbortSignal): Promise<number> {
  const ran = await runLines('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output],
    { cwd: resolve(output, '..'), collect: 600, signal }).catch((error: NodeJS.ErrnoException) => {
    throw new Error(error.code === 'ENOENT' ? 'this machine has no ffmpeg, which reading a recording needs' : error.message);
  });
  if (ran.code !== 0) throw new Error(`that file has no sound ffmpeg can read (${ran.out.trim().split('\n').at(-1) ?? ran.code})`);
  const seconds = wavSeconds(await readFile(output).then((all) => all.subarray(0, 4096)));
  if (seconds === null) throw new Error('the recording could not be measured');
  return seconds;
}

// whisper.cpp through hyperframes. It writes `transcript.json` (one row a word) beside the file it was handed.
export function whisperCpp(bin: string, model = process.env.STAGE_INTERVIEW_MODEL || 'base.en'): Ear {
  return {
    name: `whisper.cpp ${model}`,
    async hear(wav, seconds, signal) {
      const at = resolve(wav, '..');
      const out = join(at, 'transcript.json');
      await rm(out, { force: true });
      // Its own guess at a time limit is for narration a minute long; an hour-long call on a slow machine needs more.
      const limit = Math.round(120_000 + seconds * 1000 * 1.5);
      const ran = await runLines(bin, ['transcribe', wav, '--engine', 'whisper', '--model', model, '--json', '--timeout', String(limit)],
        { cwd: at, env: { ...process.env, NO_COLOR: '1' }, collect: 2000, signal });
      if (ran.code !== 0 || !existsSync(out)) throw new Error(`whisper.cpp stopped: ${ran.out.trim().split('\n').at(-1)?.slice(0, 200) ?? ran.code}`);
      const rows = JSON.parse(await readFile(out, 'utf8')) as { text?: unknown; start?: unknown; end?: unknown }[];
      await rm(out, { force: true });
      const words = (Array.isArray(rows) ? rows : [])
        .filter((row) => typeof row.text === 'string' && typeof row.start === 'number' && typeof row.end === 'number')
        .map((row) => ({ text: row.text as string, start: row.start as number, end: row.end as number }));
      return { lines: linesOf(words), engine: this.name };
    },
  };
}

// The Whisper the microphone uses, asked for times as well as words. Thirty-second windows, so it is slower on a
// long call; it is here for the machine where whisper.cpp will not build.
export function transformersWhisper(cacheDir: string): Ear {
  type Pipe = (samples: Float32Array, options: Record<string, unknown>) => Promise<{ text?: string; chunks?: { timestamp: [number, number | null]; text: string }[] }>;
  let ready: Promise<Pipe> | null = null;
  const load = () => (ready ??= (async () => {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = cacheDir;
    env.allowLocalModels = false;
    return (await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', { dtype: 'q8', device: 'cpu' } as Parameters<typeof pipeline>[2])) as unknown as Pipe;
  })().catch((error: Error) => { ready = null; throw error; }));
  return {
    name: 'Whisper base.en (transformers.js)',
    async hear(wav, _seconds, signal) {
      const pipe = await load();
      if (signal?.aborted) throw new Error('stopped');
      const all = await readFile(wav);
      const pcm = all.subarray(44);
      const samples = new Float32Array(Math.floor(pcm.length / 2));
      for (let index = 0; index < samples.length; index += 1) samples[index] = pcm.readInt16LE(index * 2) / 32768;
      const heard = await pipe(samples, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
      // It hands back phrases rather than words, each already a line with its own start.
      const lines = (heard.chunks ?? []).map((chunk) => ({ at: round(chunk.timestamp[0]), text: tidy(chunk.text) })).filter((line) => line.text);
      return { lines, engine: this.name };
    },
  };
}

// The first engine that works. A failure of the first is written down and the second is tried.
export function firstOf(ears: Ear[]): Ear {
  return {
    name: ears.map((one) => one.name).join(', then '),
    async hear(wav, seconds, signal) {
      const failed: string[] = [];
      for (const ear of ears) {
        try { return await ear.hear(wav, seconds, signal); } catch (error) {
          if (signal?.aborted) throw error;
          failed.push(`${ear.name}: ${(error as Error).message}`);
        }
      }
      throw new Error(failed.join('; ') || 'no transcriber on this machine');
    },
  };
}

// The checks never start a model: whatever they drop, this is what was said. Fixed, so a journey can assert it.
export const FAKE_TRANSCRIPT: TranscriptLine[] = [
  { at: 0, text: 'Thanks for making the time. Tell me about the last time you closed the books.' },
  { at: 4.2, text: 'Last month it took us four days, mostly chasing receipts in email.' },
  { at: 9.8, text: 'Today we use a shared spreadsheet and a lot of reminders on Slack.' },
  { at: 15.1, text: 'If something cut that to one day I would pay for it out of my own budget.' },
];
export const fakeEar: Ear = {
  name: 'fake',
  async hear() { return { lines: FAKE_TRANSCRIPT.map((line) => ({ ...line })), engine: 'fake' }; },
};

// Where the local engines live: the hyperframes binary this repository installs, and the microphone's model cache.
export const localEars = (root: string) => firstOf([
  whisperCpp(resolve(import.meta.dirname, '../../node_modules/.bin/hyperframes')),
  transformersWhisper(resolve(root, 'app/.cache/speech')),
]);

// The checks never start ffmpeg either: a wav is measured from its header, anything else counts as a minute.
export async function fakeConvert(input: string): Promise<number> {
  return wavSeconds(await readFile(input).then((all) => all.subarray(0, 4096)).catch(() => Buffer.alloc(0))) ?? 60;
}
