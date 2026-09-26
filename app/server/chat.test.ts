import { mkdtemp } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../shared/model.ts';
import { createApprovals } from './approvals.ts';
import { createAttention } from './attention.ts';
import { createChat } from './chat.ts';
import type { ModelMessage } from './prompt.ts';
import type { ModelClient } from './providers.ts';
import { createRoomFeed } from './rooms-feed.ts';
import { createSeams } from './seams.ts';
import { createStore } from './store.ts';
import type { Tool } from './tools/registry.ts';
import { createUsage } from './usage.ts';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'chat-'));
  const store = createStore(dir);
  const seen: { messages: ModelMessage[]; tools: unknown }[] = [];
  const client: ModelClient = {
    name: 'script', model: 'm', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 },
    async step(messages, options) { seen.push({ messages, tools: options.tools }); options.onToken('My answer.'); return { text: 'My answer.', calls: [] }; },
  };
  const seams = createSeams();
  const payloads: unknown[] = [];
  seams.on('turn:before', async (payload, next) => {
    payloads.push(payload);
    const [system, ...rest] = payload.messages;
    return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\nPLAYBOOK` }, ...rest] });
  });
  const busy = new Set<string>();
  const { consult } = createChat({
    store, roomFeed: createRoomFeed(), busy, clients: [client], usage: createUsage(null), seams,
    attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
    promptFor: async (stage, roomId) => [{ role: 'system', content: `You are ${roomId}.` }, { role: 'user', content: 'q' }],
    toolsFor: () => [],
  });
  return { store, seen, payloads, busy, consult };
}

describe('a consult', () => {
  it('shows the colleague what a turn of their own would, offers them nothing, and keeps both sides', async () => {
    const { store, seen, payloads, consult } = await setup();
    expect(await consult({ fromRoomId: 'marketing', toRoomId: 'build', question: 'How long to build it?' })).toBe('My answer.');
    expect(payloads).toEqual([expect.objectContaining({ roomId: 'build', source: 'run', query: 'How long to build it?', offered: [] })]);
    expect(seen[0].messages[0].content).toContain('PLAYBOOK');
    expect(seen[0].tools ?? []).toEqual([]);
    const talk = await store.readChat('build');
    expect(talk.map((one) => [one.role, one.text])).toEqual([['user', 'How long to build it?'], ['assistant', 'My answer.']]);
    expect(talk[0].from).toBe('Maya');
  });

  it('leaves a colleague who is in a turn of their own undisturbed', async () => {
    const { seen, payloads, busy, consult } = await setup();
    busy.add('build');
    await consult({ fromRoomId: 'marketing', toRoomId: 'build', question: 'Quick one?' });
    expect(payloads).toEqual([]);
    expect(seen[0].messages[0].content).not.toContain('PLAYBOOK');
  });
});

describe('a turn', () => {
  it('keeps the reply as it stands once a step has run, and writes the finished one in its place', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    let step = 0;
    let midway: ChatMessage[] = [];
    const client: ModelClient = {
      name: 'script', model: 'm', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 },
      async step(_messages, options) {
        step += 1;
        if (step === 1) { options.onToken('Looking.'); return { text: 'Looking.', calls: [{ id: 'c1', name: 'check', args: '{}' }] }; }
        // A restart here, with the tool already run, would have lost the whole reply.
        midway = await store.readChat('marketing');
        options.onToken(' Done.');
        return { text: ' Done.', calls: [] };
      },
    };
    const check: Tool = { name: 'check', description: 'Checks.', parameters: { type: 'object', properties: {} }, run: async () => ({ text: 'checked' }) };
    const { chat } = createChat({
      store, roomFeed: createRoomFeed(), busy: new Set(), clients: [client], usage: createUsage(null), seams: createSeams(),
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async () => [{ role: 'system', content: 'You are marketing.' }, { role: 'user', content: 'q' }],
      toolsFor: () => [check],
    });
    const res = Object.assign(new PassThrough(), { writeHead: () => res }) as unknown as ServerResponse;
    await chat('marketing', 'Check it', res);
    const early = midway.find((one) => one.role === 'assistant')!;
    expect(early).toMatchObject({ text: 'Looking.', stopped: true, tools: [expect.objectContaining({ name: 'check', result: 'checked' })] });
    const talk = await store.readChat('marketing');
    expect(talk.map((one) => one.role)).toEqual(['user', 'assistant']);
    expect(talk[1]).toMatchObject({ id: early.id, text: expect.stringMatching(/^Looking\.\s+Done\.$/) });
    expect(talk[1].stopped).toBeUndefined();
  });
});
