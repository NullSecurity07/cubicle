import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { complete, neuronPoolOf, realClients, type ModelClient } from './providers.ts';
import { route, tierOrder } from './router.ts';
import { partnerRoute } from './partner/route.ts';
import { createUsage, pictureDrawn } from './usage.ts';

const client = (name: string, extra: Partial<ModelClient> = {}): ModelClient => ({
  name, model: `${name}-1`, maxPromptChars: 1000, tools: true, limits: { rpd: 10, rpm: 3, tpm: 1000 }, step: async () => ({ text: '', calls: [] }), ...extra,
});
const names = (result: ReturnType<typeof route>) => result.order.map((one) => one.name);

describe('route', () => {
  it('keeps the configured order while there is room, with nothing to say', () => {
    const result = route([client('alpha'), client('beta')], createUsage(null), { promptChars: 10, tools: true });
    expect(names(result)).toEqual(['alpha', 'beta']);
    expect(result.notice).toBeUndefined();
  });

  it('moves a model that is nearly out of daily quota to the back and says so', () => {
    const usage = createUsage(null);
    for (let i = 0; i < 10; i += 1) usage.record('alpha', { input: 1, output: 1 });
    const result = route([client('alpha', { limits: { rpd: 10 } }), client('beta')], usage, { promptChars: 10, tools: true });
    expect(names(result)).toEqual(['beta', 'alpha']);
    expect(result.notice).toBe("Alpha has used today's free quota, so Beta answers for now.");
  });

  it('steps aside before the per-minute token wall, and comes back after a minute', () => {
    let now = Date.parse('2026-09-19T10:00:00Z');
    const usage = createUsage(null, () => now);
    usage.record('alpha', { input: 900, output: 50 });
    const clients = [client('alpha', { limits: { tpm: 1000 } }), client('beta')];
    const hot = route(clients, usage, { promptChars: 400, tools: true });
    expect(names(hot)).toEqual(['beta', 'alpha']);
    // Most of the day is left: the founder hears it is this minute, not the day, that is full.
    expect(hot.notice).toBe('Alpha is busy this minute, so Beta answers for now.');
    now += 61_000;
    expect(names(route(clients, usage, { promptChars: 400, tools: true }))).toEqual(['alpha', 'beta']);
  });

  it('says a refused key was refused, and where to fix it', () => {
    const usage = createUsage(null);
    usage.failed('alpha', Object.assign(new Error('Invalid API Key'), { status: 401 }));
    const result = route([client('alpha'), client('beta')], usage, { promptChars: 10, tools: true });
    expect(names(result)).toEqual(['beta', 'alpha']);
    expect(result.notice).toBe("Alpha's key was refused, so Beta answers. Fix it in Keys.");
  });

  it('puts a key that takes one request at a time behind the others while it has one out', () => {
    let out = true;
    const clients = [client('zai-flash', { concurrency: 1, busy: () => out }), client('beta')];
    expect(names(route(clients, createUsage(null), { promptChars: 10, tools: true }))).toEqual(['beta', 'zai-flash']);
    out = false;
    expect(names(route(clients, createUsage(null), { promptChars: 10, tools: true }))).toEqual(['zai-flash', 'beta']);
  });

  it('believes a provider header over the published limit', () => {
    const usage = createUsage(null);
    usage.record('alpha', { input: 1, output: 1 }, { remainingRequests: 2, limitRequests: 1000 });
    expect(usage.left(client('alpha', { limits: { rpd: 1000 } }))).toBeCloseTo(0.002);
  });

  it('rests a provider that answered 429', () => {
    const usage = createUsage(null);
    usage.cool('alpha', 30_000);
    expect(names(route([client('alpha'), client('beta')], usage, { promptChars: 10, tools: true }))).toEqual(['beta', 'alpha']);
  });

  it('puts a pinned model first and warns when it runs low', () => {
    const usage = createUsage(null);
    for (let i = 0; i < 9; i += 1) usage.record('beta', { input: 1, output: 1 });
    const result = route([client('alpha'), client('beta')], usage, { pinned: 'beta', promptChars: 10, tools: true });
    expect(names(result)).toEqual(['beta', 'alpha']);
    expect(result.notice).toBe("Beta has 10% of today's free quota left.");
  });

  it('says so when the pinned model has no key here', () => {
    const result = route([client('alpha')], createUsage(null), { pinned: 'mistral', promptChars: 10, tools: true });
    expect(names(result)).toEqual(['alpha']);
    expect(result.notice).toMatch(/Mistral Small is not set up/);
  });

  it('says a side model pinned to a person is a side model, and keeps it out of the turn and its notices', () => {
    const all = [client('nvidia-lightning', { side: true }), client('gemini'), client('nvidia')];
    const result = route(all, createUsage(null), { pinned: 'nvidia-lightning', promptChars: 10, tools: true });
    expect(names(result)).toEqual(['gemini', 'nvidia']);
    expect(result.notice).toBe('Nemotron Lightning is a side model (short answers); the turn uses the normal order.');
    // Its side calls still go to it first.
    expect(names(route(all, createUsage(null), { pinned: 'nvidia-lightning', promptChars: 10, tools: true, kind: 'side' }))[0]).toBe('nvidia-lightning');
  });

  it('leaves out models that cannot hold the prompt or cannot use tools', () => {
    const result = route([client('small', { maxPromptChars: 5 }), client('mute', { tools: false }), client('ok')], createUsage(null), { promptChars: 10, tools: true });
    expect(names(result)).toEqual(['ok']);
  });

  it('keeps a model on this machine behind every hosted one with room, wherever it was listed', () => {
    const usage = createUsage(null);
    const local = client('ollama', { local: true, limits: {} });
    // Listed last, and listed first (the way summaries read the list backwards): behind the hosted ones either way.
    expect(names(route([client('alpha'), client('beta'), local], usage, { promptChars: 10, tools: true }))).toEqual(['alpha', 'beta', 'ollama']);
    const backwards = route([local, client('beta'), client('alpha')], usage, { promptChars: 10, tools: true });
    expect(names(backwards)).toEqual(['beta', 'alpha', 'ollama']);
    expect(backwards.notice).toBeUndefined();
    // Hosted ones out of room: the machine's own model answers before them, and the founder is told.
    for (let i = 0; i < 10; i += 1) { usage.record('alpha', { input: 1, output: 1 }); usage.record('beta', { input: 1, output: 1 }); }
    const spent = route([client('alpha', { limits: { rpd: 10 } }), client('beta', { limits: { rpd: 10 } }), local], usage, { promptChars: 10, tools: true });
    expect(names(spent)).toEqual(['ollama', 'alpha', 'beta']);
    expect(spent.notice).toBe("Alpha has used today's free quota, so Ollama answers for now.");
    // Pinned by a person: first, like any pinned model.
    expect(names(route([client('alpha'), local], createUsage(null), { pinned: 'ollama', promptChars: 10, tools: true }))).toEqual(['ollama', 'alpha']);
  });

  it('starts a new day at zero', () => {
    let now = Date.parse('2026-09-19T23:59:00Z');
    const usage = createUsage(null, () => now);
    for (let i = 0; i < 10; i += 1) usage.record('alpha');
    expect(usage.left(client('alpha'))).toBe(0);
    now += 120_000;
    expect(usage.left(client('alpha'))).toBe(1);
  });

  it('spreads one provider\'s keys by what each has carried, the last minute first, and moves nothing between providers', () => {
    let now = Date.parse('2026-09-24T10:00:00Z');
    const usage = createUsage(null, () => now);
    const clients = [client('alpha'), client('alpha#2'), client('beta'), client('alpha#3')];
    const order = () => names(route(clients, usage, { promptChars: 10, tools: true }));
    expect(order()).toEqual(['alpha', 'alpha#2', 'beta', 'alpha#3']);
    usage.record('alpha', { input: 300, output: 10 });
    expect(order()).toEqual(['alpha#2', 'alpha#3', 'beta', 'alpha']);
    usage.record('alpha#2', { input: 100, output: 10 });
    usage.record('alpha#3', { input: 100, output: 10 });
    expect(order()).toEqual(['alpha#2', 'alpha#3', 'beta', 'alpha']);
    // A minute on, the window is empty for all three and the day decides: the lightest day goes first.
    now += 61_000;
    expect(order()).toEqual(['alpha#2', 'alpha#3', 'beta', 'alpha']);
    usage.record('alpha#2', { input: 400, output: 10 });
    now += 61_000;
    expect(order()).toEqual(['alpha#3', 'alpha', 'beta', 'alpha#2']);
    // Pinned, the same: every key of the pinned provider, lightest first.
    expect(names(route(clients, usage, { pinned: 'alpha', promptChars: 10, tools: true }))).toEqual(['alpha#3', 'alpha', 'alpha#2', 'beta']);
  });
});

