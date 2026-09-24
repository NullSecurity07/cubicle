import { dirname, join } from 'node:path';
import type { Maker, Piece } from './jobs.ts';
import { OMNI_ENGINE, omniVoices } from './omnivoice.ts';

const RATE = 24_000;
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_RATE = 24_000;
export const SETUP_HINT = 'No voice maker is set up. The voice model runs on this machine and needs nothing but the first download; if it will not load, the founder can add GEMINI_API_KEY to .env instead and restart the app.';

// The voices the model was trained on, best first, named the way the founder picks one — and, beside the name, the
// three things a film has to know to cast one: who it sounds like, where it sounds like it is from, and how good it
// actually is. The model ships that table itself (`tts.voices`, one entry a voice with `gender`, `language` and
// `overallGrade`), and `castableVoices` reads it off the loaded model so this list can never drift from the weights.
// It is written out here as well because a founder opening the card should not have to wait for a 310 MB download
// before the picker has any names in it.
//
// Worth saying plainly, because it decides what a film may show: **every male voice in this model grades C+ or
// worse**, and the best voice by a long way is a woman's. A film that puts an identifiable man on screen and reads
// him in a woman's voice is the fastest credibility loss in the format, so the studio would rather show nobody than
// mismatch — see `castVoice`.
export type Grade = 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D+' | 'D' | 'D-' | 'F+' | 'F';
export type Voice = { id: string; name: string; who: string; gender: 'f' | 'm'; accent: 'American' | 'British'; grade: Grade };
// How good a grade is as one number, so voices sort without a table of special cases.
export const gradeRank = (grade: string): number => {
  const letters = 'FEDCBA';
  const at = letters.indexOf(grade[0]?.toUpperCase() ?? 'F');
  const sign = grade.includes('+') ? 0.33 : grade.includes('-') ? -0.33 : 0;
  return (at < 0 ? 0 : at) + sign;
};
export const VOICES: Voice[] = [
  { id: 'af_heart', who: 'Heart', gender: 'f', accent: 'American', grade: 'A', name: 'Heart · American woman' },
  { id: 'af_bella', who: 'Bella', gender: 'f', accent: 'American', grade: 'A-', name: 'Bella · American woman' },
  { id: 'bf_emma', who: 'Emma', gender: 'f', accent: 'British', grade: 'B-', name: 'Emma · British woman' },
  { id: 'af_nicole', who: 'Nicole', gender: 'f', accent: 'American', grade: 'B-', name: 'Nicole · American woman' },
  { id: 'af_aoede', who: 'Aoede', gender: 'f', accent: 'American', grade: 'C+', name: 'Aoede · American woman' },
  { id: 'af_kore', who: 'Kore', gender: 'f', accent: 'American', grade: 'C+', name: 'Kore · American woman' },
  { id: 'af_sarah', who: 'Sarah', gender: 'f', accent: 'American', grade: 'C+', name: 'Sarah · American woman' },
  { id: 'am_fenrir', who: 'Fenrir', gender: 'm', accent: 'American', grade: 'C+', name: 'Fenrir · American man' },
  { id: 'am_michael', who: 'Michael', gender: 'm', accent: 'American', grade: 'C+', name: 'Michael · American man' },
  { id: 'am_puck', who: 'Puck', gender: 'm', accent: 'American', grade: 'C+', name: 'Puck · American man' },
  { id: 'af_alloy', who: 'Alloy', gender: 'f', accent: 'American', grade: 'C', name: 'Alloy · American woman' },
  { id: 'af_nova', who: 'Nova', gender: 'f', accent: 'American', grade: 'C', name: 'Nova · American woman' },
  { id: 'bf_isabella', who: 'Isabella', gender: 'f', accent: 'British', grade: 'C', name: 'Isabella · British woman' },
  { id: 'bm_george', who: 'George', gender: 'm', accent: 'British', grade: 'C', name: 'George · British man' },
  { id: 'bm_fable', who: 'Fable', gender: 'm', accent: 'British', grade: 'C', name: 'Fable · British man' },
  { id: 'af_sky', who: 'Sky', gender: 'f', accent: 'American', grade: 'C-', name: 'Sky · American woman' },
  { id: 'bm_lewis', who: 'Lewis', gender: 'm', accent: 'British', grade: 'D+', name: 'Lewis · British man' },
  { id: 'af_jessica', who: 'Jessica', gender: 'f', accent: 'American', grade: 'D', name: 'Jessica · American woman' },
  { id: 'af_river', who: 'River', gender: 'f', accent: 'American', grade: 'D', name: 'River · American woman' },
  { id: 'am_echo', who: 'Echo', gender: 'm', accent: 'American', grade: 'D', name: 'Echo · American man' },
  { id: 'am_eric', who: 'Eric', gender: 'm', accent: 'American', grade: 'D', name: 'Eric · American man' },
  { id: 'am_liam', who: 'Liam', gender: 'm', accent: 'American', grade: 'D', name: 'Liam · American man' },
  { id: 'am_onyx', who: 'Onyx', gender: 'm', accent: 'American', grade: 'D', name: 'Onyx · American man' },
  { id: 'bf_alice', who: 'Alice', gender: 'f', accent: 'British', grade: 'D', name: 'Alice · British woman' },
  { id: 'bf_lily', who: 'Lily', gender: 'f', accent: 'British', grade: 'D', name: 'Lily · British woman' },
  { id: 'bm_daniel', who: 'Daniel', gender: 'm', accent: 'British', grade: 'D', name: 'Daniel · British man' },
  { id: 'am_santa', who: 'Santa', gender: 'm', accent: 'American', grade: 'D-', name: 'Santa · American man' },
  { id: 'am_adam', who: 'Adam', gender: 'm', accent: 'American', grade: 'F+', name: 'Adam · American man' },
];
export const DEFAULT_VOICE = VOICES[0].id;
export const isVoice = (id: unknown): id is string => typeof id === 'string' && VOICES.some((voice) => voice.id === id);
export const voiceOf = (id: string): Voice | undefined => VOICES.find((one) => one.id === id);
// The picker's order: best first, and within a grade the women before the men only because that is how the grades
// already fall. Nothing here hides a voice — a founder who wants the low-graded British man can still pick him.
export const byGrade = (voices: Voice[] = VOICES): Voice[] =>
  [...voices].sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade) || a.who.localeCompare(b.who));

