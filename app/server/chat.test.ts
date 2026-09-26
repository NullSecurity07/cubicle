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
import type { ModelClient, ModelTurn } from './providers.ts';
import { createRoomFeed } from './rooms-feed.ts';
import { createSeams } from './seams.ts';
import { createStore } from './store.ts';
import type { Tool } from './tools/registry.ts';
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

describe('a partner\'s turn', () => {
  it('asks the partner once more when a raise plan comes back without the precondition check, and keeps one My call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const stage = await store.loadStage();
    await store.saveStage({ ...stage, rooms: [...stage.rooms, { id: 'sam', name: 'Sam', role: 'Partner', accent: '#fff', brief: '', partner: true, x: 0, y: 0, w: 1, h: 1 }] });
    const systems: string[] = [];
    const replies = ['Phase 1: SAFE with a $2M cap.\n\nMy call: go.', 'Not yet. You have no users; before that, get 20 paying ones.\n\nMy call: no raise.\n\nMy call: no raise next week.'];
    const client: ModelClient = {
      name: 'gemini', model: 'm', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 },
      async step(messages, options) { systems.push(String(messages[0].content)); const text = replies[systems.length - 1]; options.onToken(text); return { text, calls: [] }; },
    };
    const { chat } = createChat({
      store, roomFeed: createRoomFeed(), busy: new Set(), clients: [client], usage: createUsage(null), seams: createSeams(),
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async () => [{ role: 'system', content: 'You are Sam, Partner.' }, { role: 'user', content: 'q' }],
      toolsFor: () => [],
    });
    const res = Object.assign(new PassThrough(), { writeHead: () => res }) as unknown as ServerResponse;
    await chat('sam', 'I want to raise a $2M pre-seed next week. We have no users. Draft the plan.', res);
    expect(systems).toHaveLength(2);
    expect(systems[0]).not.toContain('Before you answer');
    expect(systems[1]).toContain('List its preconditions');
    const talk = await store.readChat('sam');
    expect(talk.at(-1)!.text).toBe('Not yet. You have no users; before that, get 20 paying ones.\n\nMy call: no raise next week.');
  });
});
