// The Hugging Face client is loaded on first use, like the voice and recall models: an optional backend must never
// keep the server from starting.
const gradio = () => import('@gradio/client');
import listed from './spaces.json' with { type: 'json' };
import type { Clip, ClipAsk, Clips, Help, PresenterAsk } from './clips.ts';

// Real moving footage — a few seconds of a scene that was never filmed, and a portrait that speaks the words it was
// given. No free API sells either. What is free is other people's public demos on Hugging Face: a Space marked
// ZeroGPU borrows an A100 for the length of one call, and a free account's daily minutes pay for it. So this asks
// those demos the way a person would, through the same queue, and keeps the file before the link goes stale.
//
// A demo is someone else's to take down. `spaces.json` is therefore the whole list — which Space, which endpoint,
// which parameter takes which of our inputs — in the order they are tried, so a dead one is a one-line edit and
// never a code change. Before every call the Space's own `/gradio_api/info` is read back and the parameter names
// checked against that line, because a demo can quietly change shape between one day and the next.
// What a clip backend is lives in one place, beside the studio that asks for one.
export type { Clip, ClipAsk, Clips, Help, PresenterAsk } from './clips.ts';

export const SETUP_HINT = 'No clip maker is set up. The founder makes a free Hugging Face account, copies a read token from huggingface.co/settings/tokens into .env as HF_TOKEN and restarts the app — the free GPU minutes it buys come back every day.';
// Every ZeroGPU Space spends the same account's minutes, so when they run out there is no second Space to try.
export const QUOTA = "today's free GPU minutes on Hugging Face are used up; they come back tomorrow";

// ZeroGPU bills a call for the whole duration the Space declares it may take, so b-roll is kept to a few seconds and
// a talking head to the length of the line it is given.
const BROLL_SECONDS = { least: 3, most: 5 };
const PRESENTER_SECONDS = { least: 1, most: 9 };
const CONNECT_TIMEOUT = 60_000;
const FETCH_TIMEOUT = 120_000;

// What our two jobs can hand a Space. A value in `spaces.json` that is one of these with a `$` in front is filled in;
// everything else is passed through as the Space's own setting.
const SLOTS = ['prompt', 'image', 'seconds', 'seed', 'portrait', 'speech'] as const;
type Slot = (typeof SLOTS)[number];
type Filling = Partial<Record<Slot, unknown>>;
// `needs` says what a listing can work from: a still to move, or words alone. Left out, it takes either.
export type Space = { name: string; space: string; endpoint: string; needs?: 'image' | 'words'; params: Record<string, unknown> };
export const spaces = listed as { broll: Space[]; presenter: Space[] };

// The shape of a Gradio app, narrowed to what is used here so a test can stand in for one.
type Note = {
  type: string;
  stage?: string;
  queue?: boolean;
  position?: number;
  eta?: number;
  message?: unknown;
  progress_data?: { progress: number | null; index?: number | null; length?: number | null; desc?: string | null }[] | null;
  data?: unknown;
};
type Job = AsyncIterable<Note> & { cancel: () => Promise<void> };
export type App = {
  view_api(): Promise<{ named_endpoints: Record<string, { parameters: { parameter_name: string }[] }> }>;
  submit(endpoint: string, args: Record<string, unknown>): Job;
  close(): void;
};
export type Connect = (space: string, options: { token: `hf_${string}` }) => Promise<App>;

const clamp = (seconds: number, { least, most }: { least: number; most: number }) =>
  Math.min(most, Math.max(least, Math.round(Number.isFinite(seconds) ? seconds : least)));

// The Spaces want a file with a name and a type, not a bag of bytes: some of them pick their loader by the ending.
const fileOf = async (bytes: Buffer, name: string, type: string) => (await gradio()).handle_file(new File([new Uint8Array(bytes)], name, { type }));

// How long a WAV plays, read out of the file itself, so a talking head is asked for exactly the line it must say.
export function speechSeconds(bytes: Buffer): number {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const rate = bytes.readUInt32LE(24);
  const perSample = (bytes.readUInt16LE(22) * bytes.readUInt16LE(34)) / 8;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4);
    if (bytes.toString('ascii', at, at + 4) === 'data') return rate && perSample ? Math.min(size, bytes.length - at - 8) / (rate * perSample) : 0;
    at += 8 + size + (size % 2);
  }
  return 0;
}

