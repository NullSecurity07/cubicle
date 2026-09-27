import { describe, expect, it, vi } from 'vitest';
import { fitHistory, plainBreak, plainFailure, scrubProvider, wireTools, collectCalls, complete, expand, portable, readQuota, realClients, unset, type ModelClient, type ToolCall } from './providers.ts';

const client = (name: string, tokens: string[] | Error, maxPromptChars = Infinity): ModelClient => ({
  name, model: `${name}-1`, maxPromptChars, tools: true, limits: {},
  async step(_messages, { onToken }) {
    if (tokens instanceof Error) throw tokens;
    tokens.forEach(onToken);
    return { text: '', calls: [] };
  },
});
const streamReply = async (input: typeof messages, onToken: (token: string) => void, clients: ModelClient[]) => {
  const result = await complete(input, { onToken }, clients);
  return { text: result.text, provider: result.client.name };
};
const messages = [{ role: 'user' as const, content: 'hello' }];

describe('streamReply', () => {
  it('streams from the first client that answers', async () => {
    const seen: string[] = [];
    const result = await streamReply(messages, (t) => seen.push(t), [client('a', ['Hi', ' there']), client('b', ['no'])]);
    expect(result).toEqual({ text: 'Hi there', provider: 'a' });
    expect(seen).toEqual(['Hi', ' there']);
  });

  it('falls through on an error and on an empty reply', async () => {
    const result = await streamReply(messages, () => {}, [client('a', new Error('429')), client('b', ['', '  ']), client('c', ['ok'])]);
    expect(result).toEqual({ text: 'ok', provider: 'c' });
  });

  it('skips a client whose prompt budget is too small', async () => {
    const result = await streamReply(messages, () => {}, [client('small', ['x'], 3), client('big', ['y'])]);
    expect(result.provider).toBe('big');
  });

  it('reports every failure when nobody answers', async () => {
    await expect(streamReply(messages, () => {}, [client('a', new Error('boom')), client('b', [])])).rejects.toThrow(/a: boom.*b: empty reply/s);
  });
});

describe('streamReply, cut off mid-stream', () => {
  it('keeps what was already streamed instead of answering twice', async () => {
    const flaky: ModelClient = { ...client('flaky', []), async step(_messages, { onToken }) { onToken('Half an'); throw new Error('reset'); } };
    const result = await streamReply(messages, () => {}, [flaky, client('b', ['other'])]);
    expect(result).toEqual({ text: 'Half an', provider: 'flaky' });
  });

  it('marks a reply the stream broke off as cut, with the reason, so it never passes for a whole answer', async () => {
    const flaky: ModelClient = { ...client('flaky', []), async step(_messages, { onToken }) { onToken('Half an'); throw new Error('socket hang up'); } };
    const result = await complete(messages, { onToken: () => {} }, [flaky]);
    expect(result).toMatchObject({ text: 'Half an', cut: true, broke: 'socket hang up', calls: [] });
  });
});

describe('complete, a stream that breaks part way with another model to ask', () => {
  // Groq's qwen, journey 3: three tokens of "Let me ground the critique", then a 400 about a tool call it could not make.
  const breaking = (name: string) => ({
    ...client(name, []),
    async step(_messages: unknown, { onToken }: { onToken: (token: string) => void }) {
      for (const token of ['Let', ' me', ' ground']) onToken(token);
      throw Object.assign(new Error("400 Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details."), { status: 400 });
    },
  }) as ModelClient;

  it('drops the streamed words, tells the breaker, and answers from the next model', async () => {
    const seen: string[] = [];
    const failures: string[] = [];
    const result = await complete(messages, { onToken: (token) => seen.push(token), onRestart: () => seen.push('<restart>') },
      [breaking('groq-qwen'), client('openrouter', ['A', ' whole', ' answer.'])], ({ client: failed }) => failures.push(failed.name));
    expect(result).toMatchObject({ text: 'A whole answer.', calls: [] });
    expect(result.client.name).toBe('openrouter');
    expect(result.cut).toBeUndefined();
    expect(failures).toEqual(['groq-qwen']);
    expect(seen).toEqual(['Let', ' me', ' ground', '<restart>', 'A', ' whole', ' answer.']);
  });

  it('shows the cut words again, marked as broken off, only when every model fails', async () => {
    const seen: string[] = [];
    const failures: string[] = [];
    const result = await complete(messages, { onToken: (token) => seen.push(token), onRestart: () => seen.push('<restart>') },
      [breaking('groq-qwen'), client('openrouter', new Error('503 overloaded'))], ({ client: failed }) => failures.push(failed.name));
    expect(result).toMatchObject({ text: 'Let me ground', cut: true, calls: [] });
    expect(result.client.name).toBe('groq-qwen');
    expect(result.broke).toMatch(/tool call/);
    expect(failures).toEqual(['groq-qwen', 'openrouter']);
    expect(seen.join('')).toBe('Let me ground<restart>Let me ground');
  });

  it('keeps the words where they stand when no other model is tried', async () => {
    const seen: string[] = [];
    const result = await complete(messages, { onToken: (token) => seen.push(token), onRestart: () => seen.push('<restart>') }, [breaking('groq-qwen')]);
    expect(result).toMatchObject({ text: 'Let me ground', cut: true });
    expect(seen).toEqual(['Let', ' me', ' ground']);
  });
});

