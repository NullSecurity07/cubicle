import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type Stage } from '../../shared/model.ts';
import { createStore } from '../store.ts';
import { mediaTools } from '../tools/media.ts';
import { createMedia, type Maker } from './jobs.ts';
import {
  creditsOf, DEFAULT_DESIGN, designLine, designOf, languageOf, NONCOMMERCIAL, OFF_HINT, OMNI_ENGINE, omniVoices, PINS, pyprojectOf, requestOf,
  type Child, type Request,
} from './omnivoice.ts';
import { engineOf, fakeVoices, voiceMakers, wavOf } from './voice.ts';

describe('designing a voice from the founder\'s words', () => {
  it('keeps what the model can do and says what it cannot', () => {
    const design = designOf('a calm older man, slight Irish accent');
    expect(design.instruct).toBe('male, elderly');
    expect(design.dropped).toEqual(['calm', 'irish']);
    expect(designLine(design)).toBe('designed as male, elderly; OmniVoice cannot do "calm", "irish", so that part is left out');
  });

  it('reads every kind the model knows, one of each', () => {
    expect(designOf('Middle-aged woman, deep voice, whispering, Australian').instruct).toBe('female, middle-aged, low pitch, whisper, australian accent');
    expect(designOf('a very deep British man').instruct).toBe('male, very low pitch, british accent');
    expect(designOf('young woman with an English accent').instruct).toBe('female, young adult, british accent');
  });

  it('falls back to one steady house voice rather than a random one', () => {
    expect(designOf('').instruct).toBe(DEFAULT_DESIGN);
    expect(designOf('a robot').instruct).toBe(DEFAULT_DESIGN);
    expect(designOf('a robot').dropped).toEqual(['robot']);
  });
});

describe('languages', () => {
  it('cuts a tag to its language and passes a name on', () => {
    expect(languageOf('pt-BR')).toBe('pt');
    expect(languageOf('ES')).toBe('es');
    expect(languageOf('Hindi')).toBe('Hindi');
    expect(languageOf('auto')).toBeUndefined();
    expect(languageOf('')).toBeUndefined();
  });
});

describe('one request', () => {
  it('prefers a clone to a design, and carries the words of the reference when they are known', () => {
    const cloned = requestOf({ prompt: 'Hi', ref: '/files/me.wav', refText: 'Hello there', clone: 'me', design: 'old man', language: 'de-DE' }, '/out.wav');
    expect(cloned.request).toEqual({ say: 'Hi', out: '/out.wav', ref: '/files/me.wav', ref_text: 'Hello there', language: 'de' });
    expect(cloned.reference).toBe('cloned from me');
    const designed = requestOf({ prompt: 'Hi', design: 'old man' }, '/out.wav');
    expect(designed.request).toEqual({ say: 'Hi', out: '/out.wav', design: 'male, elderly' });
    expect(designed.reference).toBe('designed from "old man" (male, elderly)');
  });
});

describe('the pins', () => {
  it('are the same in the generated project and in the repo', async () => {
    const kept = (await readFile(join(import.meta.dirname, 'omnivoice', 'requirements.txt'), 'utf8')).split('\n').filter((line) => line && !line.startsWith('#'));
    expect(kept).toEqual(PINS);
    const project = pyprojectOf();
    for (const pin of PINS) expect(project).toContain(`"${pin}"`);
    expect(project).toContain('https://download.pytorch.org/whl/cu128');
  });

  it('say the licence in the credits', () => {
    const credits = creditsOf('designed from "old man"');
    expect(credits).toContain('CC-BY-NC 4.0: not for commercial use');
    expect(credits).toContain('Reference: designed from "old man".');
    expect(credits).toContain('Built with Higgs Materials');
  });
});

