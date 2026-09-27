import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolEvent } from '../shared/model.ts';
import { FALLBACK_REFUSAL, runTurn, SAY_SOMETHING } from './loop.ts';
import { CALL_THE_TOOL, HELD_BACK } from './truth.ts';
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
    const result = await run(scripted([[{ name: 'write_doc', args: { doc: 'Brand doc', text: '# Brand\n\nWhat we are building: calm tools' } }], 'Rewrote the brand doc.']));
    expect(await store.readDoc('brand-doc')).toBe('# Brand\n\nWhat we are building: calm tools');
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
    expect(notices).toEqual(['gemini could not answer (busy for now), so script answers.']);
    expect(usage.hot(broken, 10)).toBe(true);
    void run;
  });

  it('drops a reply that broke part way, keeps the words of earlier steps, and answers from the next model', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
    const shown: string[] = [];
    const notices: string[] = [];
    let window = '';
    const usage = createUsage(null);
    // Step one: words and a tool call from the first model. Step two: three words, then Groq's 400.
    let steps = 0;
    const qwen: ModelClient = {
      ...scripted([]), name: 'groq-qwen',
      async step(_messages, { onToken }) {
        steps += 1;
        if (steps === 1) { onToken('Checking the files.'); return { text: '', calls: [{ id: 'c1', name: 'list_files', args: '{}' }] }; }
        for (const token of ['Let', ' me', ' ground']) onToken(token);
        throw Object.assign(new Error("400 Failed to call a function. See 'failed_generation'."), { status: 400 });
      },
    };
    const result = await runTurn({
      messages: [{ role: 'user', content: 'critique it' }], tools: fileTools, clients: [qwen, scripted(['The whole critique.'])], usage,
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
      events: {
        token: (token) => { window += token; shown.push(token); }, tool: () => {}, notice: (text) => notices.push(text),
        restart: () => { window = ''; shown.push('<restart>'); },
      },
    });
    expect(result.text).toBe('Checking the files.\n\nThe whole critique.');
    expect(result.provider).toBe('script');
    expect(window).toBe(result.text);
    expect(shown).toContain('<restart>');
    expect(result.text).not.toMatch(/failed_generation|cut short/);
    expect(notices.join(' ')).toMatch(/groq-qwen could not answer .*so script answers/);
  });

  it('keeps the broken words with a plain reason only when every model fails', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
    let window = '';
    const notices: string[] = [];
    const qwen: ModelClient = {
      ...scripted([]), name: 'groq-qwen',
      async step(_messages, { onToken }) {
        for (const token of ['Let', ' me', ' ground']) onToken(token);
        throw Object.assign(new Error("400 Failed to call a function. See 'failed_generation'."), { status: 400 });
      },
    };
    const down: ModelClient = { ...scripted([]), name: 'openrouter', async step() { throw Object.assign(new Error('503 overloaded'), { status: 503 }); } };
    const usage = createUsage(null);
    const recorded: string[] = [];
    const record = usage.record.bind(usage);
    usage.record = (name, ...rest) => { recorded.push(name); return record(name, ...rest); };
    const result = await runTurn({
      messages: [{ role: 'user', content: 'critique it' }], tools: [], clients: [qwen, down], usage,
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
      events: { token: (token) => { window += token; }, tool: () => {}, notice: (text) => notices.push(text), restart: () => { window = ''; } },
    });
    expect(result.text).toBe('Let me ground\n\n(reply cut short: its tool call came out malformed)');
    expect(window).toBe(result.text);
    expect(result.text).not.toMatch(/failed_generation/);
    expect(notices.join(' ')).not.toMatch(/so groq-qwen answers/);
    // Its failure was counted; it is not then counted as a good answer that would close its breaker again.
    expect(recorded).toEqual([]);
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

  describe('a turn that runs tools and then says nothing', () => {
    // A model that records what it was asked, and plays back a script where '' is an empty answer.
    const recording = (steps: (string | { name: string; args: unknown }[] | Error)[]) => {
      const asked: { tools: number; last: string }[] = [];
      const client: ModelClient = {
        name: 'script', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {},
        async step(messages, { onToken, tools }): Promise<ModelTurn> {
          asked.push({ tools: tools?.length ?? 0, last: String(messages.at(-1)?.content ?? '') });
          const next = steps.shift() ?? '';
          if (next instanceof Error) throw next;
          if (typeof next === 'string') { onToken(next); return { text: '', calls: [], usage: { input: 1, output: 1 } }; }
          return { text: '', calls: next.map((call, index) => ({ id: `c${asked.length}-${index}`, name: call.name, args: JSON.stringify(call.args) })), usage: { input: 1, output: 1 } };
        },
      };
      return { client, asked };
    };
    const listed = [{ name: 'list_files', args: {} }];

    it('asks once more with no tools, and the answer to that is the reply', async () => {
      const { run, said } = await setup();
      const { client, asked } = recording([listed, '', 'I found no files and need the founder to add the pricing sheet.']);
      const result = await run(client);
      expect(result.text).toBe('I found no files and need the founder to add the pricing sheet.');
      expect(said()).toBe(result.text);
      expect(asked.at(-1)).toEqual({ tools: 0, last: SAY_SOMETHING });
      expect(asked).toHaveLength(3);
    });

    it('builds the reply from the receipts when the second ask is empty too', async () => {
      const { run, said } = await setup();
      const { client, asked } = recording([[{ name: 'write_file', args: { path: 'notes/a.md', text: 'hello' } }, { name: 'read_file', args: { path: 'nope.md' } }], '', '']);
      const result = await run(client);
      expect(asked.filter((one) => one.last === SAY_SOMETHING)).toHaveLength(1);
      expect(result.text).toMatch(/^I ran these steps but gave no answer, so here is what they said:/);
      expect(result.text).toContain('- write file: worked. ');
      expect(result.text).toMatch(/- read file: failed\. Failed: /);
      expect(said()).toBe(result.text);
      expect(result.tools).toHaveLength(2);
    });

    it('goes straight to the receipts when no model can answer at all, and says why', async () => {
      const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
      const notices: string[] = [];
      const { client, asked } = recording([listed, Object.assign(new Error('Too Many Requests'), { status: 413 })]);
      const result = await runTurn({
        messages: [{ role: 'user', content: 'go' }], tools: [...fileTools], clients: [client], usage: createUsage(null),
        context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
        events: { token: () => {}, tool: () => {}, notice: (text) => notices.push(text) },
      });
      expect(asked).toHaveLength(2);
      expect(result.text).toMatch(/^No model could answer after these steps, so here is what they said:\n\n- list files: worked/);
      expect(notices.at(-1)).toMatch(/No model could answer after the tools ran \(no provider answered/);
    });

    it('still fails a turn that no model answered before any tool ran', async () => {
      const { run } = await setup();
      const { client } = recording(['']);
      await expect(run(client)).rejects.toThrow(/empty reply/);
    });

    it('leaves a turn that ended in words alone', async () => {
      const { run } = await setup();
      const { client, asked } = recording([listed, 'No files yet.']);
      expect((await run(client)).text).toBe('No files yet.');
      expect(asked.some((one) => one.last === SAY_SOMETHING)).toBe(false);
    });
  });
});