// Whatever a Space said went wrong, in words the founder can act on. The one that matters is the daily quota, which
// every Space shares and which nothing in the app can raise.
export function plainly(message: unknown): string {
  const text = typeof message === 'string' ? message
    : Array.isArray(message) ? message.map((part) => (part as { message?: string })?.message ?? String(part)).join('; ')
    : message instanceof Error ? message.message : String(message ?? '');
  const tidy = text.replace(/\s+/g, ' ').trim();
  if (/quota|gpu.{0,40}(exceed|ran out|used up|limit)|exceed.{0,40}gpu|429|too many requests/i.test(tidy)) return QUOTA;
  return tidy.slice(0, 200) || 'the Space answered with nothing';
}

// Gradio hands a file back in a couple of shapes: the file itself, or a video paired with its subtitles.
export function clipUrlOf(data: unknown): string | null {
  for (const item of Array.isArray(data) ? data : [data]) {
    if (!item || typeof item !== 'object') continue;
    const file = item as { url?: unknown; video?: unknown };
    if (typeof file.url === 'string' && file.url) return file.url;
    const inside = clipUrlOf(file.video);
    if (inside) return inside;
  }
  return null;
}

// One line for the card out of one message from the queue: where we are in it, or how far the model has got.
export function waitingLine(note: Note): string {
  if (note.stage === 'pending' && note.queue) {
    const place = typeof note.position === 'number' ? ` at ${note.position + 1}` : '';
    const wait = typeof note.eta === 'number' && note.eta > 0 ? `, about ${Math.ceil(note.eta)}s to wait` : '';
    return `waiting in the queue${place}${wait}…`;
  }
  const step = note.progress_data?.find((part) => part && (part.desc || typeof part.progress === 'number' || typeof part.index === 'number'));
  if (step) {
    const share = typeof step.progress === 'number' ? step.progress
      : typeof step.index === 'number' && step.length ? step.index / step.length : null;
    return `${step.desc || 'making the clip'}${share === null ? '' : ` ${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`}…`;
  }
  if (note.stage === 'generating' || note.stage === 'streaming') return 'making the clip…';
  return '';
}

const fill = (value: unknown, have: Filling) =>
  typeof value === 'string' && value.startsWith('$') && (SLOTS as readonly string[]).includes(value.slice(1))
    ? have[value.slice(1) as Slot] : value;

export function createClips(env: NodeJS.ProcessEnv = process.env, connect: Connect = async (space, options) => (await gradio()).Client.connect(space, options) as Promise<App>, http: typeof fetch = fetch): Clips {
  const token = () => env.HF_TOKEN as `hf_${string}` | undefined;

  // The file link a Space hands back lives for minutes, so it is fetched the moment the call returns, not later.
  async function grab(url: string, key: string, signal?: AbortSignal): Promise<Buffer> {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT);
    const ours = /(^|\.)hf\.space$|(^|\.)huggingface\.co$/.test(new URL(url).hostname);
    const response = await http(url, {
      headers: ours ? { authorization: `Bearer ${key}` } : {},
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`the clip could not be fetched back (${response.status}) — these links last only minutes`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('an empty clip came back');
    return bytes;
  }

  // A demo can be rewritten overnight. Asking it what it takes, every time, turns a silent wrong answer into a line
  // that says which Space changed and which parameter went, which is the whole edit to `spaces.json`.
  async function sameShape(app: App, spot: Space, params: Record<string, unknown>) {
    const endpoint = (await app.view_api()).named_endpoints[spot.endpoint];
    if (!endpoint) throw new Error(`the Space changed shape: ${spot.space} has no ${spot.endpoint} any more — spaces.json needs a new line`);
    const known = new Set(endpoint.parameters.map((one) => one.parameter_name));
    const gone = Object.keys(params).filter((name) => !known.has(name));
    if (gone.length) throw new Error(`the Space changed shape: ${spot.space} ${spot.endpoint} no longer takes ${gone.join(', ')} — spaces.json needs a new line`);
  }

  async function once(spot: Space, have: Filling, help: Help, key: `hf_${string}`): Promise<Buffer> {
    if (help.signal?.aborted) throw new Error('stopped');
    help.report(`asking ${spot.name} on Hugging Face…`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const app = await Promise.race([
      connect(spot.space, { token: key }),
      new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error('the Space did not answer')), CONNECT_TIMEOUT); }),
    ]).finally(() => clearTimeout(timer));
    try {
      const args: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(spot.params)) {
        const filled = fill(value, have);
        if (filled !== undefined) args[name] = filled;
      }
      await sameShape(app, spot, args);
      const job = app.submit(spot.endpoint, args);
      const stop = () => { void job.cancel(); };
      help.signal?.addEventListener('abort', stop, { once: true });
      let said = '';
      let url: string | null = null;
      let problem: string | null = null;
      try {
        for await (const note of job) {
          if (note.type === 'data') { url = clipUrlOf(note.data) ?? url; continue; }
          if (note.type !== 'status') continue;
          if (note.stage === 'error') { problem ??= plainly(note.message); continue; }
          const line = waitingLine(note);
          if (line && line !== said) { said = line; help.report(line); }
        }
      } finally {
        help.signal?.removeEventListener('abort', stop);
      }
      if (help.signal?.aborted) throw new Error('stopped');
      if (problem) throw new Error(problem);
      if (!url) throw new Error('the Space finished without a clip');
      help.report('fetching the clip back…');
      return await grab(url, key, help.signal);
    } finally {
      app.close();
    }
  }

  // The listings are tried in order, the way models are. A Space that is down, busy or rewritten costs one line on the
  // card and the next one is asked; a spent quota stops everything, because the next Space spends the same minutes.
  async function run(list: Space[], have: Filling, help: Help): Promise<Clip> {
    const key = token();
    if (!key) throw new Error(SETUP_HINT);
    const fits = list.filter((spot) => !spot.needs || (spot.needs === 'image') === (have.image !== undefined));
    if (!fits.length) throw new Error('no Space is listed for this');
    const failures: string[] = [];
    for (const spot of fits) {
      try {
        return { ext: 'mp4', bytes: await once(spot, { ...have, seed: Math.floor(Math.random() * 1_000_000) }, help, key) };
      } catch (error) {
        const why = plainly(error);
        if (why === QUOTA || help.signal?.aborted) throw new Error(why === QUOTA ? QUOTA : 'stopped');
        failures.push(`${spot.name}: ${why}`);
        help.report(`${spot.name} could not: ${why}`);
      }
    }
    throw new Error(failures.join('; '));
  }

  return {
    ready: () => (token() ? null : SETUP_HINT),
    broll: async (ask, help) => run(spaces.broll, {
      prompt: ask.prompt,
      seconds: clamp(ask.seconds, BROLL_SECONDS),
      image: ask.image && await fileOf(ask.image, 'still.png', 'image/png'),
    }, help),
    presenter: async (ask, help) => run(spaces.presenter, {
      portrait: await fileOf(ask.portrait, 'portrait.png', 'image/png'),
      speech: await fileOf(ask.speech, 'speech.wav', 'audio/wav'),
      seconds: clamp(speechSeconds(ask.speech) + 1, PRESENTER_SECONDS),
    }, help),
  };
}