describe('a model on a daily pool shared with the pictures (round 5)', () => {
  const oss = client('cloudflare-gpt-oss', { limits: { rpd: 3 }, sharedPool: true });

  it('is skipped for the rest of the day once its own daily turns are used, and is back the next day', () => {
    let now = Date.parse('2026-09-27T10:00:00Z');
    const usage = createUsage(null, () => now);
    for (let i = 0; i < 3; i += 1) usage.record('cloudflare-gpt-oss', { input: 1, output: 1 });
    expect(usage.spent(oss)).toBe(true);
    expect(names(route([oss, client('gemini')], usage, { promptChars: 10, tools: true }))).toEqual(['gemini']);
    now = Date.parse('2026-09-28T00:01:00Z');
    expect(usage.spent(oss)).toBe(false);
    expect(names(route([oss, client('gemini')], usage, { promptChars: 10, tools: true }))).toEqual(['gemini', 'cloudflare-gpt-oss']);
  });

  it('is still asked when it is the only model there is, and a model not on a shared pool only moves to the back', () => {
    const usage = createUsage(null);
    for (let i = 0; i < 3; i += 1) { usage.record('cloudflare-gpt-oss'); usage.record('groq'); }
    expect(names(route([oss], usage, { promptChars: 10, tools: true }))).toEqual(['cloudflare-gpt-oss']);
    expect(names(route([client('groq', { limits: { rpd: 3 } }), client('gemini')], usage, { promptChars: 10, tools: true }))).toEqual(['gemini', 'groq']);
  });
});