// Who a film asks to read it. One narrator a film, always — a piece that changes voice between scenes is two
// pieces — and the best voice that fits what was asked for, because a grade is the difference between a narrator
// and a robot reading. Nothing is asked for, everything falls back: the highest-graded voice in the model.
export type Wanted = { gender?: 'f' | 'm'; accent?: 'American' | 'British' };
export function castVoice(want: Wanted, voices: Voice[] = VOICES): Voice {
  const ranked = byGrade(voices);
  const both = ranked.find((one) => (!want.gender || one.gender === want.gender) && (!want.accent || one.accent === want.accent));
  // An accent is a preference; a gender is not, because a gender is what has to match whoever is on screen.
  return both ?? ranked.find((one) => !want.gender || one.gender === want.gender) ?? ranked[0];
}
// The line the card and the log carry, so a founder never has to guess who they are hearing.
export const castLine = (voice: Voice): string => `narrator: ${voice.who}, ${voice.accent}, grade ${voice.grade}`;

// What the model itself says about its voices, read off the loaded instance rather than trusted from the table
// above. `tts.voices` is the frozen object the weights ship with; `list_voices()` only prints and returns nothing,
// so it is never used. A runtime that does not expose it at all leaves the written table standing.
type VoiceRow = { name?: string; gender?: string; language?: string; overallGrade?: string };
export function mergeVoices(said: Record<string, VoiceRow> | undefined, known: Voice[] = VOICES): Voice[] {
  if (!said || typeof said !== 'object') return known;
  const out: Voice[] = [];
  for (const [id, row] of Object.entries(said)) {
    const already = known.find((one) => one.id === id);
    const gender = /^f/i.test(String(row?.gender ?? '')) ? 'f' : /^m/i.test(String(row?.gender ?? '')) ? 'm' : already?.gender;
    const accent = /gb|uk|british/i.test(String(row?.language ?? '')) ? 'British' : /us|american/i.test(String(row?.language ?? '')) ? 'American' : already?.accent;
    if (!gender || !accent) continue;
    const who = String(row?.name ?? already?.who ?? id).trim() || id;
    const grade = (String(row?.overallGrade ?? already?.grade ?? 'D').trim() || 'D') as Grade;
    out.push({ id, who, gender, accent, grade, name: `${who} · ${accent} ${gender === 'f' ? 'woman' : 'man'}` });
  }
  return out.length ? out : known;
}

