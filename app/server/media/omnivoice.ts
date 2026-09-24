import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NONCOMMERCIAL, OMNI_PICKER_LINE, PERMISSION_LINE } from '../../shared/model.ts';
import type { Ask, Maker, Piece } from './jobs.ts';
import { inTurn } from './on-this-machine.ts';

// A second voice, borrowed. OmniVoice (k2-fsa, code Apache-2.0) clones a voice from a few seconds of somebody
// speaking, designs one from a short description, and speaks over 600 languages. Kokoro cannot do any of the three.
//
// The catch is the weights: they are CC-BY-NC 4.0, because of what they were trained on. A recording made with them
// may not be sold, and a founder's marketing film is selling something. So this engine is off until the founder
// turns it on, it is never the one a film casts on its own, and every file it makes carries the licence beside it.
//
// It runs in Python, which is the only place its model runs. The packages and the weights go into this app's own
// cache (`app/.cache/omnivoice`), never into the system: a project `uv` sets up once, with the pins below.

export const OMNI_ENGINE = 'omnivoice';
export const OMNI_NAME = 'OmniVoice';
// The pins, the same ones `omnivoice/requirements.txt` keeps in the repo. The torch wheels are the CUDA 12.8 build,
// which is what the model's own project asks for; on a machine with no graphics card they run on the processor.
export const PINS = ['omnivoice==0.2.1', 'torch==2.8.0', 'torchaudio==2.8.0'];
export const PYTHON = '3.12';
export const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128';
// What the first switch-on costs, said before it starts. Measured here on 24 September 2026: the packages are about
// 4 GB to download and 7 GB on disk, the two weight files 3.3 GB.
export const PACKAGES_GB = 4;
export const WEIGHTS_GB = 3.3;
// A warm model answers in seconds; a cold one takes most of a minute to load. Five quiet minutes and it is let go,
// because the graphics card it sits on is shared with the local models and the clips.
export const IDLE_MS = 5 * 60_000;

// The words that go everywhere a recording goes, shared with the card.
export { NONCOMMERCIAL, OMNI_PICKER_LINE, PERMISSION_LINE };
// The audio tokenizer inside the weights comes from Boson AI's Higgs Audio 2, whose licence asks for this line.
export const HIGGS_LINE = 'Built with Higgs Materials licensed from Boson AI USA, Inc., Copyright Boson AI USA, Inc., All Rights Reserved and Meta Llama 3 licensed under the Meta Llama 3 Community License, Copyright Meta Platforms, Inc., All Rights Reserved.';
export const creditsOf = (reference: string): string => [
  'Voice made with OmniVoice weights, CC-BY-NC 4.0: not for commercial use.',
  `Reference: ${reference}.`,
  'Model: https://huggingface.co/k2-fsa/OmniVoice · Code: https://github.com/k2-fsa/OmniVoice (Apache-2.0).',
  HIGGS_LINE,
  '',
].join('\n');

export const pyprojectOf = (pins = PINS): string => [
  '[project]',
  'name = "stage-omnivoice"',
  'version = "0"',
  `requires-python = ">=${PYTHON},<3.13"`,
  `dependencies = [${pins.map((one) => JSON.stringify(one)).join(', ')}]`,
  '',
  '[tool.uv]',
  'package = false',
  '',
  '[tool.uv.sources]',
  'torch = [{ index = "pytorch-cu128", marker = "sys_platform == \'linux\'" }]',
  'torchaudio = [{ index = "pytorch-cu128", marker = "sys_platform == \'linux\'" }]',
  '',
  '[[tool.uv.index]]',
  'name = "pytorch-cu128"',
  `url = "${TORCH_INDEX}"`,
  'explicit = true',
  '',
].join('\n');

export const omniSwitchedOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.STAGE_OMNIVOICE === '1';
export const OFF_HINT = 'OmniVoice is switched off. The founder turns it on in a Voice studio card, or sets STAGE_OMNIVOICE=1 in .env.';