describe('a model that says nothing for too long', () => {
  it('is given up on at the first-word timeout, so the next model answers', async () => {
    const [gemini] = realClients({ GEMINI_API_KEY: 'g', STAGE_FIRST_TOKEN_MS: '40' } as NodeJS.ProcessEnv);
    let aborted = false;
    (gemini.openai!.chat.completions as unknown as { create: unknown }).create = (_body: unknown, { signal }: { signal: AbortSignal }) => ({
      withResponse: () => new Promise((_done, fail) => signal.addEventListener('abort', () => { aborted = true; fail(new Error('Request was aborted.')); }, { once: true })),
    });
    const failures: string[] = [];
    const started = Date.now();
    const result = await complete(messages, { onToken: () => {} }, [gemini, client('groq', ['here'])], ({ client: failed, error }) => failures.push(`${failed.name}: ${error.message}`));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(aborted).toBe(true);
    expect(result.client.name).toBe('groq');
    expect(failures[0]).toMatch(/^gemini.*no first word/);
  });

  it('is not given up on once the words have started', async () => {
    const [gemini] = realClients({ GEMINI_API_KEY: 'g', STAGE_FIRST_TOKEN_MS: '40' } as NodeJS.ProcessEnv);
    async function* chunks() {
      yield { choices: [{ delta: { content: 'slow' } }] };
      await new Promise((resolve) => setTimeout(resolve, 120));
      yield { choices: [{ delta: { content: ' but whole' } }] };
    }
    (gemini.openai!.chat.completions as unknown as { create: unknown }).create = () => ({ withResponse: async () => ({ data: chunks(), response: { headers: new Headers() } }) });
    const result = await complete(messages, { onToken: () => {} }, [gemini]);
    expect(result.text).toBe('slow but whole');
  });
});

describe('complete, with tools', () => {
  it('accepts a step that only calls tools, and skips a model without tool support', async () => {
    const mute: ModelClient = { ...client('mute', ['hi']), tools: false };
    const caller: ModelClient = { ...client('caller', []), async step() { return { text: '', calls: [{ id: '1', name: 'x', args: '{}' }] }; } };
    const result = await complete(messages, { onToken: () => {}, tools: [{ name: 'x', description: '', parameters: {} }] }, [mute, caller]);
    expect(result.client.name).toBe('caller');
    expect(result.calls).toHaveLength(1);
  });

  it('sends no tools and no tool choice at all when none are offered, and the tools when they are', async () => {
    const [groq] = realClients({ GROQ_API_KEY: 'k' } as NodeJS.ProcessEnv);
    const sent: Record<string, unknown>[] = [];
    async function* chunks() { yield { choices: [{ delta: { content: 'fine' } }] }; }
    (groq.openai!.chat.completions as unknown as { create: unknown }).create = (body: Record<string, unknown>) => {
      sent.push(body);
      return { withResponse: async () => ({ data: chunks(), response: { headers: new Headers() } }) };
    };
    await groq.step(messages, { onToken: () => {}, tools: [] });
    await groq.step(messages, { onToken: () => {} });
    for (const body of sent) { expect('tools' in body).toBe(false); expect('tool_choice' in body).toBe(false); }
    await groq.step(messages, { onToken: () => {}, tools: [{ name: 'x', description: '', parameters: {} }] });
    expect(sent[2].tools).toHaveLength(1);
    expect('tool_choice' in sent[2]).toBe(false);
  });

  it('asks the same model once more when it called a tool nobody offered it', async () => {
    let tries = 0;
    const slip: ModelClient = {
      ...client('groq', []),
      async step(_messages, { onToken }) {
        tries += 1;
        if (tries === 1) throw new Error('400 Tool choice is none, but model called a tool');
        onToken('In words.');
        return { text: '', calls: [] };
      },
    };
    const result = await complete(messages, { onToken: () => {}, tools: [] }, [slip, client('gemini', ['other'])]);
    expect(result.client.name).toBe('groq');
    expect(result.text).toBe('In words.');
    expect(tries).toBe(2);
  });

  it('reads rate-limit headers when a provider sends them', () => {
    expect(readQuota(new Headers({ 'x-ratelimit-remaining-requests': '998', 'x-ratelimit-limit-requests': '1000' }))).toMatchObject({ remainingRequests: 998, limitRequests: 1000 });
    expect(readQuota(new Headers())).toBeUndefined();
  });
});

