import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApprovals } from './approvals.ts';
import { createAttention } from './attention.ts';
import { createChat } from './chat.ts';
import type { ModelMessage } from './prompt.ts';
import type { ModelClient } from './providers.ts';
import { createRoomFeed } from './rooms-feed.ts';
import { createSeams } from './seams.ts';
import { createStore } from './store.ts';
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