// A worker that answers the way the real one does, without Python.
function fakeWorker(opts: { device?: 'cuda' | 'cpu'; fail?: string; answer?: (ask: Request) => Promise<Record<string, unknown>> } = {}) {
  const started: Request[][] = [];
  let killed = 0;
  const start = () => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & Child;
    const asks: Request[] = [];
    started.push(asks);
    const send = (message: unknown) => out.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
    Object.assign(child, {
      stdout: out, stderr: err,
      stdin: {
        write: (text: string) => {
          const ask = JSON.parse(text) as Request;
          asks.push(ask);
          void (async () => {
            send({ line: 'thinking…' });
            const answer = opts.answer ? await opts.answer(ask) : (await writeFile(ask.out, wavOf(new Float32Array(24_000))), { wav: ask.out, seconds: 1 });
            send(answer);
          })();
        },
      },
      kill: () => { killed += 1; child.emit('exit', null); },
    });
    setTimeout(() => {
      out.emit('data', Buffer.from('some library chatter that is not json\n'));
      send({ line: 'loading OmniVoice on the processor…' });
      if (opts.fail) { err.emit('data', Buffer.from(`Traceback\n${opts.fail}\n`)); child.emit('exit', 1); return; }
      send({ ready: true, device: opts.device ?? 'cpu', why: 'the graphics card has 0.9 GB free and this needs about 2.4' });
    }, 1);
    return child;
  };
  return { start, started, killed: () => killed };
}

const engine = async (worker: ReturnType<typeof fakeWorker>, env: NodeJS.ProcessEnv = { STAGE_OMNIVOICE: '1' }, more: { idleMs?: number; uv?: boolean } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'omni-'));
  const setups: string[] = [];
  return {
    dir, setups,
    maker: omniVoices(dir, env, {
      start: worker.start, idleMs: more.idleMs ?? 60_000, uvHere: async () => more.uv ?? true,
      setup: async (at, report) => { setups.push(at); report('setting up OmniVoice: about 4 GB of Python packages, once'); },
    }),
  };
};

describe('the OmniVoice engine', () => {
  it('is off until the founder turns it on, and an ask that names it is the turning on', async () => {
    const { maker } = await engine(fakeWorker(), {});
    expect(maker.ready()).toBe(OFF_HINT);
    expect(maker.ready({ prompt: 'x', engine: OMNI_ENGINE })).toBeNull();
    expect(maker.optIn).toBe(true);
    expect((await engine(fakeWorker())).maker.ready()).toBeNull();
  });

  it('sets up, says where it runs, and marks what it makes as not for sale', async () => {
    const worker = fakeWorker();
    const { maker, setups, dir } = await engine(worker);
    const lines: string[] = [];
    const piece = await maker.make({ prompt: 'Hello there.', design: 'calm older man, Irish accent' }, { report: (line) => lines.push(line) });
    expect(setups).toEqual([dir]);
    expect(piece.ext).toBe('wav');
    expect(piece.by).toBe('OmniVoice on the processor');
    expect(piece.noncommercial).toBe(true);
    expect(piece.credits).toContain('Reference: designed from "calm older man, Irish accent" (male, elderly).');
    expect(piece.parts).toEqual([{ text: 'Hello there.', seconds: 1 }]);
    expect(worker.started[0]).toEqual([expect.objectContaining({ say: 'Hello there.', design: 'male, elderly' })]);
    expect(lines).toEqual(expect.arrayContaining([
      'setting up OmniVoice: about 4 GB of Python packages, once',
      'loading OmniVoice on the processor…',
      'OmniVoice is on the processor (the graphics card has 0.9 GB free and this needs about 2.4)',
      'designed as male, elderly; OmniVoice cannot do "calm", "irish", so that part is left out',
      'thinking…',
      `made with OmniVoice: ${NONCOMMERCIAL}`,
    ]));
  });

  it('stays warm between asks, and lets go of the graphics card when nobody has asked for a while', async () => {
    const worker = fakeWorker({ device: 'cuda' });
    const { maker } = await engine(worker, undefined, { idleMs: 30 });
    const first = await maker.make({ prompt: 'One.' }, { report: () => {} });
    await maker.make({ prompt: 'Two.' }, { report: () => {} });
    expect(first.by).toBe('OmniVoice on the graphics card');
    expect(worker.started).toHaveLength(1);
    expect(worker.started[0].map((one) => one.say)).toEqual(['One.', 'Two.']);
    await new Promise((wait) => setTimeout(wait, 80));
    expect(worker.killed()).toBe(1);
    await maker.make({ prompt: 'Three.' }, { report: () => {} });
    expect(worker.started).toHaveLength(2);
  });

  it('passes on what went wrong as a sentence, and keeps the worker', async () => {
    const worker = fakeWorker({ answer: async () => ({ error: "Language 'xx' is not recognized" }) });
    const { maker } = await engine(worker);
    await expect(maker.make({ prompt: 'Hi' }, { report: () => {} })).rejects.toThrow("Language 'xx' is not recognized");
    await expect(maker.make({ prompt: 'Hi' }, { report: () => {} })).rejects.toThrow(/not recognized/);
    expect(worker.started).toHaveLength(1);
  });

  it('says why a worker that died while starting never came up', async () => {
    const { maker } = await engine(fakeWorker({ fail: 'torch.OutOfMemoryError: CUDA out of memory' }));
    await expect(maker.make({ prompt: 'Hi' }, { report: () => {} })).rejects.toThrow('OmniVoice stopped: torch.OutOfMemoryError: CUDA out of memory');
  });

  it('stops the worker when the founder stops the job', async () => {
    const worker = fakeWorker({ answer: () => new Promise(() => {}) });
    const { maker } = await engine(worker);
    const stop = new AbortController();
    const making = maker.make({ prompt: 'Hi' }, { report: () => {}, signal: stop.signal });
    await new Promise((wait) => setTimeout(wait, 20));
    stop.abort();
    await expect(making).rejects.toThrow('stopped');
    expect(worker.killed()).toBe(1);
  });

  it('asks for uv when there is none, in words the founder can act on', async () => {
    const { maker } = await engine(fakeWorker(), undefined, { uv: false });
    await expect(maker.make({ prompt: 'Hi' }, { report: () => {} })).rejects.toThrow(/needs uv/);
    expect(maker.ready()).toMatch(/needs uv/);
  });
});