describe('two models on one OpenRouter account (round 5)', () => {
  it('count their requests together against the account\'s 50 a day', () => {
    const usage = createUsage(null);
    const gemma = client('openrouter', { limits: { rpd: 4 } });
    const qwen = client('openrouter-qwen', { limits: { rpd: 4 } });
    const second = client('openrouter#2', { limits: { rpd: 4 } });
    for (let i = 0; i < 2; i += 1) { usage.record('openrouter'); usage.record('openrouter-qwen'); }
    expect(usage.spent(gemma)).toBe(true);
    expect(usage.spent(qwen)).toBe(true);
    expect(usage.left(qwen)).toBe(0);
    // A second key is a second account.
    expect(usage.spent(second)).toBe(false);
    usage.record('openrouter-qwen#2');
    expect(usage.left(second)).toBe(0.75);
  });
});

describe('Cloudflare\'s neuron pool (review 5)', () => {
  it('leaves every model on the pool out once the day\'s turns have spent 9,000 neurons between them, whatever their own counts', () => {
    const usage = createUsage(null);
    const oss = client('cloudflare-gpt-oss', { limits: { rpd: 25 }, sharedPool: true });
    const scout = client('cloudflare', { limits: { rpd: 10 }, sharedPool: true });
    const second = client('cloudflare#2', { limits: { rpd: 10 }, sharedPool: true });
    usage.record('cloudflare-gpt-oss', { input: 1, output: 1, neurons: 5000 });
    expect(usage.spent(scout)).toBe(false);
    usage.record('cloudflare-qwen', { input: 1, output: 1, neurons: 4000 });
    expect(usage.spent(oss)).toBe(true);
    expect(usage.spent(scout)).toBe(true);
    // A second token is on the same account (the one CLOUDFLARE_ACCOUNT_ID), so it draws on the same pool (round 6).
    expect(usage.spent(second)).toBe(true);
    expect(names(route([oss, scout, client('gemini')], usage, { promptChars: 10, tools: true }))).toEqual(['gemini']);
  });
});

