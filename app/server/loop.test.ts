import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolEvent } from '../shared/model.ts';
import { runTurn } from './loop.ts';
import type { ModelMessage } from './prompt.ts';
import type { ModelClient, ModelTurn } from './providers.ts';
import { createSeams, type Payloads, type Seams } from './seams.ts';
import { createStore } from './store.ts';
import { docTools } from './tools/docs.ts';
import { fileTools } from './tools/files.ts';
import type { Tool } from './tools/registry.ts';
import { createUsage } from './usage.ts';

// A model that plays back a script: each step is either words or tool calls.
const scripted = (steps: (string | { name: string; args: unknown }[])[]): ModelClient & { seen: number[] } => {
  const seen: number[] = [];
  return {
    name: 'script', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {}, seen,
    async step(messages, { onToken, tools }): Promise<ModelTurn> {
      seen.push(tools?.length ?? 0);
      const next = steps.shift() ?? 'done';
      if (typeof next === 'string') { onToken(next); return { text: '', calls: [], usage: { input: messages.length, output: 1 } }; }
      return { text: '', calls: next.map((call, index) => ({ id: `c${seen.length}-${index}`, name: call.name, args: JSON.stringify(call.args) })), usage: { input: 1, output: 1 } };
    },
  };
};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'loop-'));
  const store = createStore(dir);
  const stage = await store.loadStage();
  const events: ToolEvent[] = [];
  let said = '';
  const run = (client: ModelClient, roomId = 'marketing', signal?: AbortSignal) => runTurn({
    messages: [{ role: 'user', content: 'go' }], tools: [...docTools, ...fileTools], clients: [client], usage: createUsage(null), signal,
    context: { stage, roomId, store, granted: new Map() },
    events: { token: (token) => { said += token; }, tool: (event) => events.push(event) },
  });
  return { dir, store, events, run, said: () => said };
}

describe('runTurn', () => {
  it('runs a tool, hands the result back and ends in words', async () => {
    const { dir, store, events, run } = await setup();
    const result = await run(scripted([[{ name: 'write_doc', args: { doc: 'Brand doc', text: '# New brand' } }], 'Rewrote the brand doc.']));
    expect(await store.readDoc('brand-doc')).toBe('# New brand');
    expect(result.text).toBe('Rewrote the brand doc.');
    expect(result.tools).toMatchObject([{ name: 'write_doc', ok: true, effect: { kind: 'doc-changed', id: 'brand-doc' } }]);
    expect(events.map((event) => event.ok)).toEqual([undefined, true]);
    expect(result.usage).toEqual({ input: 3 + 1, output: 2 });
    const trash = await readdir(join(dir, 'trash'));
    expect(trash).toHaveLength(1);
    expect(await readFile(join(dir, 'trash', trash[0]), 'utf8')).toContain('What we are building');
  });

  it('refuses a doc that is not wired to the person, and tells the model why', async () => {
    const { store, run } = await setup();
    const result = await run(scripted([[{ name: 'write_doc', args: { doc: 'Brand doc', text: 'x' } }], 'I cannot reach it.']), 'build');
    expect(result.tools[0]).toMatchObject({ ok: false });
    expect(result.tools[0].result).toMatch(/no connected document/);
    expect(await store.readDoc('brand-doc')).toContain('What we are building');
  });

  it('lets a person write to a doc they created in the same turn', async () => {
    const { store, run } = await setup();
    const result = await run(scripted([[{ name: 'create_doc', args: { title: 'Launch plan', text: 'v1' } }], [{ name: 'append_doc', args: { doc: 'Launch plan', text: 'v2' } }], 'Done.']), 'build');
    const created = result.tools[0].effect;
    expect(created).toMatchObject({ kind: 'doc-created', title: 'Launch plan' });
    expect(await store.readDoc(created!.id)).toBe('v1\n\nv2\n');
  });

  it('keeps shared files inside their folder', async () => {
    const { run } = await setup();
    const result = await run(scripted([[{ name: 'write_file', args: { path: '../stage.json', text: 'x' } }, { name: 'write_file', args: { path: 'notes/a.md', text: 'hello' } }, { name: 'list_files', args: {} }], 'ok']));
    expect(result.tools.map((tool) => tool.ok)).toEqual([false, true, true]);
    expect(result.tools[2].result).toBe('notes/a.md');
  });

  it('caps a costly tool per turn and tells the person to move on', async () => {
    const { run } = await setup();
    const { webTools } = await import('./tools/web.ts');
    const { createBrowser, fakeRunner } = await import('./browser.ts');
    const search = webTools(createBrowser(fakeRunner))[0];
    const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
    const result = await runTurn({
      messages: [{ role: 'user', content: 'go' }], tools: [search], usage: createUsage(null),
      clients: [scripted([...Array.from({ length: 4 }, () => [{ name: 'web_search', args: { queries: ['x'] } }]), 'enough'])],
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
      events: { token: () => {}, tool: () => {} },
    });
    expect(result.tools.map((tool) => tool.ok)).toEqual([true, true, true, false]);
    expect(result.tools[3].result).toMatch(/already ran 3 times/);
    void run;
  });

  it('reports bad arguments and unknown tools instead of throwing', async () => {
    const { run } = await setup();
    const result = await run(scripted([[{ name: 'fly', args: {} }, { name: 'write_doc', args: { doc: 'Brand doc' } }], 'hm']));
    expect(result.tools.map((tool) => tool.result)).toEqual(['Failed: no such tool: fly', 'Failed: "text" is missing']);
  });

  it('offers no tools on the last step, so a turn always ends', async () => {
    const { run } = await setup();
    const client = scripted(Array.from({ length: 7 }, () => [{ name: 'list_files', args: {} }]));
    const result = await run(client);
    expect(client.seen).toHaveLength(8);
    expect(client.seen.at(-1)).toBe(0);
    expect(result.text).toBe('done');
  });

  it('tells the founder when another model had to step in', async () => {
    const { run } = await setup();
    const notices: string[] = [];
    const broken: ModelClient = { ...scripted([]), name: 'gemini', async step() { throw Object.assign(new Error('Too Many Requests'), { status: 429 }); } };
    const usage = createUsage(null);
    const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
    const result = await runTurn({
      messages: [{ role: 'user', content: 'go' }], tools: [], clients: [broken, scripted(['hello'])], usage,
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
      events: { token: () => {}, tool: () => {}, notice: (text) => notices.push(text) },
    });
    expect(result.provider).toBe('script');
    expect(notices).toEqual(['gemini could not answer (free limit reached), so script answers.']);
    expect(usage.hot(broken, 10)).toBe(true);
    void run;
  });

  it('tells the founder when a reply was cut at the model\'s length limit', async () => {
    const short: ModelClient = { ...scripted([]), name: 'short', async step(_messages, { onToken }) { onToken('The plan has three par'); return { text: '', calls: [], cut: true }; } };
    const notices: string[] = [];
    const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
    const reply = await runTurn({
      messages: [{ role: 'user', content: 'plan' }], tools: [], clients: [short], usage: createUsage(null),
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
      events: { token: () => {}, tool: () => {}, notice: (text) => notices.push(text) },
    });
    expect(reply.text).toBe('The plan has three par');
    expect(notices.join(' ')).toMatch(/length limit/);
  });

  it('stops between steps when the founder stops it, keeping what was said', async () => {
    const { run } = await setup();
    const stop = new AbortController();
    const client = scripted([[{ name: 'list_files', args: {} }], 'never']);
    const original = client.step;
    client.step = async (messages, options) => { const turn = await original(messages, options); stop.abort(); return turn; };
    const result = await run(client, 'marketing', stop.signal);
    expect(result.stopped).toBe(true);
    expect(result.tools).toHaveLength(0);
  });
});

