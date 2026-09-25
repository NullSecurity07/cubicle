import { runLines } from './proc.ts';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Part, Word } from './templates/captions.ts';
import { wordTimes } from './templates/captions.ts';

// When each word is actually said.
//
// Until now this was guessed. The voice model hands back one piece of sound a sentence, so a sentence's length was
// known and the words inside it were spread across it by how long each one takes to say. That is a good guess and
// it is still the net under everything here — but it is a guess, and every cut, every punch-in, every graphic and
// every caption in this studio now lands on a word. A cut a tenth of a second off the word it was meant for is the
// difference between an edit and a slideshow, and the founder saw the slideshow.
//
// What measures it is `hyperframes transcribe`, which is whisper.cpp with word-level timestamps and is already in
// this repository's dependencies — no new package, no key, nothing leaves the machine. It builds itself the first
// time it runs and needs cmake; where there is no cmake and no way to get one, the guess stands and the card says
// so rather than failing the film.
//
// The one thing that has to be got right: **the transcript is not the script.** Whisper hears "build" where the
// narration said "built", drops a word, runs two together. We already know exactly what was said — we wrote it and
// we recorded it — so the transcript is only ever used for its *times*, aligned onto the script we know. That is
// forced alignment done cheaply, and it is strictly better than transcription because there is no recognition
// error left to repair.

export type { Part, Word } from './templates/captions.ts';
// A run of words with no breath in the middle of it. Cuts land here and nowhere else.
export type Phrase = { at: number; seconds: number; from: number; to: number };

// How long a gap between two words has to be before it is a breath rather than a join. Under this the speaker is
// still in the middle of a thought, and a cut there lands mid-sentence.
export const BREATH = 0.18;

const bare = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// --- aligning what was heard onto what was said ------------------------------------------------------------------

// Needleman–Wunsch over the two word sequences, which is the same shape as the trellis a real forced aligner walks,
// done on words rather than on frames. It is exact, it is a dozen lines, and it costs nothing at these lengths.
// Every script word comes out with a time: the one its heard match carried, or — for a word nothing heard — a share
// of the gap between the words either side of it, which is where it must have been.
export function alignToScript(heard: Word[], script: string[]): Word[] {
  if (!script.length) return [];
  if (!heard.length) return [];
  const mine = script.map(bare);
  const theirs = heard.map((one) => bare(one.word));
  const rows = mine.length + 1;
  const cols = theirs.length + 1;
  const GAP = -1;
  const score = new Float32Array(rows * cols);
  // 0 nothing, 1 diagonal, 2 up (a script word nothing heard), 3 left (something heard that was never said).
  const came = new Uint8Array(rows * cols);
  for (let row = 1; row < rows; row += 1) { score[row * cols] = row * GAP; came[row * cols] = 2; }
  for (let col = 1; col < cols; col += 1) { score[col] = col * GAP; came[col] = 3; }
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      // A near miss — "built" against "build" — is still the same word in the same place, and scores as one.
      const same = mine[row - 1] === theirs[col - 1] ? 2 : near(mine[row - 1], theirs[col - 1]) ? 1 : -1;
      const diagonal = score[(row - 1) * cols + (col - 1)] + same;
      const up = score[(row - 1) * cols + col] + GAP;
      const left = score[row * cols + (col - 1)] + GAP;
      const best = Math.max(diagonal, up, left);
      score[row * cols + col] = best;
      came[row * cols + col] = best === diagonal ? 1 : best === up ? 2 : 3;
    }
  }
  // Walk it back, so every script word knows which heard word it landed on, or that it landed on none.
  const onto: (Word | null)[] = new Array(mine.length).fill(null);
  let row = mine.length;
  let col = theirs.length;
  while (row > 0 || col > 0) {
    const step = came[row * cols + col];
    if (step === 1) { onto[row - 1] = heard[col - 1]; row -= 1; col -= 1; }
    else if (step === 2) { row -= 1; }
    else if (step === 3) { col -= 1; }
    else break;
  }
  return fillGaps(script, onto, heard);
}