// The model designs a voice from a fixed set of words, one of each kind, and refuses anything else. A founder writes
// "a calm older man, slight Irish accent", so the description is read here into the words the model knows, and
// what it cannot do is said rather than silently dropped.
const DESIGN: [kind: string, value: string, words: RegExp][] = [
  ['gender', 'male', /\b(man|men|male|guy|gentleman|boy|father|dad|grandfather|grandpa|masculine|he|his)\b/],
  ['gender', 'female', /\b(woman|women|female|lady|girl|mother|mum|mom|grandmother|grandma|feminine|she|her)\b/],
  // An age is matched as a whole phrase before its single words: "young adult" is one age, not "young" and an "adult"
  // the model cannot do.
  ['age', 'child', /\b(young child|small child|little (boy|girl)|child|kid|little)\b/],
  ['age', 'teenager', /\b(teen|teens|teenage|teenager|adolescent)\b/],
  ['age', 'middle-aged', /\b(middle[- ]aged( adult)?|mature( adult)?|forties|fifties)\b/],
  ['age', 'elderly', /\b(older adult|old|older|elderly|(?<!-)aged|senior|grandfather|grandmother|grandpa|grandma)\b/],
  ['age', 'young adult', /\b(young adult|young|youthful|twenties)\b/],
  ['pitch', 'very low pitch', /\b(very (deep|low)|booming)\b/],
  ['pitch', 'very high pitch', /\b(very high|squeaky)\b/],
  ['pitch', 'low pitch', /\b(deep|low|bass|baritone|gravelly)\b/],
  ['pitch', 'high pitch', /\b(high|high-pitched|shrill)\b/],
  ['pitch', 'moderate pitch', /\b(moderate|medium) pitch\b/],
  ['style', 'whisper', /\b(whisper|whispers|whispering|whispered|hushed)\b/],
  ['accent', 'american accent', /\b(american|us)\b/],
  ['accent', 'british accent', /\b(british|uk|london|english accent)\b/],
  ['accent', 'australian accent', /\b(australian|aussie)\b/],
  ['accent', 'canadian accent', /\bcanadian\b/],
  ['accent', 'indian accent', /\bindian\b/],
  ['accent', 'chinese accent', /\bchinese\b/],
  ['accent', 'korean accent', /\bkorean\b/],
  ['accent', 'japanese accent', /\bjapanese\b/],
  ['accent', 'portuguese accent', /\b(portuguese|brazilian)\b/],
  ['accent', 'russian accent', /\brussian\b/],
];
// Words that carry no request of their own, so leaving them out is not worth a line on the card.
const FILLER = new Set(['a', 'an', 'the', 'and', 'with', 'of', 'in', 'voice', 'voiced', 'accent', 'pitch', 'pitched', 'slight', 'slightly', 'light',
  'bit', 'very', 'quite', 'rather', 'sounding', 'sounds', 'like', 'speaker', 'tone', 'someone', 'somebody', 'person', 'who', 'is', 'reads', 'speaks',
  'english', 'medium', 'moderate', 'strong', 'soft', 'mild', 'faint', 'heavy', 'thick', 'accented', 'tones']);
export const DEFAULT_DESIGN = 'female, middle-aged, moderate pitch';

export type Design = { instruct: string; kept: string[]; dropped: string[] };
export function designOf(text: unknown): Design {
  const said = String(text ?? '').toLowerCase().replace(/[’']s\b/g, '').replace(/\s+/g, ' ').trim();
  if (!said) return { instruct: DEFAULT_DESIGN, kept: DEFAULT_DESIGN.split(', '), dropped: [] };
  const taken = new Set<string>();
  const kept: string[] = [];
  // What was matched is marked on the description as said, not cut out of a copy one entry at a time: "little girl"
  // is a child even though "girl" was already read as female, and neither word is left over to report.
  const used = new Array<boolean>(said.length).fill(false);
  for (const [kind, value, words] of DESIGN) {
    const found = [...said.matchAll(new RegExp(words.source, 'g'))];
    if (!found.length) continue;
    for (const match of found) used.fill(true, match.index, match.index + match[0].length);
    if (taken.has(kind)) continue;
    taken.add(kind);
    kept.push(value);
  }
  const rest = said.split('').map((char, at) => (used[at] ? ' ' : char)).join('');
  const dropped = [...new Set(rest.split(/[^a-z-]+/).filter((word) => word.length > 1 && !FILLER.has(word)))];
  // Nothing it could use: the house voice rather than a random one, so two takes of the same card sound alike.
  if (!kept.length) return { instruct: DEFAULT_DESIGN, kept: DEFAULT_DESIGN.split(', '), dropped };
  return { instruct: kept.join(', '), kept, dropped };
}
export const designLine = (design: Design): string => design.dropped.length
  ? `designed as ${design.instruct}; OmniVoice cannot do ${design.dropped.map((one) => `"${one}"`).join(', ')}, so that part is left out`
  : `designed as ${design.instruct}`;

// A language as the model wants it: a BCP-47 tag is cut to its first part ("pt-BR" is "pt"), and a name is passed on
// for the model to look up. One it does not know is spoken without a language set, which it does well enough.
export function languageOf(text: unknown): string | undefined {
  const said = String(text ?? '').trim();
  if (!said || /^(auto|none|any)$/i.test(said)) return undefined;
  const tag = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})*$/i.exec(said);
  return tag ? tag[1].toLowerCase() : said.slice(0, 40);
}

