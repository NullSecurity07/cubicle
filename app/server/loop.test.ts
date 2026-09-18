import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedStage, type ToolEvent } from '../shared/model.ts';
import { runTurn } from './loop.ts';
import type { ModelClient, ModelTurn } from './providers.ts';
import { createStore } from './store.ts';
import { docTools } from './tools/docs.ts';
import { fileTools } from './tools/files.ts';
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