// Ten frames of black that every player reads, for the checks and for fake-model mode: no token, no queue, no network.
const CLIP = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAOwbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAtt0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAIAAABAAAAAAJTbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAKABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAB/m1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAb5zdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAFA8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABoYAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAKAAAEAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAYGN0dHMAAAAAAAAACgAAAAEAAAgAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAAAgAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAKAAAAAQAAADxzdHN6AAAAAAAAAAAAAAAKAAACyQAAAAwAAAAMAAAADAAAAAwAAAASAAAADgAAAAwAAAAMAAAAEgAAABRzdGNvAAAAAAAAAAEAAAPgAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2My4xLjEwMQAAAAhmcmVlAAADS21kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAATZYiEABH//ufj/AptY+nCoYzc8QAAAAhBmiRsQQ/+4AAAAAhBnkJ4h3+3gQAAAAgBnmF0Q3+6gAAAAAgBnmNqQ3+6gQAAAA5BmmhJqEFomUwId//+4QAAAApBnoZFESw7/7eBAAAACAGepXRDf7qBAAAACAGep2pDf7qAAAAADkGaqUmoQWyZTAhv//7g';
export const fakeClips: Clips = {
  ready: () => null,
  async broll(ask, { report }) {
    report(`asking for ${clamp(ask.seconds, BROLL_SECONDS)} seconds of ${ask.image ? 'that still moving' : ask.prompt}…`);
    return { ext: 'mp4', bytes: Buffer.from(CLIP, 'base64') };
  },
  async presenter(ask, { report }) {
    report(`asking for ${speechSeconds(ask.speech).toFixed(1)} seconds of talking…`);
    return { ext: 'mp4', bytes: Buffer.from(CLIP, 'base64') };
  },
};
