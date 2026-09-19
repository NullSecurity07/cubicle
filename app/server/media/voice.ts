import type { Maker, Piece } from './jobs.ts';

const RATE = 24_000;
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_RATE = 24_000;
export const SETUP_HINT = 'No voice maker is set up. The voice model runs on this machine and needs nothing but the first download; if it will not load, the founder can add GEMINI_API_KEY to .env instead and restart the app.';

// The voices the model was trained on, best first, named the way the founder picks one: no codes, no grades.
export type Voice = { id: string; name: string };
export const VOICES: Voice[] = [
  { id: 'af_heart', name: 'Heart · American woman' }, { id: 'af_bella', name: 'Bella · American woman' },
  { id: 'bf_emma', name: 'Emma · British woman' }, { id: 'af_nicole', name: 'Nicole · American woman' },
  { id: 'af_aoede', name: 'Aoede · American woman' }, { id: 'af_kore', name: 'Kore · American woman' },
  { id: 'af_sarah', name: 'Sarah · American woman' }, { id: 'am_fenrir', name: 'Fenrir · American man' },
  { id: 'am_michael', name: 'Michael · American man' }, { id: 'am_puck', name: 'Puck · American man' },
  { id: 'af_alloy', name: 'Alloy · American woman' }, { id: 'af_nova', name: 'Nova · American woman' },
  { id: 'bf_isabella', name: 'Isabella · British woman' }, { id: 'bm_george', name: 'George · British man' },
  { id: 'bm_fable', name: 'Fable · British man' }, { id: 'af_sky', name: 'Sky · American woman' },
  { id: 'bm_lewis', name: 'Lewis · British man' }, { id: 'af_jessica', name: 'Jessica · American woman' },
  { id: 'af_river', name: 'River · American woman' }, { id: 'am_echo', name: 'Echo · American man' },
  { id: 'am_eric', name: 'Eric · American man' }, { id: 'am_liam', name: 'Liam · American man' },
  { id: 'am_onyx', name: 'Onyx · American man' }, { id: 'bf_alice', name: 'Alice · British woman' },
  { id: 'bf_lily', name: 'Lily · British woman' }, { id: 'bm_daniel', name: 'Daniel · British man' },
  { id: 'am_santa', name: 'Santa · American man' }, { id: 'am_adam', name: 'Adam · American man' },
];
export const DEFAULT_VOICE = VOICES[0].id;
export const isVoice = (id: unknown): id is string => typeof id === 'string' && VOICES.some((voice) => voice.id === id);

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
    stream: (text: unknown, options: { voice: string }) => AsyncIterable<{ text?: string; audio: { audio: Float32Array; sampling_rate: number } }> };
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
    ready: () => null,
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

export const voiceMakers = (cacheDir: string, env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch): Maker[] => [kokoroVoices(cacheDir), geminiVoice(env, http)];

// A second of quiet: enough to show a player and a download, and it costs nothing in the checks.
export const fakeVoices: Maker = {
  name: 'fake',
  ready: () => null,
  async make(ask, { report }): Promise<Piece> {
    report('saying it…');
    return { ext: 'wav', bytes: wavOf(new Float32Array(RATE)), parts: [{ text: String(ask.prompt ?? ''), seconds: 1 }] };
  },
};