describe('Cloudflare\'s neuron pool, one an account, pictures included (round 6)', () => {
  it('keys the pool by the account id, not the token, so every token and model on the account shares it', () => {
    expect(neuronPoolOf('cloudflare')).toBe('CLOUDFLARE_ACCOUNT_ID');
    expect(neuronPoolOf('cloudflare-gpt-oss#2')).toBe('CLOUDFLARE_ACCOUNT_ID');
    expect(neuronPoolOf('gemini')).toBeUndefined();
  });

  it('counts the pictures drawn today into the pool, so the turns stop at 9,000 with them in, and says how much is used', async () => {
    const usage = createUsage(join(await mkdtemp(join(tmpdir(), 'neurons-')), 'usage.json'));
    const oss = client('cloudflare-gpt-oss', { limits: { rpd: 25 }, sharedPool: true });
    usage.record('cloudflare-gpt-oss', { input: 1, output: 1, neurons: 8950 });
    expect(usage.spent(oss)).toBe(false);
    expect(usage.neurons(oss)).toEqual({ used: 8950, of: 9000, pictures: 0, drawn: 0 });
    pictureDrawn(58);
    expect(usage.spent(oss)).toBe(true);
    expect(usage.neurons(oss)).toEqual({ used: 9008, of: 9000, pictures: 58, drawn: 1 });
    expect(usage.left(oss)).toBe(0);
    expect(usage.neurons(client('gemini'))).toBeUndefined();
  });

  it('shows what is left of the day\'s neurons as what is left of the model, when that is the nearer wall', async () => {
    const usage = createUsage(join(await mkdtemp(join(tmpdir(), 'neurons-')), 'usage.json'));
    const oss = client('cloudflare-gpt-oss', { limits: { rpd: 25 }, sharedPool: true });
    usage.record('cloudflare-qwen', { input: 1, output: 1, neurons: 4500 });
    expect(usage.left(oss)).toBe(0.5);
  });
});

describe('one order for every turn, the partner\'s (pass 8)', () => {
  const listed = () => ['groq', 'cerebras', 'gemini-flash', 'gemini', 'nvidia-ultra', 'nvidia', 'zai-flash', 'vercel', 'cloudflare-gpt-oss', 'ollama-cloud', 'ollama-gpt-oss', 'sambanova', 'mistral', 'openrouter-qwen', 'hf']
    .map((name) => client(name, { maxPromptChars: 100_000, ...(name === 'gemini-flash' ? { partnerOnly: true } : {}) }));

  it('asks a colleague\'s models Gemini, Nemotron Ultra on NVIDIA, then on Ollama, Super, gpt-oss on Ollama, Mistral, SambaNova, gpt-oss on Cloudflare, the rest as listed, the low-effort gpt-oss, and Hugging Face last', () => {
    expect(names(route(listed(), createUsage(null), { promptChars: 10, tools: true })))
      .toEqual(['gemini', 'nvidia-ultra', 'ollama-cloud', 'nvidia', 'ollama-gpt-oss', 'mistral', 'sambanova', 'cloudflare-gpt-oss', 'openrouter-qwen', 'zai-flash', 'vercel', 'groq', 'cerebras', 'hf']);
  });

  it('puts Gemini 3.5 Flash first for the reserved turns of the partner and keeps gpt-oss on Cloudflare behind the two Nemotron Ultras for them', () => {
    expect(tierOrder(true).slice(0, 9)).toEqual(['gemini-flash', 'gemini', 'nvidia-ultra', 'ollama-cloud', 'cloudflare-gpt-oss', 'nvidia', 'ollama-gpt-oss', 'mistral', 'sambanova']);
    expect(names(partnerRoute(listed(), createUsage(null), { promptChars: 10, tools: true, reserved: true })))
      .toEqual(['gemini-flash', 'gemini', 'nvidia-ultra', 'ollama-cloud', 'cloudflare-gpt-oss', 'nvidia', 'ollama-gpt-oss', 'mistral', 'sambanova', 'openrouter-qwen', 'zai-flash', 'vercel', 'cerebras', 'hf']);
  });

  it('never gives the partner-only model to a colleague, a pin or a side call', () => {
    const usage = createUsage(null);
    expect(names(route(listed(), usage, { promptChars: 10, tools: true, pinned: 'gemini-flash' }))).not.toContain('gemini-flash');
    expect(names(route(listed(), usage, { promptChars: 10, tools: false, kind: 'side' }))).not.toContain('gemini-flash');
    expect(usage.info(listed()).map((row) => row.name)).not.toContain('gemini-flash');
  });

  it('leaves Hugging Face out once its 30 requests of the month are used, even when it is all there is, and counts them across days', () => {
    let at = Date.parse('2026-10-06T12:00:00Z');
    const usage = createUsage(null, () => at);
    const hf = client('hf', { limits: { rpm: 10, rpmo: 30 } });
    for (let i = 0; i < 29; i += 1) { usage.record('hf'); at += 3_600_000; }
    expect(usage.left(hf)).toBeCloseTo(1 / 30);
    expect(names(route([hf], usage, { promptChars: 10, tools: true }))).toEqual(['hf']);
    usage.record('hf');
    expect(names(route([client('gemini'), hf], usage, { promptChars: 10, tools: true }))).toEqual(['gemini']);
    expect(route([hf], usage, { promptChars: 10, tools: true }).order).toEqual([]);
    at = Date.parse('2026-11-01T00:30:00Z');
    expect(names(route([hf], usage, { promptChars: 10, tools: true }))).toEqual(['hf']);
  });

  it('leaves side calls in the order they were given', () => {
    const listed = [client('vercel'), client('gemini')];
    expect(names(route(listed, createUsage(null), { promptChars: 10, tools: false, kind: 'side' }))).toEqual(['vercel', 'gemini']);
  });

  it('moves a model resting slow to the back and says it was slow to start', () => {
    const usage = createUsage(null);
    for (let at = 0; at < 2; at += 1) usage.failed('gemini', new Error('no first word within 20 s (timed out)'));
    const result = route([client('gemini'), client('cloudflare-gpt-oss')], usage, { promptChars: 10, tools: true });
    expect(names(result)).toEqual(['cloudflare-gpt-oss', 'gemini']);
    expect(result.notice).toBe('Gemini Flash-Lite was slow to start answering twice, so gpt-oss on Cloudflare answers for now.');
  });
});

