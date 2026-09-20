import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Stage, ToolEffect, ToolEvent } from '../../shared/model.ts';
import { runTurn } from '../loop.ts';
import type { ModelClient } from '../providers.ts';
import { createStore } from '../store.ts';
import type { Tool, ToolContext } from '../tools/registry.ts';
import { createUsage } from '../usage.ts';
import { delegationTools } from './delegate.ts';

// A model that plays back a script and writes down what it was offered each step.
const scripted = (steps: (string | { name: string; args: unknown }[])[]) => {
  const offered: string[][] = [];
  const client: ModelClient = {
    name: 'script', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {},
    async step(_messages, { onToken, tools }) {
      offered.push((tools ?? []).map((one) => one.name));
      const next = steps.shift() ?? 'done';
      if (typeof next === 'string') { onToken(next); return { text: '', calls: [], usage: { input: 1, output: 1 } }; }
      return { text: '', calls: next.map((call, index) => ({ id: `c${offered.length}-${index}`, name: call.name, args: JSON.stringify(call.args) })), usage: { input: 1, output: 1 } };
    },
  };
  return { client, offered };
};

// One that says nothing at all until it is stopped, which is what being stuck looks like from here.
const naps = (): ModelClient => ({
  name: 'nap', model: 'n-1', maxPromptChars: Infinity, tools: true, limits: {},
  step: (_messages, { signal }) => new Promise((_done, fail) => signal?.addEventListener('abort', () => fail(new Error('aborted')), { once: true })),
});

const handover = (extra: Record<string, unknown> = {}) => JSON.stringify({ done: true, summary: 'Wrote it up.', changed: ['Brand doc'], ...extra });

async function setup(colleague: ModelClient, options: { busy?: Set<string>; wired?: boolean; stallMs?: number; theirs?: Tool[] } = {}) {
  const store = createStore(await mkdtemp(join(tmpdir(), 'delegate-')));
  const stage = await store.loadStage();
  if (options.wired !== false) stage.wires.push({ id: 'w', from: 'marketing', fromHandle: 'b', to: 'build', toHandle: 't' });
  const busy = options.busy ?? new Set<string>();
  const seen: string[][] = [];
  const theirs = options.theirs ?? [{ name: 'look', description: 'look', parameters: {}, async run() { return { text: `busy while working: ${busy.has('build')}` }; } } as Tool];
  const tools = delegationTools({
    store, clients: [colleague], usage: createUsage(null), busy, seams: undefined, stallMs: options.stallMs,
    promptFor: async (_stage: Stage, roomId: string, names: string[], fresh?: boolean) => {
      seen.push([roomId, String(fresh), ...names]);
      return [{ role: 'system', content: `You are ${roomId}.` }];
    },
    toolsFor: () => theirs,
  });
  return { store, stage, busy, tools, seen };
}

const ran = (tools: Tool[], args: Record<string, unknown>, context: Partial<ToolContext> & Pick<ToolContext, 'stage' | 'store'>) =>
  tools[0].run(args, { roomId: 'marketing', granted: new Map(), ...context } as ToolContext);