// Two words are the same word when one is a prefix of the other and they are long enough for that to mean
// something: "built" and "build", "investors" and "investor". Nothing shorter, or every "a" matches every "at".
function near(mine: string, theirs: string): boolean {
  if (!mine || !theirs) return false;
  const [long, short] = mine.length >= theirs.length ? [mine, theirs] : [theirs, mine];
  return short.length >= 4 && long.startsWith(short.slice(0, Math.max(4, short.length - 1)));
}

// A word nothing heard still has to be somewhere. It goes in the room between the last word that was heard and the
// next one, shared with whatever other unheard words are in there, by how long each takes to say.
function fillGaps(script: string[], onto: (Word | null)[], heard: Word[]): Word[] {
  const out: Word[] = new Array(script.length);
  const weight = (word: string) => bare(word).length + 1.9;
  let at = 0;
  while (at < script.length) {
    if (onto[at]) {
      out[at] = { word: script[at], at: onto[at]!.at, seconds: onto[at]!.seconds };
      at += 1;
      continue;
    }
    let past = at;
    while (past < script.length && !onto[past]) past += 1;
    const before = at > 0 ? out[at - 1] : null;
    const from = before ? before.at + before.seconds : (heard[0]?.at ?? 0);
    const until = past < script.length ? onto[past]!.at : (heard.at(-1) ? heard.at(-1)!.at + heard.at(-1)!.seconds : from);
    const room = Math.max(0.06 * (past - at), until - from);
    const weights = script.slice(at, past).map(weight);
    const whole = weights.reduce((sum, one) => sum + one, 0) || 1;
    let cursor = from;
    for (let index = at; index < past; index += 1) {
      const seconds = Math.round((room * weights[index - at]) / whole * 1000) / 1000;
      out[index] = { word: script[index], at: Math.round(cursor * 1000) / 1000, seconds };
      cursor += seconds;
    }
    at = past;
  }
  return out;
}

// --- phrases -------------------------------------------------------------------------------------------------

// Where the speaker stops. A cut belongs on one of these and nowhere else: the research is blunt about it — when
// narration leads, you cut on the phrase, never on a grid and never on the beat.
export function phrasesIn(words: Word[], breath = BREATH): Phrase[] {
  const found: Phrase[] = [];
  let from = 0;
  const close = (to: number) => {
    if (to <= from) return;
    found.push({ from, to, at: words[from].at, seconds: Math.round((words[to - 1].at + words[to - 1].seconds - words[from].at) * 1000) / 1000 });
    from = to;
  };
  for (let at = 0; at < words.length; at += 1) {
    const next = words[at + 1];
    const ended = /[.!?]$/.test(words[at].word) || /[,;:—]$/.test(words[at].word);
    if (!next || ended || next.at - (words[at].at + words[at].seconds) >= breath) close(at + 1);
  }
  close(words.length);
  return found;
}

// The nearest moment the speaker was between two thoughts, or **nothing** when none is near enough. It says
// nothing rather than handing back the moment it was asked about: a caller that cannot tell the two apart quietly
// treats "I found no boundary" as "the boundary is exactly here", which is how a cut lands mid-word.
export function nearestPhrase(phrases: Phrase[], at: number, reach = 0.45): number | null {
  let best: number | null = null;
  let gap = reach;
  for (const phrase of phrases) {
    for (const edge of [phrase.at, phrase.at + phrase.seconds]) {
      const far = Math.abs(edge - at);
      if (far < gap) { gap = far; best = edge; }
    }
  }
  return best === null ? null : Math.round(best * 1000) / 1000;
}

// --- hearing the recording ---------------------------------------------------------------------------------------

export type Heard = { words: Word[]; how: 'heard' | 'guessed' };