describe('a stalled Gemini and a stalled NVIDIA, with real clients on a fake clock (pass 8)', () => {
  const env = { GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'nvapi-x', MISTRAL_API_KEY: 'm', CLOUDFLARE_API_TOKEN: 'c', CLOUDFLARE_ACCOUNT_ID: 'acct' } as NodeJS.ProcessEnv;
  const messages = [{ role: 'system' as const, content: 'You are Rohan, the founder-fit reviewer.' }, { role: 'user' as const, content: 'Write the fit section.' }];
  const tools = [{ name: 'read_doc', description: 'Read a doc', parameters: { type: 'object', properties: {} } }];
  // A provider that never says a word until the request is aborted, one that answers at once, or one that answers
  // after `after` ms unless the request is aborted first.
  const script = (one: ModelClient, silent: boolean, after = 0) => {
    (one.openai!.chat.completions as unknown as { create: unknown }).create = (_body: unknown, options: { signal?: AbortSignal }) => ({
      withResponse: async () => {
        if (silent) await new Promise((_, fail) => options.signal?.addEventListener('abort', () => fail(new Error('Request was aborted.')), { once: true }));
        else if (after) await new Promise<void>((done, fail) => { const timer = setTimeout(done, after); options.signal?.addEventListener('abort', () => { clearTimeout(timer); fail(new Error('Request was aborted.')); }, { once: true }); });
        async function* chunks() { yield { choices: [{ delta: { content: `${one.name} answers.` } }] }; }
        return { data: chunks(), response: { headers: new Headers() } };
      },
    });
  };
  const setUp = (skip: string[] = []) => {
    // The quick Nemotrons on the NVIDIA key and the partner's Gemini 3.5 Flash are left out: these are about the slow
    // Gemini and the slow Kimi.
    const clients = realClients(env).filter((one) => !skip.includes(one.name) && !['nvidia', 'nvidia-ultra', 'gemini-flash'].includes(one.name));
    for (const one of clients) script(one, one.name === 'gemini' || one.name === 'nvidia-kimi');
    return { clients, usage: createUsage(null) };
  };
  const turn = async ({ clients, usage }: ReturnType<typeof setUp>, partner = false) => {
    const started = Date.now();
    const want = { promptChars: 200, tools: true };
    const { order, notice } = partner ? partnerRoute(clients, usage, want) : route(clients, usage, want);
    let result: Awaited<ReturnType<typeof complete>> | undefined;
    const done = complete(messages, { tools, onToken: () => {}, onRestart: () => {} }, order, ({ client: one, error }) => usage.failed(one.name, error), (one) => usage.admit(one.name), (one) => usage.resting(one.name), (one) => usage.blocked(one.name))
      .then((reply) => { result = reply; usage.record(reply.client.name, reply.usage); });
    while (!result) await vi.advanceTimersByTimeAsync(500);
    await done;
    return { seconds: (Date.now() - started) / 1000, by: result.client.name, notice };
  };

  it('reaches Cloudflare within about 20 s on the partner\'s first and second turns, and at once from the third', async () => {
    vi.useFakeTimers();
    try {
      const set = setUp();
      const first = await turn(set, true);
      expect(first.by).toBe('cloudflare-gpt-oss');
      expect(first.seconds).toBeLessThanOrEqual(25);
      const second = await turn(set, true);
      expect(second.by).toBe('cloudflare-gpt-oss');
      expect(second.seconds).toBeLessThanOrEqual(25);
      const third = await turn(set, true);
      expect(third.by).toBe('cloudflare-gpt-oss');
      expect(third.seconds).toBeLessThan(1);
      // A colleague's turn skips the resting Gemini, and Mistral answers before Cloudflare; Kimi is behind them both.
      const colleague = await turn(set);
      expect(colleague).toMatchObject({ by: 'mistral', notice: 'Gemini Flash-Lite was slow to start answering twice, so Mistral Small answers for now.' });
      expect(colleague.seconds).toBeLessThan(1);
    } finally { vi.useRealTimers(); }
  });

  it('gives NVIDIA its minute when the only model behind it has a refused key, and its long wait when it is the last able', async () => {
    vi.useFakeTimers();
    try {
      // Mistral's plan is off: it cannot answer, so NVIDIA is really the last one and is not cut at 20 s.
      const refusedBehind = setUp(['cloudflare-gpt-oss', 'cloudflare-qwen', 'cloudflare']);
      script(refusedBehind.clients.find((one) => one.name === 'nvidia-kimi')!, false, 45_000);
      refusedBehind.usage.failed('mistral', Object.assign(new Error('429 Rate limit exceeded'), { status: 429, headers: new Headers({ 'x-ratelimit-limit-req-minute': '0' }) }));
      const first = await turn(refusedBehind);
      expect(first.by).toBe('nvidia-kimi');
      expect(first.seconds).toBeGreaterThanOrEqual(65);
      // Nobody at all behind it: the last model able waits well past its minute.
      const alone = setUp(['cloudflare-gpt-oss', 'cloudflare-qwen', 'cloudflare', 'mistral']);
      script(alone.clients.find((one) => one.name === 'nvidia-kimi')!, false, 100_000);
      const last = await turn(alone);
      expect(last.by).toBe('nvidia-kimi');
      expect(last.seconds).toBeGreaterThanOrEqual(120);
    } finally { vi.useRealTimers(); }
  });

  it('cuts Kimi at 20 s, not 60, while a model behind it can answer, and rests both after their second silence', async () => {
    vi.useFakeTimers();
    try {
      // No Mistral and gpt-oss and Qwen on Cloudflare spent for the day: Gemini, then Kimi, then Scout on Cloudflare.
      const set = setUp(['cloudflare-gpt-oss', 'cloudflare-qwen', 'mistral']);
      const first = await turn(set);
      expect(first.by).toBe('cloudflare');
      expect(first.seconds).toBeGreaterThanOrEqual(40);
      expect(first.seconds).toBeLessThanOrEqual(45);
      await turn(set);
      const third = await turn(set);
      expect(third.by).toBe('cloudflare');
      expect(third.seconds).toBeLessThan(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('an empty stream from NVIDIA (2026-10-06)', () => {
  it('passes the turn to the next model and holds nothing against the key: one empty reply is not a failure', async () => {
    const clients = realClients({ NVIDIA_API_KEY: 'nvapi-x' } as NodeJS.ProcessEnv).filter((one) => ['nvidia-ultra', 'nvidia'].includes(one.name));
    expect(clients.map((one) => one.name)).toEqual(['nvidia-ultra', 'nvidia']);
    for (const one of clients) {
      (one.openai!.chat.completions as unknown as { create: unknown }).create = () => ({
        withResponse: async () => {
          // Ultra's throttled answer: a chunk naming who speaks and nothing else, then the end.
          async function* chunks() { if (one.name === 'nvidia') yield { choices: [{ delta: { content: 'Super answers.' } }] }; else yield { choices: [{ delta: { role: 'assistant' } }] }; }
          return { data: chunks(), response: { headers: new Headers() } };
        },
      });
    }
    const usage = createUsage(null);
    const failures: string[] = [];
    const reply = await complete([{ role: 'user', content: 'hi' }], { onToken: () => {} }, clients, ({ client: one, error }) => { failures.push(one.name); usage.failed(one.name, error); }, (one) => usage.admit(one.name));
    expect(reply).toMatchObject({ text: 'Super answers.', client: { name: 'nvidia' } });
    expect(failures).toEqual([]);
    expect(usage.breaker('nvidia-ultra')).toBe('closed');
    expect(usage.resting('nvidia-ultra')).toBe(false);
  });
});
