import { LISTEN_RATE } from '../../shared/reach.ts';
import { wavOf } from '../media/voice.ts';

// One channel of plain samples at 16 kHz in, the words out. The browser does the decoding, so nothing here has to
// know what a phone's microphone wrapped them in.
export type Transcriber = { name: string; ready(): string | null; hear(samples: Float32Array, report: (line: string) => void, signal?: AbortSignal): Promise<string> };

const MODEL = 'onnx-community/whisper-base.en';
export const MODEL_SIZE = 'about 150 MB';
export const CLOUD_HINT = 'Groq needs GROQ_API_KEY in .env.';

// Whisper on this machine, through the same runtime the voice and the recall models already use. Nothing is fetched
// until the founder holds the microphone down for the first time, and the screen says how big that is beforehand.
export function localWhisper(cacheDir: string): Transcriber {
  type Ears = (samples: Float32Array, options: Record<string, unknown>) => Promise<{ text?: string }>;
  let ready: Promise<Ears> | null = null;

  const load = (report: (line: string) => void) => {
    ready ??= (async () => {
      const { env, pipeline } = await import('@huggingface/transformers');
      env.cacheDir = cacheDir;
      env.allowLocalModels = false;
      report(`getting the listening model ready — the first time, that is a download of ${MODEL_SIZE}…`);
      let said = -1;
      const ears = await pipeline('automatic-speech-recognition', MODEL, {
        dtype: 'q8', device: 'cpu',
        progress_callback: (step: { status?: string; progress?: number }) => {
          if (step.status !== 'progress' || typeof step.progress !== 'number') return;
          const whole = Math.floor(step.progress / 10) * 10;
          if (whole <= said) return;
          said = whole;
          report(`getting the listening model ready, ${whole}%…`);
        },
      } as Parameters<typeof pipeline>[2]);
      return ears as unknown as Ears;
    })().catch((error: Error) => { ready = null; throw error; });
    return ready;
  };

  return {
    name: 'Whisper, here',
    ready: () => null,
    async hear(samples, report) {
      const ears = await load(report);
      report('writing down what you said…');
      const heard = await ears(samples, { chunk_length_s: 30, language: 'en' });
      return (heard.text ?? '').trim();
    },
  };
}

// The other way, and only with the founder's say-so: Groq's free Whisper. The sound of their voice leaves this
// machine when they use it, which is why the switch on the screen says exactly that.
export function groqWhisper(env: NodeJS.ProcessEnv = process.env, http: typeof fetch = fetch): Transcriber {
  return {
    name: 'Whisper, at Groq',
    ready: () => (env.GROQ_API_KEY ? null : CLOUD_HINT),
    async hear(samples, report, signal) {
      report('sending what you said to Groq…');
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wavOf(samples, LISTEN_RATE))], { type: 'audio/wav' }), 'said.wav');
      form.append('model', env.STAGE_SPEECH_MODEL || 'whisper-large-v3-turbo');
      form.append('response_format', 'json');
      const timeout = AbortSignal.timeout(60_000);
      const response = await http('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { authorization: `Bearer ${String(env.GROQ_API_KEY)}` }, body: form,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`Groq answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return ((await response.json() as { text?: string }).text ?? '').trim();
    },
  };
}

// The checks never download a model and never leave the machine: they hear one fixed line.
export const fakeEars: Transcriber = {
  name: 'fake',
  ready: () => null,
  async hear(samples, report) { report('writing down what you said…'); return `heard ${samples.length} samples`; },
};