// A WAV every player and ffmpeg reads without argument: one channel, sixteen bits a sample.
export function wavOf(samples: Float32Array, rate = RATE): Buffer {
  const body = Buffer.alloc(samples.length * 2);
  for (let at = 0; at < samples.length; at += 1) body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[at])) * 32767), at * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

// How long a WAV plays, read out of the file itself. A video's scenes are as long as the line spoken over them.
export function wavSeconds(bytes: Buffer): number {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const rate = bytes.readUInt32LE(24);
  const perSample = (bytes.readUInt16LE(22) * bytes.readUInt16LE(34)) / 8;
  // The samples are not always the first chunk after the format: walk the chunks until 'data'.
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString('ascii', at, at + 4) === 'data') return rate && perSample ? Math.min(size, bytes.length - at - 8) / (rate * perSample) : 0;
    at += 8 + size + (size % 2);
  }
  return 0;
}

// Kokoro, a small voice model that runs on this machine's processor in about half the time it speaks. It is fetched
// once (310 MB) into `cacheDir` and used offline from then on; a load that fails is tried again the next time.
// The runtime's cache setting is shared with recall's model, and both only read it while a model is loading.
export function kokoroVoices(cacheDir: string): Maker {
  type Kokoro = { generate: (text: string, options: { voice: string }) => Promise<{ audio: Float32Array; sampling_rate: number }>;
    stream: (text: unknown, options: { voice: string }) => AsyncIterable<{ text?: string; audio: { audio: Float32Array; sampling_rate: number } }>;
    // The table the weights ship with, one row a voice. `list_voices()` prints it and returns nothing, so it is
    // this getter or the written table.
    voices?: Record<string, { name?: string; gender?: string; language?: string; overallGrade?: string }> };
  let ready: Promise<{ tts: Kokoro; Splitter: new () => { push: (text: string) => void; close: () => void } }> | null = null;

  const load = (report: (line: string) => void) => {
    ready ??= (async () => {
      const { env } = await import('@huggingface/transformers');
      env.cacheDir = cacheDir;
      env.allowLocalModels = false;
      const { KokoroTTS, TextSplitterStream } = await import('kokoro-js');
      // The first run fetches 310 MB, which is a long silence unless the card says what is happening.
      report('getting the voice model ready — the first time, that is a 310 MB download…');
      let said = -1;
      const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'fp32',
        device: 'cpu',
        progress_callback: (step: { status?: string; progress?: number }) => {
          if (step.status !== 'progress' || typeof step.progress !== 'number') return;
          const whole = Math.floor(step.progress / 10) * 10;
          if (whole <= said) return;
          said = whole;
          report(`getting the voice model ready, ${whole}%…`);
        },
      });
      return { tts: tts as unknown as Kokoro, Splitter: TextSplitterStream as unknown as new () => { push: (text: string) => void; close: () => void } };
    })().catch((error: Error) => { ready = null; throw error; });
    return ready;
  };

  return {
    name: 'Kokoro',
    engine: 'kokoro',
    ready: () => null,
    // Who this model can actually be, read off the weights. Asked for before the narration is recorded, which is
    // the same moment the model is loaded anyway, so it costs a film nothing.
    async cast() {
      const { tts } = await load(() => {});
      return mergeVoices(tts.voices);
    },
    async make(ask, { report, signal }) {
      const { tts, Splitter } = await load(report);
      const voice = isVoice(ask.voice) ? ask.voice : DEFAULT_VOICE;
      report('saying it…');
      const words = ask.prompt.trim();
      // Anything longer than a line or two is spoken sentence by sentence and joined, which the model handles far better.
      if (words.length <= 180) {
        const said = await tts.generate(words, { voice });
        return { ext: 'wav', bytes: wavOf(said.audio, said.sampling_rate), parts: [{ text: words, seconds: said.audio.length / said.sampling_rate }] };
      }
      const splitter = new Splitter();
      splitter.push(words);
      splitter.close();
      const pieces: Float32Array[] = [];
      // Each sentence's own length, kept beside its words: this is what a caption is timed from.
      const parts: { text: string; seconds: number }[] = [];
      let rate = RATE;
      for await (const part of tts.stream(splitter, { voice })) {
        if (signal?.aborted) throw new Error('stopped');
        pieces.push(part.audio.audio);
        rate = part.audio.sampling_rate;
        parts.push({ text: (part.text ?? '').trim(), seconds: part.audio.audio.length / part.audio.sampling_rate });
        report(`saying it… ${pieces.length} sentence${pieces.length === 1 ? '' : 's'}`);
      }
      if (!pieces.length) throw new Error('nothing came back to say');
      const whole = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
      let at = 0;
      for (const piece of pieces) { whole.set(piece, at); at += piece.length; }
      // A runtime that does not hand back the words of each piece gets one piece: captions then span the whole line.
      const said = parts.every((part) => part.text) ? parts : [{ text: words, seconds: whole.length / rate }];
      return { ext: 'wav', bytes: wavOf(whole, rate), parts: said };
    },
  };
}