describe('runTurn, the truth net', () => {
  const turn = async (client: ModelClient, messages: ModelMessage[] = [{ role: 'user', content: 'go' }]) => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
    const notices: string[] = [];
    let said = '';
    const reply = await runTurn({
      messages, tools: [...fileTools], clients: [client], usage: createUsage(null),
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
      events: { token: (token) => { said += token; }, tool: () => {}, notice: (text) => notices.push(text) },
    });
    return { reply, notices, said };
  };
  // A model that records the last thing it was asked, then plays back a script.
  const recording = (steps: (string | { name: string; args: unknown }[] | ModelTurn)[]) => {
    const asked: string[] = [];
    const client: ModelClient = {
      ...scripted([]),
      async step(messages, { onToken }): Promise<ModelTurn> {
        asked.push(String(messages.at(-1)?.content ?? ''));
        const next = steps.shift() ?? 'done';
        if (typeof next === 'string') { onToken(next); return { text: '', calls: [] }; }
        if (!Array.isArray(next)) { onToken(next.text); return { ...next, text: '' }; }
        return { text: '', calls: next.map((call, index) => ({ id: `c${asked.length}-${index}`, name: call.name, args: JSON.stringify(call.args) })) };
      },
    };
    return { client, asked };
  };

  it('marks a save no tool made, keeps the words, and tells the window', async () => {
    const { reply, notices, said } = await turn(scripted(["Here is the update. I've saved it as january-update.md."]));
    expect(reply.text).toBe("Here is the update. I've saved it as january-update.md.\n\nUnconfirmed: this reply claims an action no tool confirmed (saved).");
    expect(said).toBe(reply.text);
    expect(notices.at(-1)).toMatch(/^Unconfirmed: /);
    expect(reply.flags).toEqual(['Unconfirmed: this reply claims an action no tool confirmed (saved).']);
  });

  it('lets a save stand when a write worked this turn', async () => {
    const { reply, notices } = await turn(scripted([[{ name: 'write_file', args: { path: 'plan.md', text: 'x' } }], 'I saved it as plan.md.']));
    expect(reply.text).toBe('I saved it as plan.md.');
    expect(notices).toEqual([]);
  });

  it('flags a figure nothing gave it, and not one quoted from a wired doc or a tool result', async () => {
    const wired: ModelMessage[] = [{ role: 'system', content: '## Doc: Numbers\nMRR $22,000, churn 2.3%' }, { role: 'user', content: 'how are we doing?' }];
    expect((await turn(scripted(['MRR is $22,000 and churn is 2.3%.']), wired)).reply.text).toBe('MRR is $22,000 and churn is 2.3%.');
    expect((await turn(scripted(['MRR is $22,000 and the price is $29.']), wired)).reply.text).toMatch(/\n\nUnsourced figures: \$29 \(not found/);
    // Put forward as a proposal, the same price is the person's suggestion, not a claim.
    expect((await turn(scripted(['MRR is $22,000 and we should charge $29.']), wired)).reply.text).toBe('MRR is $22,000 and we should charge $29.');
    const read = scripted([[{ name: 'write_file', args: { path: 'late.md', text: '34% pay late' } }], [{ name: 'read_file', args: { path: 'late.md' } }], 'The note says 34% pay late.']);
    expect((await turn(read)).reply.text).toBe('The note says 34% pay late.');
  });

  it('does not take a figure in the person\'s own brief as a source, only the founder\'s words and the documents', async () => {
    const prompt: ModelMessage[] = [
      { role: 'system', content: 'You are Sam, Partner. Push for churn under 2%.\n\nThe founder has connected these documents to your room. Treat them as what the founder wants you to know.\n\n## Doc: Numbers\nMRR $22,000' },
      { role: 'user', content: 'We have 40 customers.' },
    ];
    expect((await turn(scripted(['MRR is $22,000 over 40 customers, $550 each.']), prompt)).reply.text).toBe('MRR is $22,000 over 40 customers, $550 each.');
    expect((await turn(scripted(['Good churn is under 2% a month.']), prompt)).reply.text).toMatch(/\n\nUnsourced figures: 2% \(not found/);
  });

  it('asks once more when the tool call came back written as text, and keeps the leak out of the reply', async () => {
    const { client, asked } = recording(['<tool_call><function=ask_founder>\n<parameter=question>What price?</parameter></function></tool_call>', [{ name: 'list_files', args: {} }], 'No files yet.']);
    const { reply } = await turn(client);
    expect(asked[1]).toBe(CALL_THE_TOOL);
    expect(reply.tools.map((tool) => tool.name)).toEqual(['list_files']);
    expect(reply.text).toBe('No files yet.');
  });

  it('holds back a raw JSON call written twice, with a clean line instead', async () => {
    const json = '{"name": "ask_founder", "arguments": {"question": "What price?"}}';
    const { client, asked } = recording([json, json]);
    const { reply } = await turn(client);
    expect(asked).toHaveLength(2);
    expect(reply.text).toBe(HELD_BACK);
    expect(reply.text).not.toContain('ask_founder');
  });

  it('says a reply the stream broke off is cut short, and lists what the tools did', async () => {
    const { client } = recording([[{ name: 'list_files', args: {} }], { text: 'The plan has three par', calls: [], cut: true, broke: 'socket hang up' }]);
    const { reply } = await turn(client);
    expect(reply.text).toMatch(/^The plan has three par\n\n\(reply cut short: socket hang up\)\n\nThe reply broke off after these steps, so here is what they said:\n\n- list files: worked/);
  });

  it('says a reply cut short with no tools, without the length-limit notice', async () => {
    const { client } = recording([{ text: 'The plan has three par', calls: [], cut: true, broke: 'terminated' }]);
    const { reply, notices } = await turn(client);
    expect(reply.text).toBe('The plan has three par\n\n(reply cut short: terminated)');
    expect(notices.join(' ')).not.toMatch(/length limit/);
  });
});

describe('a turn whose model repeats a tool call id', () => {
  it('gives every call a name of its own before it is run, shown or paired', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
    const shown: string[] = [];
    let steps = 0;
    let second: ModelMessage[] = [];
    const qwen: ModelClient = {
      ...scripted([]), name: 'gemini',
      async step(messages, { onToken }) {
        steps += 1;
        if (steps === 1) return { text: '', calls: [0, 1, 2].map(() => ({ id: 'call_propose__0', name: 'list_files', args: '{}' })) };
        second = messages;
        onToken('Listed.');
        return { text: '', calls: [] };
      },
    };
    const result = await runTurn({
      messages: [{ role: 'user', content: 'go' }], tools: fileTools, clients: [qwen], usage: createUsage(null),
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
      events: { token: () => {}, tool: (event) => { if (event.ok !== undefined) shown.push(event.id); } },
    });
    expect(result.tools.map((tool) => tool.id)).toEqual(['call_propose__0', 'call_propose__0-1', 'call_propose__0-2']);
    expect(shown).toEqual(result.tools.map((tool) => tool.id));
    const asked = second.find((message) => message.role === 'assistant' && message.tool_calls)!;
    expect(asked.role === 'assistant' && asked.tool_calls!.map((call) => call.id)).toEqual(result.tools.map((tool) => tool.id));
    expect(second.filter((message) => message.role === 'tool').map((message) => message.role === 'tool' && message.tool_call_id)).toEqual(result.tools.map((tool) => tool.id));
  });

  it('lets a stand-in model make at most three calls that change something in a turn, reads not counted', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
    let steps = 0;
    const write = (n: number) => ({ id: `w${n}`, name: 'write_file', args: JSON.stringify({ path: `notes/${n}.md`, text: 'x' }) });
    const ollama: ModelClient = {
      ...scripted([]), name: 'ollama', local: true,
      async step(_messages, { onToken }) {
        steps += 1;
        // Three searches of the files, then five writes.
        if (steps === 1) return { text: '', calls: [...[0, 1, 2].map((n) => ({ id: `r${n}`, name: 'list_files', args: '{}' })), ...[0, 1, 2, 3, 4].map(write)] };
        onToken('Done.');
        return { text: '', calls: [] };
      },
    };
    const result = await runTurn({
      messages: [{ role: 'user', content: 'go' }], tools: fileTools, clients: [ollama], usage: createUsage(null),
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
      events: { token: () => {}, tool: () => {} },
    });
    expect(result.tools.map((tool) => tool.ok)).toEqual([true, true, true, true, true, true, false, false]);
    expect(result.tools[6].result).toBe(FALLBACK_REFUSAL);
  });
});

describe('a pinned model that cannot hold the prompt', () => {
  it('is said in one line when the next model answers instead', async () => {
    const store = createStore(await mkdtemp(join(tmpdir(), 'loop-')));
    const notices: string[] = [];
    const groq: ModelClient = { ...scripted(['never']), name: 'groq', maxPromptChars: 1 };
    const gemini: ModelClient = { ...scripted(['Here.']), name: 'gemini' };
    const result = await runTurn({
      messages: [{ role: 'user', content: 'where are we?' }], tools: [], clients: [groq, gemini], usage: createUsage(null),
      context: { stage: await store.loadStage(), roomId: 'build', store, granted: new Map() },
      events: { token: () => {}, tool: () => {}, notice: (text) => notices.push(text) },
    });
    expect(result.provider).toBe('gemini');
    expect(notices).toEqual(["groq cannot hold this room's prompt; gemini answers."]);
  });
});