describe('collectCalls', () => {
  it('joins numbered pieces of the same call', () => {
    const calls: ToolCall[] = [];
    collectCalls(calls, [{ index: 0, id: 'a', function: { name: 'write_doc', arguments: '{"doc":' } }]);
    collectCalls(calls, [{ index: 0, function: { arguments: '"Brand"}' } }, { index: 1, id: 'b', function: { name: 'list_files', arguments: '{}' } }]);
    expect(calls).toEqual([{ id: 'a', name: 'write_doc', args: '{"doc":"Brand"}' }, { id: 'b', name: 'list_files', args: '{}' }]);
  });

  it('takes whole, unnumbered calls the way Gemini sends them, and keeps the signature it must get back', () => {
    const calls: ToolCall[] = [];
    collectCalls(calls, [{ id: 'x', function: { name: 'list_files', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig' } } }]);
    collectCalls(calls, [{ id: 'y', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }]);
    expect(calls.map((call) => call.id)).toEqual(['x', 'y']);
    expect(calls[0].extra).toEqual({ google: { thought_signature: 'sig' } });
  });
});

describe('changing provider half way through a turn', () => {
  const history = [
    { role: 'user' as const, content: 'go' },
    { role: 'assistant' as const, content: '', tool_calls: [
      { id: 'a', type: 'function' as const, function: { name: 'x', arguments: '{}' } },
      { id: 'b', type: 'function' as const, function: { name: 'y', arguments: '{}' }, extra_content: { google: { thought_signature: 'real' } } },
    ] },
  ];

  it('gives Gemini a stand-in signature only where a real one is missing', () => {
    const [, assistant] = portable(history, 'stand-in') as typeof history;
    expect(assistant.tool_calls!.map((call) => (call as { extra_content?: any }).extra_content.google.thought_signature)).toEqual(['stand-in', 'real']);
  });

  it('strips Google extras for everyone else', () => {
    const [, assistant] = portable(history) as typeof history;
    expect(assistant.tool_calls!.every((call) => !('extra_content' in call))).toBe(true);
  });

  it('waits out a short per-minute limit once, then answers from the same model', async () => {
    let tries = 0;
    const limited: ModelClient = { ...client('groq', []), async step(_messages, { onToken }) {
      tries += 1;
      if (tries === 1) throw Object.assign(new Error('429'), { status: 429, headers: new Headers({ 'retry-after': '0.05' }) });
      onToken('ok');
      return { text: '', calls: [] };
    } };
    const result = await complete(messages, { onToken: () => {} }, [limited, client('other', ['no'])]);
    expect(result.client.name).toBe('groq');
    expect(tries).toBe(2);
  });
});

describe('wireTools', () => {
  it('sends a provider nothing but name, description and parameters', () => {
    const tool = { name: 'web_search', description: 'Search', parameters: { type: 'object' }, perTurn: 3, approval: true, run: async () => ({ text: '' }) };
    expect(wireTools([tool])).toEqual([{ type: 'function', function: { name: 'web_search', description: 'Search', parameters: { type: 'object' } } }]);
  });
});

describe('naming a tool call', () => {
  it('never gives two calls the same name, whoever made them and however alike they are', async () => {
    const { callId, fakeClient } = await import('./providers.ts');
    expect(new Set(Array.from({ length: 500 }, callId)).size).toBe(500);
    // Two people, the same length of conversation, the same tool: the case that made one approval out of two.
    const ask = [{ role: 'system' as const, content: 'You are Maya, Marketing.' }, { role: 'user' as const, content: '/tool list_files {}' }];
    const tools = [{ name: 'list_files', description: 'list', parameters: { type: 'object', properties: {} } }];
    const [one, two] = await Promise.all([fakeClient.step(ask, { tools, onToken: () => {} }), fakeClient.step(ask, { tools, onToken: () => {} })]);
    expect(one.calls).toHaveLength(1);
    expect(one.calls[0].id).not.toBe(two.calls[0].id);
  });
});

describe('the free providers set up here', () => {
  it('fills a name in an address from the environment, and gives no address when it is not set', () => {
    const address = 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1';
    expect(expand(address, { CLOUDFLARE_ACCOUNT_ID: 'abc123' })).toBe('https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1');
    expect(expand(address, {})).toBeUndefined();
    expect(expand(address, { CLOUDFLARE_ACCOUNT_ID: '  ' })).toBeUndefined();
    expect(expand('https://api.groq.com/openai/v1', {})).toBe('https://api.groq.com/openai/v1');
    expect(unset({ keyEnv: 'CLOUDFLARE_API_TOKEN', baseURL: address }, { CLOUDFLARE_API_TOKEN: 't' })).toEqual(['CLOUDFLARE_ACCOUNT_ID']);
  });

  it('leaves out, quietly, a provider whose key or account id is missing', () => {
    const names = (env: Record<string, string>) => realClients(env as NodeJS.ProcessEnv).map((one) => one.name);
    expect(names({ CLOUDFLARE_API_TOKEN: 't' })).toEqual([]);
    expect(names({ CLOUDFLARE_ACCOUNT_ID: 'abc' })).toEqual([]);
    const cloudflare = realClients({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'abc' } as NodeJS.ProcessEnv).find((one) => one.name === 'cloudflare')!;
    expect(cloudflare.model).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
    expect(cloudflare.openai!.baseURL).toBe('https://api.cloudflare.com/client/v4/accounts/abc/ai/v1');
    // Cerebras counts each model apart, so its key makes two clients with a day's worth each.
    expect(names({ CEREBRAS_API_KEY: 'c' })).toEqual(['cerebras', 'cerebras-qwen']);
  });

  it('never has two requests out on a key that takes one at a time, and passes it over while it is busy', async () => {
    const [zai] = realClients({ ZAI_API_KEY: 'z' } as NodeJS.ProcessEnv);
    expect(zai).toMatchObject({ name: 'zai-flash', concurrency: 1 });
    let release = () => {};
    const held = new Promise<void>((done) => { release = done; });
    let sent = 0;
    async function* chunks() { await held; yield { choices: [{ delta: { content: 'done' } }] }; }
    (zai.openai!.chat.completions as unknown as { create: unknown }).create = () => { sent += 1; return { withResponse: async () => ({ data: chunks(), response: { headers: new Headers() } }) }; };
    const first = complete(messages, { onToken: () => {} }, [zai]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(zai.busy!()).toBe(true);
    // A second caller goes to the next model; the busy one is not asked at all.
    const second = await complete(messages, { onToken: () => {} }, [zai, client('next', ['from next'])]);
    expect(second.client.name).toBe('next');
    await expect(zai.step(messages, { onToken: () => {} })).rejects.toThrow(/already answering/);
    expect(sent).toBe(1);
    release();
    expect((await first).text).toBe('done');
    expect(zai.busy!()).toBe(false);
    expect((await complete(messages, { onToken: () => {} }, [zai])).client.name).toBe('zai-flash');
    expect(sent).toBe(2);
  });
});

describe('a failure in plain words', () => {
  it('says what each model did, never the raw provider text', () => {
    expect(plainFailure("no provider answered — gemini: Request timed out.; groq-qwen: 400 Failed to call a function. See 'failed_generation'.; groq: 429 Too Many Requests; openrouter: prompt too large"))
      .toBe('gemini timed out, groq-qwen tool call came out malformed, groq busy, openrouter prompt too large');
  });
});

describe('the fallback that broke a room (journey 6)', () => {
  const tool = [{ name: 'propose_bet', description: 'Propose a bet.', parameters: {} }];
  const failing = (name: string, message: string, status: number): ModelClient => ({ ...client(name, []), async step() { throw Object.assign(new Error(message), { status }); } });
  const GEMINI_400 = '400 [{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}]';
  const GROQ_413 = '413 Request too large for model `qwen/qwen3.8-27b` in organization `org_01m24v86abcdef` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 9120, please reduce your message size and try again.';

  it('keeps a local model off a turn with tools while a hosted one is set up, and says no model could answer', async () => {
    let asked = 0;
    const ollama: ModelClient = { ...client('ollama', ['我']), local: true, async step(_messages, { onToken }) { asked += 1; onToken('hi'); return { text: '', calls: [] }; } };
    await expect(complete(messages, { onToken: () => {}, tools: tool }, [failing('gemini', GEMINI_400, 400), ollama])).rejects.toThrow(/no provider answered/);
    expect(asked).toBe(0);
    // Without tools, or when it is the only model there is, it still answers.
    expect((await complete(messages, { onToken: () => {} }, [failing('gemini', GEMINI_400, 400), ollama])).client.name).toBe('ollama');
    expect((await complete(messages, { onToken: () => {}, tools: tool }, [ollama])).client.name).toBe('ollama');
  });

  it('keeps a local model the founder pinned, first in the order, on a turn with tools', async () => {
    const ollama: ModelClient = { ...client('ollama', ['from ollama']), local: true };
    expect((await complete(messages, { onToken: () => {}, tools: tool }, [ollama, client('gemini', ['from gemini'])])).client.name).toBe('ollama');
    // Behind a hosted model it is still kept off.
    await expect(complete(messages, { onToken: () => {}, tools: tool }, [failing('gemini', GEMINI_400, 400), ollama])).rejects.toThrow(/ollama: kept off turns with tools/);
  });

  it('says an HTML error page and a refused key by their kind, with no tags, key or address', () => {
    const page = '500 <!DOCTYPE html><html><head><title>Error</title><style>body{color:red}</style></head><body><h1>Internal Server Error</h1><p>Ray ID: 8a1b2c</p></body></html>';
    expect(plainBreak(page, 'cloudflare')).toBe('down');
    const key = '401 Incorrect API key provided: gsk_abcd****************wxyz. You can find your API key at https://console.groq.com/keys.';
    expect(plainBreak(key, 'groq')).toBe('refused the key');
    expect(scrubProvider(page)).not.toMatch(/[<>]|DOCTYPE/);
    expect(scrubProvider(key)).not.toMatch(/gsk_|https?:|console\./);
  });

  it('says the journey\'s two errors in words, with no JSON and no organisation id', () => {
    expect(plainBreak(GEMINI_400, 'gemini')).toBe('the model rejected the request');
    expect(plainBreak(GROQ_413, 'groq')).toBe('the prompt is too large for groq');
    const plain = plainFailure(`no provider answered — gemini: ${GEMINI_400}; groq-qwen: ${GROQ_413}`);
    expect(plain).toBe('gemini rejected the request, groq-qwen prompt too large');
    expect(scrubProvider('502 upstream for org_01m24v86abcdef, request req_9f8e7d: {"error":"bad"}')).not.toMatch(/org_|req_|\{/);
  });

  it('cuts the oldest history to fit a small model and keeps the tools, rather than refusing the turn', async () => {
    const long: typeof messages = [{ role: 'system', content: 'You are Sam.' } as never,
      ...Array.from({ length: 30 }, (_, n) => ({ role: (n % 2 ? 'assistant' : 'user') as 'user', content: `old message ${n} ${'x'.repeat(400)}` })),
      { role: 'user', content: 'what now?' }];
    let seen: { count: number; last: string; tools: number } | undefined;
    const groq: ModelClient = { ...client('groq', []), maxPromptChars: 6000, async step(sent, { onToken, tools }) { seen = { count: sent.length, last: String(sent.at(-1)!.content), tools: tools?.length ?? 0 }; onToken('ok'); return { text: '', calls: [] }; } };
    const result = await complete(long, { onToken: () => {}, tools: tool }, [groq]);
    expect(result.client.name).toBe('groq');
    expect(seen!.count).toBeLessThan(long.length);
    expect(seen!.last).toBe('what now?');
    expect(seen!.tools).toBe(1);
  });

  it('asks a model that answers 413 once more with the history cut harder', async () => {
    const long = [{ role: 'system' as const, content: 'You are Sam.' }, ...Array.from({ length: 10 }, (_, n) => ({ role: 'user' as const, content: `old ${n} ${'x'.repeat(300)}` })), { role: 'user' as const, content: 'now' }];
    const sizes: number[] = [];
    const groq: ModelClient = { ...client('groq', []), async step(sent, { onToken }) { sizes.push(sent.length); if (sizes.length === 1) throw Object.assign(new Error(GROQ_413), { status: 413 }); onToken('fits'); return { text: '', calls: [] }; } };
    expect((await complete(long, { onToken: () => {} }, [groq])).text).toBe('fits');
    expect(sizes[1]).toBeLessThan(sizes[0]);
  });

  it('fits a history without leaving a tool result whose call was cut', () => {
    const history = [
      { role: 'system' as const, content: 's' },
      { role: 'assistant' as const, content: 'x'.repeat(50), tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'a', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'c1', content: 'y'.repeat(50) },
      { role: 'user' as const, content: 'now' },
    ];
    expect(fitHistory(history, 20)?.map((one) => one.role)).toEqual(['system', 'user']);
  });
});

describe('the last model that can take a turn', () => {
  const slow = (env: Record<string, string>) => {
    const [gemini] = realClients({ GEMINI_API_KEY: 'g', STAGE_FIRST_TOKEN_MS: '40', ...env } as NodeJS.ProcessEnv);
    async function* chunks() {
      await new Promise((resolve) => setTimeout(resolve, 150));
      yield { choices: [{ delta: { content: 'slow but right' } }] };
    }
    (gemini.openai!.chat.completions as unknown as { create: unknown }).create = (_body: unknown, { signal }: { signal: AbortSignal }) => ({
      withResponse: async () => {
        // The first chunk is the first word: it comes after 150 ms, or the request is aborted first.
        await new Promise<void>((done, fail) => { const timer = setTimeout(done, 150); signal.addEventListener('abort', () => { clearTimeout(timer); fail(new Error('Request was aborted.')); }, { once: true }); });
        return { data: chunks(), response: { headers: new Headers() } };
      },
    });
    return gemini;
  };

  it('is waited for past the first-word clock when nobody is behind it', async () => {
    const tooSmall: ModelClient = { ...client('groq', ['never']), maxPromptChars: 1 };
    const result = await complete(messages, { onToken: () => {} }, [slow({}), tooSmall]);
    expect(result.text).toBe('slow but right');
  });

  it('is still cut at the clock when another model can answer', async () => {
    const result = await complete(messages, { onToken: () => {} }, [slow({}), client('groq', ['from groq'])]);
    expect(result.client.name).toBe('groq');
  });

  it('says a local model kept off a tool turn as that, not as a failure', () => {
    expect(plainFailure('no provider answered — gemini: 503 overloaded; ollama: kept off turns with tools')).toBe('gemini down, ollama kept off turns with tools');
  });

  it('names the models passed over because the prompt would not fit them', async () => {
    const result = await complete(messages, { onToken: () => {} }, [{ ...client('groq', ['x']), maxPromptChars: 1 }, client('gemini', ['here'])]);
    expect(result).toMatchObject({ client: { name: 'gemini' }, oversize: ['groq'] });
  });
});

describe('the second hosted model on the Cloudflare key (round 5)', () => {
  const env = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'abc' } as NodeJS.ProcessEnv;

  it('makes gpt-oss and Qwen from the one key, with Scout kept last', () => {
    const clients = realClients(env);
    expect(clients.map((one) => one.name)).toEqual(['cloudflare-gpt-oss', 'cloudflare-qwen', 'cloudflare']);
    expect(clients[0]).toMatchObject({ model: '@cf/openai/gpt-oss-120b', maxPromptChars: 100_000, tools: true, limits: { rpd: 25 } });
    expect(clients[1]).toMatchObject({ model: '@cf/qwen/qwen3.8-27b', maxPromptChars: 60_000, tools: true });
    expect(clients[2].model).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
  });

  it('never sends a tool-call message with its content as null, which Cloudflare refuses with a 400', async () => {
    const [oss] = realClients(env);
    const sent: { messages: { role: string; content: unknown; tool_calls?: unknown[] }[] }[] = [];
    async function* chunks() { yield { choices: [{ delta: { content: 'read it' } }] }; }
    (oss.openai!.chat.completions as unknown as { create: unknown }).create = (body: (typeof sent)[number]) => {
      sent.push(body);
      return { withResponse: async () => ({ data: chunks(), response: { headers: new Headers() } }) };
    };
    const history = [
      { role: 'user' as const, content: 'raise now?' },
      { role: 'assistant' as const, content: null as unknown as string, tool_calls: [{ id: 'a', type: 'function' as const, function: { name: 'read_doc', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'a', content: 'cash 9k' },
    ];
    const result = await complete(history, { onToken: () => {}, tools: [{ name: 'read_doc', description: '', parameters: {} }] }, [oss]);
    expect(result.text).toBe('read it');
    const call = sent[0].messages.find((message) => message.tool_calls);
    expect(call!.content).toBe('');
  });
});

describe('Groq on a turn with tools that is over its cap (round 5)', () => {
  const tools = [{ name: 'read_doc', description: '', parameters: {} }];
  const long = [{ role: 'user' as const, content: 'old '.repeat(3000) }, { role: 'assistant' as const, content: 'ok' }, { role: 'user' as const, content: 'raise now?' }];

  it('is passed over, not squeezed in with the history cut, while a model behind it holds the whole prompt', async () => {
    const result = await complete(long, { onToken: () => {}, tools }, [client('groq', ['cut short'], 5000), client('cloudflare-gpt-oss', ['whole'])]);
    expect(result).toMatchObject({ text: 'whole', client: { name: 'cloudflare-gpt-oss' }, oversize: ['groq'] });
  });

  it('still answers with the history cut when nobody else can, and on a turn without tools', async () => {
    expect((await complete(long, { onToken: () => {}, tools }, [client('groq', ['cut short'], 5000)])).text).toBe('cut short');
    expect((await complete(long, { onToken: () => {} }, [client('groq', ['words'], 5000), client('gemini', ['no'])])).text).toBe('words');
  });
});

describe('the Cloudflare models on the day\'s neuron pool', () => {
  it('marks gpt-oss, Qwen and Scout as sharing the pool with the pictures', () => {
    const clients = realClients({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'abc' } as NodeJS.ProcessEnv);
    expect(clients.map((one) => [one.name, !!one.sharedPool])).toEqual([['cloudflare-gpt-oss', true], ['cloudflare-qwen', true], ['cloudflare', true]]);
  });
});

describe('the long clock, said (round 5)', () => {
  it('adds how long the last model able was waited for to "said nothing for too long"', async () => {
    vi.useFakeTimers();
    try {
      const [gemini] = realClients({ GEMINI_API_KEY: 'g', STAGE_FIRST_TOKEN_MS: '40' } as NodeJS.ProcessEnv);
      (gemini.openai!.chat.completions as unknown as { create: unknown }).create = (_body: unknown, { signal }: { signal: AbortSignal }) => ({
        withResponse: () => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('Request was aborted.')), { once: true })),
      });
      const failed = complete(messages, { onToken: () => {} }, [gemini]).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(plainFailure((await failed as Error).message)).toBe('gemini said nothing for too long (waited 90 s: last model able)');
    } finally { vi.useRealTimers(); }
  });

  it('keeps the short line when the usual clock cut it', () => {
    expect(plainFailure('no provider answered — gemini: no first word within 20 s (timed out); cloudflare: 503')).toBe('gemini said nothing for too long, cloudflare down');
  });
});

describe('Groq over its cap, when the models behind it cannot answer after all (review 5)', () => {
  const tools = [{ name: 'read_doc', description: '', parameters: {} }];
  const long = [{ role: 'user' as const, content: 'old '.repeat(3000) }, { role: 'assistant' as const, content: 'ok' }, { role: 'user' as const, content: 'raise now?' }];

  it('cuts its history and answers when the one behind it is a local model kept off tool turns', async () => {
    const local: ModelClient = { ...client('ollama', ['never']), local: true };
    expect((await complete(long, { onToken: () => {}, tools }, [client('groq', ['cut short'], 5000), local])).text).toBe('cut short');
  });

  it('cuts its history and answers when the one behind it is busy', async () => {
    const busy: ModelClient = { ...client('cloudflare-gpt-oss', ['never']), busy: () => true };
    expect((await complete(long, { onToken: () => {}, tools }, [client('groq', ['cut short'], 5000), busy])).text).toBe('cut short');
  });

  it('cuts its history and answers when the one behind it is resting', async () => {
    const resting = (one: ModelClient) => one.name === 'cloudflare-gpt-oss';
    expect((await complete(long, { onToken: () => {}, tools }, [client('groq', ['cut short'], 5000), client('cloudflare-gpt-oss', ['never'])], () => {}, () => true, resting)).text).toBe('cut short');
  });
});

describe('Cloudflare\'s neurons, read from the answer (review 5)', () => {
  it('keeps the neurons a Cloudflare answer says it spent', async () => {
    const [oss] = realClients({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'abc' } as NodeJS.ProcessEnv);
    async function* chunks() {
      yield { choices: [{ delta: { content: 'fine' } }] };
      yield { choices: [], usage: { prompt_tokens: 6400, completion_tokens: 300, neurons: 236.4 } };
    }
    (oss.openai!.chat.completions as unknown as { create: unknown }).create = () => ({ withResponse: async () => ({ data: chunks(), response: { headers: new Headers() } }) });
    expect((await oss.step(messages, { onToken: () => {} })).usage).toEqual({ input: 6400, output: 300, neurons: 236.4 });
  });

  it('caps each Cloudflare model so the three together leave the pictures room, and puts all three on the pool', () => {
    const clients = realClients({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'abc' } as NodeJS.ProcessEnv);
    expect(clients.map((one) => [one.name, one.limits.rpd, !!one.sharedPool])).toEqual([['cloudflare-gpt-oss', 25, true], ['cloudflare-qwen', 5, true], ['cloudflare', 10, true]]);
  });
});

describe('NVIDIA and Mistral on their free tiers (round 6)', () => {
  const env = { NVIDIA_API_KEY: 'nvapi-x', MISTRAL_API_KEY: 'm' } as NodeJS.ProcessEnv;
  const room = [{ role: 'system' as const, content: `You are Sam.\n## Doc: Numbers\n${'Cash 9,000. Burn 1,800 a month. '.repeat(800).slice(0, 25_000)}` }, { role: 'user' as const, content: 'Raise now?' }];
  const tools = [{ name: 'read_doc', description: 'Read a doc', parameters: { type: 'object', properties: { title: { type: 'string' } } } }];
  type Body = { model: string; max_tokens: number; tools?: unknown[]; messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[] };
  const script = (one: ModelClient, answer: (body: Body) => unknown[]) => {
    const sent: Body[] = [];
    (one.openai!.chat.completions as unknown as { create: unknown }).create = (body: Body) => {
      sent.push(body);
      async function* chunks() { yield* answer(body); }
      return { withResponse: async () => ({ data: chunks(), response: { headers: new Headers() } }) };
    };
    return sent;
  };
  // What kimi-k3 sent in the live probe: the whole call at once, named by the tool and its place in the turn.
  const kimiCall = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read_doc:0', function: { name: 'read_doc', arguments: '{"title":"Numbers"}' } }] } }] }];

  it('asks NVIDIA for kimi-k3 (kimi-k2.6 is listed but not served to a free account) at 40 a minute, and Mistral small at one a second', () => {
    const clients = realClients(env);
    expect(clients.find((one) => one.name === 'nvidia')).toMatchObject({ model: 'moonshotai/kimi-k3', maxPromptChars: 100_000, tools: true, limits: { rpm: 40 } });
    expect(clients.find((one) => one.name === 'mistral')).toMatchObject({ model: 'mistral-small-latest', maxPromptChars: 100_000, tools: true, limits: { rpm: 60, tpm: 500_000 }, concurrency: 1 });
  });

  it('takes a 25k-character room prompt with a tool on NVIDIA, and gives its per-turn call name one no other call shares', async () => {
    const nvidia = realClients(env).find((one) => one.name === 'nvidia')!;
    const sent = script(nvidia, () => kimiCall);
    const first = await complete(room, { onToken: () => {}, tools }, [nvidia]);
    const second = await complete(room, { onToken: () => {}, tools }, [nvidia]);
    expect(sent[0]).toMatchObject({ model: 'moonshotai/kimi-k3', max_tokens: 4096, tools: [expect.objectContaining({ type: 'function' })] });
    expect(first.calls).toEqual([expect.objectContaining({ name: 'read_doc', args: '{"title":"Numbers"}', id: expect.stringMatching(/^call_[0-9a-f]{16}$/) })]);
    expect(second.calls[0].id).not.toBe(first.calls[0].id);
  });

  it('sends Mistral every tool call named in the nine letters and digits it insists on, the call and its result alike', async () => {
    const mistral = realClients(env).find((one) => one.name === 'mistral')!;
    const sent = script(mistral, () => [{ choices: [{ delta: { content: 'Do not raise yet.' } }] }]);
    const history = [
      ...room,
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'call_0123456789abcdef', type: 'function' as const, function: { name: 'read_doc', arguments: '{}' } }, { id: 'Ab3dE6gH9', type: 'function' as const, function: { name: 'read_doc', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'call_0123456789abcdef', content: 'cash 9k' },
      { role: 'tool' as const, tool_call_id: 'Ab3dE6gH9', content: 'burn 1.8k' },
    ];
    const result = await complete(history, { onToken: () => {}, tools }, [mistral]);
    expect(result.text).toBe('Do not raise yet.');
    const wire = sent[0].messages;
    const ids = wire.find((one) => one.tool_calls)!.tool_calls!.map((call) => call.id);
    expect(ids[0]).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(ids[1]).toBe('Ab3dE6gH9');
    expect(wire.filter((one) => one.role === 'tool').map((one) => one.tool_call_id)).toEqual(ids);
    // The conversation kept here is not touched: only what goes over the wire is renamed.
    expect((history[2] as { tool_calls: { id: string }[] }).tool_calls[0].id).toBe('call_0123456789abcdef');
  });

  it('never sends a second request to Mistral while one is out', async () => {
    const mistral = realClients(env).find((one) => one.name === 'mistral')!;
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    (mistral.openai!.chat.completions as unknown as { create: unknown }).create = () => ({
      withResponse: async () => { await gate; async function* chunks() { yield { choices: [{ delta: { content: 'ok' } }] }; } return { data: chunks(), response: { headers: new Headers() } }; },
    });
    const one = mistral.step(messages, { onToken: () => {} });
    expect(mistral.busy?.()).toBe(true);
    await expect(mistral.step(messages, { onToken: () => {} })).rejects.toThrow(/already answering/);
    release();
    await one;
  });
});