// A tool that says what it was called with, so a rewrite on the way in or out can be seen.
const echo = (approval?: Tool['approval']): Tool & { ran: Record<string, unknown>[] } => {
  const ran: Record<string, unknown>[] = [];
  return {
    name: 'echo', description: 'says its arguments back', parameters: { type: 'object', properties: { say: { type: 'string' } } }, ran,
    ...(approval === undefined ? {} : { approval }),
    async run(args) { ran.push(args); return { text: `echo: ${JSON.stringify(args)}` }; },
  };
};

// Everything the model was given, turn by turn, beside the turn it produced.
const listening = (client: ModelClient & { seen: number[] }) => {
  const heard: ModelMessage[][] = [];
  const original = client.step;
  client.step = async (messages, options) => { heard.push(structuredClone(messages)); return original(messages, options); };
  return heard;
};

describe('runTurn with seams', () => {
  async function go(client: ModelClient, seams: Seams, extra: { tools?: Tool[]; source?: 'chat' | 'run'; query?: string; approve?: Parameters<typeof runTurn>[0]['approve'] } = {}) {
    const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
    const events: ToolEvent[] = [];
    const reply = await runTurn({
      messages: [{ role: 'user', content: 'go' }], tools: extra.tools ?? [], clients: [client], usage: createUsage(null),
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
      events: { token: () => {}, tool: (event) => events.push(event) },
      seams, source: extra.source, query: extra.query, approve: extra.approve,
    });
    return { reply, events };
  }

  it('lets the prompt be rewritten before the first step, and opens every step after that', async () => {
    const seams = createSeams();
    seams.on('turn:before', async (payload, next) => next({ ...payload, messages: [...payload.messages, { role: 'user', content: `${payload.source} asked: ${payload.query}` }] }));
    const steps: number[] = [];
    seams.on('step:before', async (payload, next) => { steps.push(payload.step); return next(payload); });
    const client = scripted([[{ name: 'echo', args: { say: 'hi' } }], 'done']);
    const heard = listening(client);
    await go(client, seams, { tools: [echo()], source: 'run', query: 'write the launch note' });
    expect(heard[0].at(-1)!.content).toBe('run asked: write the launch note');
    expect(steps).toEqual([1, 2]);
  });

  it('refuses a call at the seam without asking the founder, and without running the tool', async () => {
    const seams = createSeams();
    seams.on('tool:before', async (payload, next) => next({ ...payload, refusal: 'Not that one.' }));
    const tool = echo(true);
    const asked: string[] = [];
    const { reply, events } = await go(scripted([[{ name: 'echo', args: { say: 'hi' } }], 'fine']), seams, {
      tools: [tool], approve: async (event) => { asked.push(event.name); return { ok: true }; },
    });
    expect(asked).toEqual([]);
    expect(tool.ran).toEqual([]);
    expect(reply.tools[0]).toMatchObject({ ok: false, result: 'Not that one.' });
    expect(events.some((event) => event.waiting)).toBe(false);
  });

  it('lets the arguments be rewritten before the tool sees them', async () => {
    const seams = createSeams();
    seams.on('tool:before', async (payload, next) => next({ ...payload, call: { ...payload.call, args: { say: 'rewritten' } } }));
    const tool = echo();
    const { reply } = await go(scripted([[{ name: 'echo', args: { say: 'hi' } }], 'fine']), seams, { tools: [tool] });
    expect(tool.ran).toEqual([{ say: 'rewritten' }]);
    expect(reply.tools[0].args).toEqual({ say: 'rewritten' });
  });

  it('lets the result be rewritten before the model and the founder see it', async () => {
    const seams = createSeams();
    seams.on('tool:after', async (payload, next) => next({ ...payload, event: { ...payload.event, result: 'trimmed to this' } }));
    const client = scripted([[{ name: 'echo', args: { say: 'hi' } }], 'fine']);
    const heard = listening(client);
    const { reply, events } = await go(client, seams, { tools: [echo()] });
    expect(reply.tools[0].result).toBe('trimmed to this');
    expect(events.at(-1)!.result).toBe('trimmed to this');
    expect(heard[1].at(-1)).toMatchObject({ role: 'tool', content: 'trimmed to this' });
  });

  it('tells what watches a finished turn afterwards, and waits for none of it', async () => {
    const seams = createSeams();
    let told: Payloads['turn:after'] | undefined;
    let settle = () => {};
    const done = new Promise<void>((resolve) => { settle = resolve; });
    seams.on('turn:after', async (payload, next) => { told = payload; settle(); return next(payload); });
    seams.on('turn:after', async () => new Promise(() => {}));
    const { reply } = await go(scripted(['all done']), seams, { source: 'run', query: 'the task' });
    expect(reply.text).toBe('all done');
    await done;
    expect(told).toMatchObject({ roomId: 'build', source: 'run', query: 'the task', reply: { text: 'all done' } });
  });

  it('hands the model the whole of a long result, and cuts only the receipt, keeping its end', async () => {
    const pages = Array.from({ length: 5 }, (_, at) => `Page ${at + 1}\n${'words '.repeat(1500)}`).join('\n\n');
    const long: Tool = { name: 'long', description: 'a five-page read', parameters: { type: 'object', properties: {} }, async run() { return { text: `${pages}\n\nSources: the fifth page` }; } };
    const client = scripted([[{ name: 'long', args: {} }], 'read it']);
    const heard = listening(client);
    const { reply } = await go(client, createSeams(), { tools: [long] });
    expect(heard[1].at(-1)).toMatchObject({ role: 'tool', content: `${pages}\n\nSources: the fifth page` });
    expect(reply.tools[0].result!.length).toBeLessThanOrEqual(6000);
    expect(reply.tools[0].result).toMatch(/^Page 1/);
    expect(reply.tools[0].result).toMatch(/… \(cut\) …\n\nSources: the fifth page$/);
  });

  it('holds a long result under the smallest model\'s share when nothing before the step made it smaller', async () => {
    const text = `${Array.from({ length: 400 }, (_, at) => `line ${at}`).join('\n')}\n\nError: the last line is the one that matters`;
    const long: Tool = { name: 'long', description: 'a long log', parameters: { type: 'object', properties: {} }, async run() { return { text }; } };
    const client = { ...scripted([[{ name: 'long', args: {} }], 'saw it']), maxPromptChars: 8000 };
    const heard: ModelMessage[][] = [];
    const step = client.step;
    client.step = async (messages, options) => { heard.push(structuredClone(messages)); return step(messages, options); };
    await go(client, createSeams(), { tools: [long] });
    const seen = heard[1].at(-1)!.content as string;
    expect(seen.length).toBeLessThanOrEqual(2000);
    expect(seen).toMatch(/^line 0\n/);
    expect(seen).toMatch(/Error: the last line is the one that matters$/);
  });

  it('takes an approval that fails as a no, and finishes the turn', async () => {
    const seams = createSeams();
    const tool = echo(true);
    const { reply } = await go(scripted([[{ name: 'echo', args: { say: 'hi' } }], 'I could not.']), seams, {
      tools: [tool], approve: async () => { throw new Error('the founder\'s window went away'); },
    });
    expect(tool.ran).toEqual([]);
    expect(reply.tools[0]).toMatchObject({ ok: false });
    expect(reply.tools[0].result).toMatch(/said no to this/);
    expect(reply.text).toBe('I could not.');
  });
});