// The tags the model reads as a sound rather than a word. Anything else in square brackets is read out loud.
export const NONVERBAL = ['[laughter]', '[sigh]', '[confirmation-en]', '[question-en]', '[question-ah]', '[question-oh]', '[question-ei]',
  '[question-yi]', '[surprise-ah]', '[surprise-oh]', '[surprise-wa]', '[surprise-yo]', '[dissatisfaction-hnn]'];

// What goes over the pipe, one JSON object a line each way.
export type Request = { say: string; out: string; design?: string; ref?: string; ref_text?: string; language?: string };
export type Reply = { line?: string; ready?: boolean; device?: 'cuda' | 'cpu'; why?: string; wav?: string; seconds?: number; took?: number; error?: string };
export const deviceWords = (device: string | undefined): string => (device === 'cuda' ? 'the graphics card' : 'the processor');

// What was asked for, turned into one request. A clone wins over a design: a reference is the stronger instruction.
export function requestOf(ask: Ask, out: string): { request: Request; lines: string[]; reference: string } {
  const say = String(ask.prompt ?? '').trim();
  const language = languageOf(ask.language);
  const lines: string[] = [];
  const ref = typeof ask.ref === 'string' && ask.ref.trim() ? ask.ref.trim() : '';
  if (ref) {
    const name = typeof ask.clone === 'string' && ask.clone.trim() ? ask.clone.trim() : ref.split('/').pop() ?? ref;
    lines.push(`cloning the voice in ${name}`);
    const refText = typeof ask.refText === 'string' && ask.refText.trim() ? ask.refText.trim() : undefined;
    return { request: { say, out, ref, ...(refText ? { ref_text: refText } : {}), ...(language ? { language } : {}) }, lines, reference: `cloned from ${name}` };
  }
  const design = designOf(ask.design);
  lines.push(designLine(design));
  const described = typeof ask.design === 'string' && ask.design.trim() ? `designed from "${ask.design.trim().slice(0, 200)}" (${design.instruct})` : `the default design (${design.instruct})`;
  return { request: { say, out, design: design.instruct, ...(language ? { language } : {}) }, lines, reference: described };
}

// The process the model lives in, and the one command that sets it up. Both are handed in so the tests run neither.
export type Child = {
  stdin: { write: (text: string) => unknown };
  stdout: { on: (event: 'data', listen: (chunk: Buffer) => void) => unknown };
  stderr: { on: (event: 'data', listen: (chunk: Buffer) => void) => unknown };
  on: (event: 'exit', listen: (code: number | null) => void) => unknown;
  kill: () => unknown;
};
export type Starter = (python: string, args: string[], env: NodeJS.ProcessEnv) => Child;
export type Setup = (dir: string, report: (line: string) => void, signal?: AbortSignal) => Promise<void>;
export type OmniDeps = { start?: Starter; setup?: Setup; uvHere?: () => Promise<boolean>; idleMs?: number };

export const WORKER = join(import.meta.dirname, 'omnivoice', 'worker.py');
export const venvPython = (dir: string) => join(dir, '.venv', 'bin', 'python');