// The second way out, for a machine where the local model will not load: Gemini's free text-to-speech, which
// answers with raw samples that only need a WAV header put in front of them.
export function geminiVoice(env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch): Maker {
  const model = env.STAGE_VOICE_MODEL || 'gemini-2.5-flash-preview-tts';
  return {
    name: 'Gemini',
    ready: () => (env.GEMINI_API_KEY ? null : SETUP_HINT),
    async make(ask, { report, signal }) {
      report('saying it…');
      const timeout = AbortSignal.timeout(120_000);
      const response = await http(`${GEMINI}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': String(env.GEMINI_API_KEY), 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: ask.prompt }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`Gemini answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const said = (await response.json() as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] })
        .candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData?.data;
      if (!said) throw new Error('nothing came back to say');
      const pcm = Buffer.from(said, 'base64');
      const samples = new Float32Array(pcm.length / 2);
      for (let at = 0; at < samples.length; at += 1) samples[at] = pcm.readInt16LE(at * 2) / 32768;
      return { ext: 'wav', bytes: wavOf(samples, GEMINI_RATE), parts: [{ text: ask.prompt, seconds: samples.length / GEMINI_RATE }] };
    },
  };
}

// Kokoro first, always: it is the default and the film's narrator. OmniVoice sits beside it in its own cache, tried
// only when a card or a person names it; a film holds Kokoro alone and reaches OmniVoice through `others`, so it can
// only ever read in it when the founder set the film's engine by hand.
export function voiceMakers(cacheDir: string, env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch): Maker[] {
  const omni = omniVoices(join(dirname(cacheDir), OMNI_ENGINE), env);
  return [{ ...kokoroVoices(cacheDir), others: [omni] }, omni, geminiVoice(env, http)];
}
// The engine a caller holding one voice backend asked for by name, or nothing when there is no such engine.
export const engineOf = (voices: Maker | undefined, engine: unknown): Maker | undefined =>
  !voices || typeof engine !== 'string' ? undefined : voices.engine === engine ? voices : voices.others?.find((one) => one.engine === engine);

// A second of quiet: enough to show a player and a download, and it costs nothing in the checks.
export const fakeVoices: Maker = {
  name: 'fake',
  ready: () => null,
  async make(ask, { report }): Promise<Piece> {
    report('saying it…');
    return { ext: 'wav', bytes: wavOf(new Float32Array(RATE)), parts: [{ text: String(ask.prompt ?? ''), seconds: 1 }] };
  },
};