describe('beside Kokoro', () => {
  it('comes after Kokoro, and a film holding Kokoro alone can still reach it by name', () => {
    const makers = voiceMakers('/nowhere/.cache/voice', {});
    expect(makers.map((one) => one.name)).toEqual(['Kokoro', 'OmniVoice', 'Gemini']);
    expect(engineOf(makers[0], OMNI_ENGINE)?.name).toBe('OmniVoice');
    expect(engineOf(makers[0], 'kokoro')?.name).toBe('Kokoro');
    expect(engineOf(makers[0], 'somebody')).toBeUndefined();
  });
});

describe('a voice studio with two engines', () => {
  const said: Record<string, unknown>[] = [];
  const omni: Maker = {
    name: 'OmniVoice', engine: OMNI_ENGINE, optIn: true, ready: (ask) => (ask?.engine === OMNI_ENGINE ? null : OFF_HINT),
    async make(ask) {
      said.push(ask);
      return { ext: 'wav', bytes: wavOf(new Float32Array(2400)), by: 'OmniVoice on the processor', noncommercial: true, credits: creditsOf('cloned from me') };
    },
  };
  const kokoro: Maker = { ...fakeVoices, name: 'Kokoro', engine: 'kokoro', make: async (ask) => { said.push(ask); return fakeVoices.make(ask, { report: () => {} }); } };
  const card = { id: 'studio-2', kind: 'voicegen' as const, x: 0, y: 0, w: 1, h: 1 };
  const setUp = async () => {
    said.length = 0;
    const dir = await mkdtemp(join(tmpdir(), 'omnijobs-'));
    const store = createStore(dir);
    return { store, media: createMedia({ dir, store, makers: { voicegen: [kokoro, omni] } }) };
  };

  it('leaves the opt-in engine out unless it is named, and tries nothing else when it is', async () => {
    const { media } = await setUp();
    expect(media.ready('voicegen')).toBeNull();
    await media.make(card, { prompt: 'Plain.' });
    expect(said.map((one) => one.engine)).toEqual([undefined]);
    const made = await media.make(card, { prompt: 'Borrowed.', engine: OMNI_ENGINE });
    expect(said.at(-1)?.engine).toBe(OMNI_ENGINE);
    expect(made.noncommercial).toBe(true);
    expect(made.by).toBe('OmniVoice on the processor');
    expect(made.credits).toBe(`${made.path}.credits.txt`);
    expect((await media.read(card.id)).log.at(-1)).toBe('done · OmniVoice');
  });

  it('writes the licence beside the file', async () => {
    const { media, store } = await setUp();
    const made = await media.make(card, { prompt: 'Borrowed.', engine: OMNI_ENGINE });
    expect(String(await store.readFileBytes(made.credits!))).toContain('not for commercial use');
  });

  it('clones from a recording dropped on the card, or from one of its own with the words it said', async () => {
    const { media, store } = await setUp();
    const own = await media.make(card, { prompt: 'Hello there.' });
    await media.make(card, { prompt: 'Again.', engine: OMNI_ENGINE, clone: own.path });
    expect(said.at(-1)).toMatchObject({ ref: store.pathOf(own.path), refText: 'Hello there.' });
    await store.saveFileBytes('me.wav', wavOf(new Float32Array(24_000)));
    await media.addAsset(card.id, { file: 'me.wav', path: 'me.wav', kind: 'audio', bytes: 1000, seconds: 8 });
    await media.make(card, { prompt: 'Once more.', engine: OMNI_ENGINE, clone: 'me' });
    expect(said.at(-1)).toMatchObject({ ref: store.pathOf('me.wav') });
    expect(said.at(-1)?.refText).toBeUndefined();
    await expect(media.make(card, { prompt: 'No.', engine: OMNI_ENGINE, clone: 'nobody' })).rejects.toThrow(/there is no recording called nobody on this card/);
  });
});