const startWorker: Starter = (python, args, env) => spawn(python, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
const uvHereReally = () => new Promise<boolean>((done) => execFile('uv', ['--version'], (error) => done(!error)));

// `uv sync` into the app's own cache: Python 3.12 is fetched by uv itself when this machine has not got it, and the
// packages are pinned. A stamp beside the venv says which pins it was built from, so a change of pins sets it up again.
const uvSetup: Setup = async (dir, report, signal) => {
  const stamp = join(dir, '.venv', '.stage-pins');
  const wanted = pyprojectOf();
  if (existsSync(venvPython(dir)) && (await readFile(stamp, 'utf8').catch(() => '')) === wanted) return;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pyproject.toml'), wanted);
  report(`setting up OmniVoice: about ${PACKAGES_GB} GB of Python packages, once, into ${dir}`);
  await new Promise<void>((done, fail) => {
    const child = spawn('uv', ['sync', '--python', PYTHON, '--project', dir], { env: { ...process.env, UV_PYTHON_PREFERENCE: 'only-managed' } });
    let rest = '';
    let last = '';
    const read = (chunk: Buffer) => {
      rest += chunk.toString('utf8');
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const one of lines.map((line) => line.trim()).filter(Boolean)) {
        last = one;
        // uv names the big downloads as it starts them, which is the only progress there is to give.
        const big = /^Downloading (\S+) \(([\d.]+ ?[MG]iB)\)/.exec(one);
        if (big) report(`setting up OmniVoice: ${big[1]} (${big[2]})…`);
        else if (/^(Installed|Prepared) \d+ packages?/.test(one)) report(`setting up OmniVoice: ${one.toLowerCase()}`);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (error) => fail(new Error(`uv could not be started: ${error.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) fail(new Error('stopped'));
      else if (code === 0) done();
      else fail(new Error(`OmniVoice could not be set up: ${last.slice(0, 200) || `uv stopped with ${code}`}`));
    });
  });
  await writeFile(stamp, wanted);
};

// `stop` lets the worker go at once, for a check that must not leave a model sitting on the graphics card.
export function omniVoices(cacheDir: string, env: NodeJS.ProcessEnv = process.env, deps: OmniDeps = {}): Maker & { stop(): void } {
  const start = deps.start ?? startWorker;
  const setup = deps.setup ?? uvSetup;
  const uvHere = deps.uvHere ?? uvHereReally;
  const idleMs = deps.idleMs ?? IDLE_MS;
  let setting: string | null = null;
  let noUv = false;

  // The one warm worker, and the request it is answering. Lines that arrive between requests have nobody to tell.
  type Warm = { child: Child; device: 'cuda' | 'cpu'; why: string };
  let warm: Promise<Warm> | null = null;
  let waiting: { tell: (line: string) => void; done: (reply: Reply) => void; fail: (error: Error) => void } | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let child: Child | null = null;
  const stopWorker = () => { if (idle) clearTimeout(idle); idle = null; child?.kill(); child = null; warm = null; };
  const rest = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(stopWorker, idleMs);
    (idle as { unref?: () => void }).unref?.();
  };
  process.once('exit', () => child?.kill());

  const wake = (report: (line: string) => void): Promise<Warm> => {
    warm ??= new Promise<Warm>((done, fail) => {
      const running = start(venvPython(cacheDir), ['-u', WORKER], {
        ...process.env,
        HF_HOME: join(cacheDir, 'models'),
        // The hub's newer transfer stalled on this machine and says nothing while it works; plain downloads show their size.
        HF_HUB_DISABLE_XET: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
        PYTHONUNBUFFERED: '1',
        TOKENIZERS_PARALLELISM: 'false',
        ...(env.STAGE_OMNIVOICE_DEVICE ? { STAGE_OMNIVOICE_DEVICE: env.STAGE_OMNIVOICE_DEVICE } : {}),
      });
      child = running;
      let started = false;
      let text = '';
      let said = '';
      const heard: string[] = [];
      running.stdout.on('data', (chunk) => {
        text += chunk.toString('utf8');
        const lines = text.split('\n');
        text = lines.pop() ?? '';
        for (const raw of lines) {
          let reply: Reply;
          try { reply = JSON.parse(raw) as Reply; } catch { continue; }
          if (reply.line) { (waiting?.tell ?? report)(reply.line); continue; }
          if (!started) {
            if (reply.ready) { started = true; done({ child: running, device: reply.device === 'cuda' ? 'cuda' : 'cpu', why: reply.why ?? '' }); }
            else if (reply.error) fail(new Error(reply.error));
            continue;
          }
          const now = waiting;
          waiting = null;
          now?.done(reply);
        }
      });
      running.stderr.on('data', (chunk) => {
        for (const one of chunk.toString('utf8').split('\n').map((line) => line.trim()).filter(Boolean)) heard.push(one);
        heard.splice(0, Math.max(0, heard.length - 8));
      });
      running.on('exit', (code) => {
        if (child === running) { child = null; warm = null; }
        said = heard.filter((one) => !/warn|%\|/i.test(one)).at(-1) ?? heard.at(-1) ?? `it stopped with code ${code}`;
        const why = new Error(`OmniVoice stopped: ${said.slice(0, 240)}`);
        if (!started) fail(why);
        const now = waiting;
        waiting = null;
        now?.fail(why);
      });
    }).catch((error: Error) => { warm = null; throw error; });
    return warm;
  };

  const ask = (worker: Warm, request: Request, report: (line: string) => void, signal?: AbortSignal) => new Promise<Reply>((done, fail) => {
    // A recording cannot be stopped halfway inside the model, so stopping it stops the worker; the next ask starts one.
    const stop = () => { stopWorker(); fail(new Error('stopped')); };
    if (signal?.aborted) { stop(); return; }
    signal?.addEventListener('abort', stop, { once: true });
    waiting = {
      tell: report,
      done: (reply) => { signal?.removeEventListener('abort', stop); done(reply); },
      fail: (error) => { signal?.removeEventListener('abort', stop); fail(error); },
    };
    worker.child.stdin.write(`${JSON.stringify(request)}\n`);
  });

  return {
    name: OMNI_NAME,
    engine: OMNI_ENGINE,
    stop: stopWorker,
    optIn: true,
    // Off until the founder turns it on, and busy while it is being set up. An ask that names this engine is the
    // founder turning it on for that card.
    ready(asked?: Ask) {
      if (!omniSwitchedOn(env) && asked?.engine !== OMNI_ENGINE) return OFF_HINT;
      if (noUv) return 'OmniVoice needs uv, the Python installer, on this machine: https://docs.astral.sh/uv/ (one command, no admin rights).';
      if (setting) return `OmniVoice is being set up: ${setting}`;
      return null;
    },
    async make(asked, { report, signal }): Promise<Piece> {
      const words = String(asked.prompt ?? '').trim();
      if (!words) throw new Error('there is nothing to say');
      return inTurn(async () => {
        if (!(await uvHere())) { noUv = true; throw new Error('OmniVoice needs uv, the Python installer, on this machine: https://docs.astral.sh/uv/'); }
        noUv = false;
        const firstTime = !warm;
        try {
          setting = 'starting…';
          await setup(cacheDir, (line) => { setting = line; report(line); }, signal);
          if (firstTime && !existsSync(join(cacheDir, 'models', 'hub', 'models--k2-fsa--OmniVoice'))) {
            report(`OmniVoice fetches its weights next: ${WEIGHTS_GB} GB, once`);
          }
          const worker = await wake((line) => { setting = line; report(line); });
          setting = null;
          if (firstTime) report(`OmniVoice is on ${deviceWords(worker.device)}${worker.why ? ` (${worker.why})` : ''}`);
          if (idle) clearTimeout(idle);
          const work = join(cacheDir, 'work');
          await mkdir(work, { recursive: true });
          const out = join(work, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.wav`);
          const { request, lines, reference } = requestOf({ ...asked, prompt: words }, out);
          for (const line of lines) report(line);
          report(`saying it on ${deviceWords(worker.device)}…`);
          const reply = await ask(worker, request, report, signal);
          if (reply.error) throw new Error(reply.error);
          const bytes = await readFile(reply.wav ?? out);
          await rm(reply.wav ?? out, { force: true });
          report(`made with OmniVoice: ${NONCOMMERCIAL}`);
          return {
            ext: 'wav', bytes, parts: [{ text: words, seconds: reply.seconds ?? 0 }],
            by: `OmniVoice on ${deviceWords(worker.device)}`, noncommercial: true, credits: creditsOf(reference),
          };
        } finally {
          setting = null;
          if (warm) rest();
        }
      });
    },
  };
}

// For the checks: whether the engine is set up on disk, without starting anything.
export const omniSetUp = (cacheDir: string): boolean => existsSync(venvPython(cacheDir)) && existsSync(join(cacheDir, 'models', 'hub', 'models--k2-fsa--OmniVoice'));