// The words of one recording, measured. `bin` is the hyperframes binary the studio already renders with.
// A failure of any kind is not a failure of the film: it comes back as nothing and the caller falls back to the
// guess, with one line on the card so the founder knows which of the two they got.
export async function hearWords(bin: string, wav: string, opts: { model?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Word[] | null> {
  const at = dirname(wav);
  const transcript = join(at, 'transcript.json');
  await rm(transcript, { force: true }).catch(() => {});
  const ran = await run(bin, ['transcribe', basename(wav), '--model', opts.model ?? 'tiny.en', '--json', '--optional',
    '--timeout', String(opts.timeoutMs ?? 240_000)], at, opts.signal).catch(() => null);
  if (!ran || ran.code !== 0) return null;
  try {
    const rows = JSON.parse(await readFile(transcript, 'utf8')) as { text?: string; start?: number; end?: number }[];
    if (!Array.isArray(rows) || !rows.length) return null;
    const words = rows
      .filter((row) => typeof row?.text === 'string' && typeof row.start === 'number' && typeof row.end === 'number')
      .map((row): Word => ({ word: row.text!.trim(), at: row.start!, seconds: Math.max(0.02, row.end! - row.start!) }))
      .filter((one) => one.word);
    return words.length ? words : null;
  } catch { return null; }
}

// The whole of it, in the order the studio wants it: measure the recording, align the measurement onto the script
// that was really said, and when anything at all stops that, fall back to spreading the words across the sentences
// the voice model already told us the length of.
export async function timeWords(bin: string | null, wav: string | null, parts: Part[], from = 0,
  opts: { model?: string; signal?: AbortSignal; script?: string[] } = {}): Promise<Heard> {
  // What was really said, which the caller usually knows better than the recording does: the scenes' own lines,
  // in order. Without one, the words the voice model reported back are as good as it gets.
  const script = opts.script?.length ? opts.script : parts.flatMap((part) => part.text.trim().split(/\s+/).filter(Boolean));
  // The net: spread each sentence's own length across the words in it. Where the caller named the script and the
  // voice model's own pieces do not add up to it word for word, the whole reading is spread instead — a guess that
  // is one word out on every line is worse than a coarser one that is not.
  const said = parts.flatMap((part) => part.text.trim().split(/\s+/).filter(Boolean)).length;
  const guess = (): Heard => ({
    words: said === script.length
      ? wordTimes(parts, from)
      : wordTimes([{ text: script.join(' '), seconds: parts.reduce((sum, one) => sum + one.seconds, 0) }], from),
    how: 'guessed',
  });
  if (!bin || !wav || !script.length) return guess();
  const heard = await hearWords(bin, wav, opts).catch(() => null);
  if (!heard?.length) return guess();
  const aligned = alignToScript(heard, script);
  if (aligned.length !== script.length) return guess();
  return { words: from ? aligned.map((one) => ({ ...one, at: Math.round((one.at + from) * 1000) / 1000 })) : aligned, how: 'heard' };
}

const run = (command: string, args: string[], at: string, signal?: AbortSignal) =>
  runLines(command, args, { cwd: at, env: { ...process.env, NO_COLOR: '1' }, signal });

// --- one clock for the voice and the cut ---------------------------------------------------------------------------
//
// The film is read in one go and cut against that reading, so a scene with nothing said over it has no place on the
// voice's clock. The cut used to make room for one by pushing every later scene along — and left the voice where it
// was. The site's hero film opened on a wordless title card: the voice started under it anyway, the next scene's
// captions played over the title, and the whole film ran three seconds behind its own narration, so the close's line
// was said over the picture before it and the close itself sat there in silence.
//
// So the reading is given the silence too. Every wordless scene becomes a hush put into the recording, as long as the
// scene is, at the breath between the line before it and the line after it; the words after it move along by the
// same amount. After this the recording, the words, the cut and the captions all count one clock, and a caption can
// only ever land on the scene whose line is being read.

// Which words of the reading belong to each scene: the scene's line is `from` up to (not including) `to`.
export type Span = { from: number; to: number };
// A silence to put into the recording `at` seconds into it, `seconds` long.
export type Hush = { at: number; seconds: number };

const ms = (value: number) => Math.round(value * 1000) / 1000;

// `words` are on the recording's own clock (a word's `at` is where it is in the file). What comes back is the same
// words on the film's clock, and the hushes that turn the recording into one that plays on that clock from 0:
//
//   - a breath of `lead` before the first word, the same breath every scene is given before its line;
//   - for each scene with no line, its own `quiet[index]` seconds of silence, placed where the scene falls, so the
//     line after it starts a breath after the scene has ended — never under it.
//
// A wordless scene after the last line needs no hush: nothing is said after it, and the film simply runs on.
export function sceneClock(words: Word[], spans: Span[], quiet: number[], pace: { lead: number; tail: number; min?: number }): { words: Word[]; hushes: Hush[] } {
  if (!words.length) return { words: [], hushes: [] };
  const out = words.map((one) => ({ ...one }));
  const hushes: Hush[] = [];
  let shift = 0;
  const hush = (at: number, seconds: number) => {
    if (seconds <= 0.001) return;
    const same = hushes.find((one) => Math.abs(one.at - at) < 0.0005);
    if (same) same.seconds = ms(same.seconds + seconds);
    else hushes.push({ at: ms(at), seconds: ms(seconds) });
    shift += seconds;
  };
  hush(0, pace.lead);
  // Where the last scene placed so far ends, on the film's clock: a spoken scene a short beat after its last word, as
  // the cut has it (`takesOf`), and a wordless one when its own seconds are up.
  let end = 0;
  for (const [index, span] of spans.entries()) {
    if (span.to > span.from) {
      for (let at = span.from; at < span.to && at < words.length; at += 1) out[at] = { ...words[at], at: ms(words[at].at + shift) };
      const last = out[Math.min(span.to, words.length) - 1];
      const from = index ? Math.max(end, out[span.from].at - pace.lead * 0.5) : 0;
      end = Math.max(last.at + last.seconds + pace.tail * 0.5, from + (pace.min ?? 0));
      continue;
    }
    end += Math.max(pace.min ?? 0, quiet[index] ?? 0);
    const next = span.from;
    if (next >= words.length) continue;
    // The next line starts a breath after this scene is over, wherever the reading had it.
    const wanted = end + pace.lead;
    const now = words[next].at + shift;
    if (wanted <= now) continue;
    // In the breath between the two lines, so no word is cut in half by the silence.
    const at = next === 0 ? 0 : (words[next - 1].at + words[next - 1].seconds + words[next].at) / 2;
    hush(at, wanted - now);
  }
  // Words no span reached (a script longer than its scenes) still move with the last hush.
  const placed = new Set(spans.flatMap((span) => Array.from({ length: Math.max(0, span.to - span.from) }, (_one, at) => span.from + at)));
  for (let at = 0; at < words.length; at += 1) if (!placed.has(at)) out[at] = { ...words[at], at: ms(words[at].at + shift) };
  return { words: out, hushes: hushes.sort((one, two) => one.at - two.at) };
}

// The recording with its hushes in it, as samples: what plays from the film's 0 on the film's own clock.
export function hushPcm<P extends { rate: number; samples: Float32Array }>(pcm: P, hushes: Hush[]): P {
  if (!hushes.length) return pcm;
  const cuts = [...hushes].sort((one, two) => one.at - two.at);
  const extra = cuts.reduce((sum, one) => sum + Math.round(one.seconds * pcm.rate), 0);
  const samples = new Float32Array(pcm.samples.length + extra);
  let read = 0;
  let write = 0;
  for (const cut of cuts) {
    const upTo = Math.min(pcm.samples.length, Math.max(read, Math.round(cut.at * pcm.rate)));
    samples.set(pcm.samples.subarray(read, upTo), write);
    write += upTo - read;
    read = upTo;
    write += Math.round(cut.seconds * pcm.rate);
  }
  samples.set(pcm.samples.subarray(read), write);
  return { ...pcm, samples };
}