describe('generate_voice with OmniVoice', () => {
  const stageWith = (extra: Record<string, unknown> = {}): Stage => ({
    ...seedStage,
    cards: [{ id: 'studio-2', kind: 'voicegen', x: 0, y: 0, w: 1, h: 1, ...extra }],
    wires: [...seedStage.wires, { id: 'w', from: 'studio-2', fromHandle: 'r', to: 'marketing', toHandle: 'l' }],
  });
  const turn = async (stage: Stage, env: NodeJS.ProcessEnv = {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'omnitool-'));
    const store = createStore(dir);
    const asks: Record<string, unknown>[] = [];
    const omni: Maker = {
      name: 'OmniVoice', engine: OMNI_ENGINE, optIn: true, ready: () => null,
      async make(ask) { asks.push(ask); return { ext: 'wav', bytes: wavOf(new Float32Array(2400)), noncommercial: true, credits: creditsOf('x') }; },
    };
    const media = createMedia({ dir, store, makers: { voicegen: [fakeVoices, omni] } });
    const tool = mediaTools(media, () => false, env).find((one) => one.name === 'generate_voice')!;
    return { tool, asks, context: { stage, roomId: 'marketing', store, granted: new Map<string, string>() } };
  };

  it('will not switch it on for the founder', async () => {
    const { tool, context } = await turn(stageWith());
    await expect(tool.run({ text: 'Hola', engine: OMNI_ENGINE }, context)).rejects.toThrow(/OmniVoice is switched off on this card/);
    await expect(tool.run({ text: 'Hola', design: 'old man' }, context)).rejects.toThrow(/switched off/);
  });

  it('uses it when the card is set to it, with the card\'s own design, and says the licence in the reply', async () => {
    const { tool, context, asks } = await turn(stageWith({ engine: 'omnivoice', design: 'old man' }));
    const ran = await tool.run({ text: 'Hola, amigos.', language: 'es' }, context);
    expect(asks[0]).toMatchObject({ engine: OMNI_ENGINE, design: 'old man', language: 'es', prompt: 'Hola, amigos.' });
    expect(ran.text).toContain(`Made with OmniVoice: ${NONCOMMERCIAL}`);
  });

  it('uses it when .env switched it on, and Kokoro when asked for by name', async () => {
    const { tool, context, asks } = await turn(stageWith(), { STAGE_OMNIVOICE: '1' });
    await tool.run({ text: 'Hi', engine: OMNI_ENGINE, design: 'young woman' }, context);
    expect(asks).toHaveLength(1);
    const plain = await tool.run({ text: 'Hi', engine: 'kokoro' }, context);
    expect(asks).toHaveLength(1);
    expect(plain.text).not.toContain('OmniVoice');
  });
});