describe('delegate_task', () => {
  it('hands the work over, keeps the exchange in their own room and gives back only the summary', async () => {
    const colleague = scripted([[{ name: 'look', args: {} }], handover()]);
    const { store, stage, tools, busy } = await setup(colleague.client);
    const effects: ToolEffect[] = [];
    const result = await ran(tools, { to: 'dev', goal: 'Write the launch FAQ', context: 'Ten questions, plain words.' }, { stage, store, report: (effect) => effects.push(effect) });

    expect(result.text).toBe('Dev finished.\nWrote it up.\nChanged: Brand doc');
    expect(result.effect).toEqual({ kind: 'chat-changed', id: 'build' });
    // The wire shows something is happening the moment the work lands, not only when it comes back.
    expect(effects[0]).toEqual({ kind: 'chat-changed', id: 'build' });
    // Marked busy for the whole of it, and free again afterwards.
    expect(busy.has('build')).toBe(false);
    const chat = await store.readChat('build');
    expect(chat.map((message) => [message.role, message.from ?? '', message.text])).toEqual([
      ['user', 'Maya', 'Write the launch FAQ\n\nTen questions, plain words.'],
      ['assistant', '', 'Wrote it up.'],
    ]);
    expect(chat[1].tools).toMatchObject([{ name: 'look', ok: true, result: 'busy while working: true' }]);
    // Nothing of the asker's conversation went with it, and the closing shape is not left lying in their room.
    expect(JSON.stringify(chat)).not.toContain('"done"');
  });

  it('starts them fresh, with their own tools and without the four that would make it a chain', async () => {
    const colleague = scripted([handover()]);
    const theirs = ['look', 'delegate_task', 'ask_person', 'remember', 'note_founder'].map((name) => ({ name, description: name, parameters: {}, async run() { return { text: name }; } }) as Tool);
    const { store, stage, tools, seen } = await setup(colleague.client, { theirs });
    await ran(tools, { to: 'Dev', goal: 'go' }, { stage, store });
    expect(seen).toEqual([['build', 'true', 'look']]);
    expect(colleague.offered[0]).toEqual(['look']);
  });

  it('refuses a colleague who is already working, and a name no wire reaches', async () => {
    const { store, stage, tools } = await setup(scripted([handover()]).client, { busy: new Set(['build']) });
    await expect(ran(tools, { to: 'Dev', goal: 'go' }, { stage, store })).rejects.toThrow(/in the middle of something else/);
    const alone = await setup(scripted([handover()]).client, { wired: false });
    await expect(ran(alone.tools, { to: 'Dev', goal: 'go' }, { stage: alone.stage, store: alone.store })).rejects.toThrow(/Connected: nobody.*drawing a wire/s);
  });

  it('puts their outward step to the founder on the path of whoever asked, saying who it is for', async () => {
    const colleague = scripted([[{ name: 'send', args: { to: 'a@b.c' } }], handover()]);
    const theirs = [{ name: 'send', description: 'send', parameters: {}, approval: true, async run() { return { text: 'sent' }; } } as Tool];
    const { store, stage, tools } = await setup(colleague.client, { theirs });
    const asked: ToolEvent[] = [];
    // The asker's own turn, so the question really travels the way `loop.ts` carries it.
    const asker = scripted([[{ name: 'delegate_task', args: { to: 'Dev', goal: 'send the note' } }], 'Done.']);
    const reply = await runTurn({
      messages: [{ role: 'user', content: 'go' }], tools, clients: [asker.client], usage: createUsage(null),
      context: { stage, roomId: 'marketing', store, granted: new Map() },
      events: { token: () => {}, tool: () => {} },
      approve: async (event) => { asked.push(event); return { ok: true }; },
    });
    expect(asked.map((event) => event.question)).toEqual(['Dev is doing this for Maya. Allow this step?']);
    expect(reply.tools[0].result).toContain('Dev finished.');
  });

  it('asks once more for the shape, then hands back their own words rather than failing', async () => {
    const colleague = scripted(['All finished, honest.', 'Still no json from me.']);
    const { store, stage, tools } = await setup(colleague.client);
    const result = await ran(tools, { to: 'Dev', goal: 'go' }, { stage, store });
    expect(result.text).toBe('Dev did not finish in the shape this asks for, so these are their own words, unsorted:\nAll finished, honest.');
    expect((await store.readChat('build'))[1].text).toBe('All finished, honest.');
  });

  it('stops a colleague who has gone quiet, and says so', async () => {
    const { store, stage, tools, busy } = await setup(naps(), { stallMs: 20 });
    const result = await ran(tools, { to: 'Dev', goal: 'go' }, { stage, store });
    expect(result.text).toMatch(/^Dev went quiet and was stopped, so this is as far as it got\./);
    expect(busy.has('build')).toBe(false);
  });

  it('stops them when the founder stops the asker', async () => {
    const { store, stage, tools } = await setup(naps());
    const stop = new AbortController();
    stop.abort();
    const result = await ran(tools, { to: 'Dev', goal: 'go' }, { stage, store, signal: stop.signal });
    expect(result.text).toMatch(/^Dev was stopped, so this is as far as it got\./);
  });
});
