import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApprovals } from './approvals.ts';
import { createAttention } from './attention.ts';
import { createChat } from './chat.ts';
import type { ModelMessage } from './prompt.ts';
import type { ModelClient, ModelTurn } from './providers.ts';
import { createRoomFeed } from './rooms-feed.ts';
import { createSeams } from './seams.ts';
import { createStore } from './store.ts';
import { HELD_BACK } from './truth.ts';
import { createUsage } from './usage.ts';

type Step = ModelClient['step'];
async function setup(steps?: Step, extra: ModelClient[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-'));
  const store = createStore(dir);
  const seen: { messages: ModelMessage[]; tools: unknown }[] = [];
  const client: ModelClient = {
    name: 'script', model: 'm', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 },
    async step(messages, options) { seen.push({ messages, tools: options.tools }); if (steps) return steps(messages, options); options.onToken('My answer.'); return { text: 'My answer.', calls: [] }; },
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
    store, roomFeed: createRoomFeed(), busy, clients: [client, ...extra], usage: createUsage(null), seams,
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

  it('asks once more when the colleague writes a tool call as text, and saves only the answer', async () => {
    const said = ['<tool_call><function=ask_founder>\n<parameter=question>What price?</parameter></function></tool_call>', 'About two weeks.'];
    const { store, seen, consult } = await setup(async (_messages, { onToken }) => { onToken(said.shift() ?? ''); return { text: '', calls: [] }; });
    expect(await consult({ fromRoomId: 'marketing', toRoomId: 'build', question: 'How long?' })).toBe('About two weeks.');
    expect(String(seen[1].messages.at(-1)?.content)).toMatch(/no tool can be called here/);
    expect((await store.readChat('build')).at(-1)?.text).toBe('About two weeks.');
  });

  it('holds back a colleague who writes the call as text twice', async () => {
    const { consult } = await setup(async (_messages, { onToken }) => { onToken('{"name": "ask_founder", "arguments": {"question": "x"}}'); return { text: '', calls: [] }; });
    expect(await consult({ fromRoomId: 'marketing', toRoomId: 'build', question: 'How long?' })).toBe(HELD_BACK);
  });

  it('goes through the breaker like a turn: a key that failed rests, and the next model answers', async () => {
    let asked = 0;
    const backup: ModelClient = { name: 'backup', model: 'b', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 }, async step(_messages, { onToken }): Promise<ModelTurn> { onToken('From backup.'); return { text: '', calls: [] }; } };
    const { consult } = await setup(async () => { asked += 1; throw Object.assign(new Error('Too Many Requests'), { status: 429 }); }, [backup]);
    expect(await consult({ fromRoomId: 'marketing', toRoomId: 'build', question: 'One?' })).toBe('From backup.');
    expect(await consult({ fromRoomId: 'marketing', toRoomId: 'build', question: 'Two?' })).toBe('From backup.');
    expect(asked).toBe(1);
  });
});
