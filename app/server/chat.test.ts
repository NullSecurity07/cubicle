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
  async function partnerChat(replies: { text: string; calls?: { id: string; name: string; args: string }[] }[]) {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const stage = await store.loadStage();
    await store.saveStage({ ...stage, rooms: [...stage.rooms, { id: 'sam', name: 'Sam', role: 'Partner', accent: '#fff', brief: '', partner: true, x: 0, y: 0, w: 1, h: 1 }] });
    const steps: { messages: ModelMessage[]; tools: unknown }[] = [];
    let at = 0;
    const client: ModelClient = {
      name: 'gemini', model: 'm', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 },
      async step(messages, options) { steps.push({ messages, tools: options.tools }); const next = replies[at++] ?? { text: 'done' }; options.onToken(next.text); return { text: next.text, calls: next.calls ?? [] }; },
    };
    const ran: string[] = [];
    const write: Tool = { name: 'create_doc', description: 'Makes a doc.', parameters: { type: 'object', properties: {} }, run: async () => { ran.push('create_doc'); return { text: 'Created.' }; } };
    const feed = createRoomFeed();
    const heard: string[] = [];
    feed.watch((event) => { if ('restart' in event) heard.push('feed restart'); });
    const { chat } = createChat({
      store, roomFeed: feed, busy: new Set(), clients: [client], usage: createUsage(null), seams: createSeams(),
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async () => [{ role: 'system', content: 'You are Sam, Partner.' }, { role: 'user', content: 'q' }],
      toolsFor: () => [write],
    });
    const out = new PassThrough();
    const events: Record<string, unknown>[] = [];
    out.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); });
    const res = Object.assign(out, { writeHead: () => res }) as unknown as ServerResponse;
    await chat('sam', 'I want to raise a $2M pre-seed next week. We have no users. Draft the plan.', res);
    return { store, steps, ran, events, heard };
  }

  it('asks again in words only, with the first answer and the nudge, clears the bubble first, and keeps one My call', async () => {
    const { store, steps, events, heard } = await partnerChat([
      { text: 'Phase 1: SAFE with a $2M cap.\n\nMy call: go.' },
      { text: 'Not yet. You have no users; before that, get 20 paying ones.\n\nMy call: no raise.\n\nMy call: no raise next week.' },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[1].tools ?? []).toEqual([]);
    expect(steps[1].messages.at(-2)).toEqual({ role: 'assistant', content: 'Phase 1: SAFE with a $2M cap.\n\nMy call: go.' });
    expect(String(steps[1].messages.at(-1)!.content)).toContain('List its preconditions');
    const order = events.map((one) => ('notice' in one ? 'notice' : 'restart' in one ? 'restart' : 'token' in one ? `token ${String(one.token).slice(0, 7)}` : 'done' in one ? 'done' : 'turn'));
    expect(order).toEqual(['turn', 'token Phase 1', 'notice', 'restart', 'token Not yet', 'done']);
    expect(events.find((one) => 'notice' in one)).toEqual({ notice: 'Sam is taking another look: checking the preconditions.' });
    expect(heard).toEqual(['feed restart']);
    const talk = await store.readChat('sam');
    expect(talk.at(-1)!.text).toBe('Not yet. You have no users; before that, get 20 paying ones.\n\nMy call: no raise next week.');
  });

  it('does not ask again when the first answer wrote something, so no tool runs twice', async () => {
    const { steps, ran, store } = await partnerChat([
      { text: 'Writing the plan.', calls: [{ id: 'c1', name: 'create_doc', args: '{}' }] },
      { text: 'Saved the raise plan doc.' },
    ]);
    expect(ran).toEqual(['create_doc']);
    expect(steps).toHaveLength(2);
    expect((await store.readChat('sam')).at(-1)!.text).toMatch(/Partner did not check preconditions/);
  });
});

describe('a turn when models fail', () => {
  async function turnChat(clients: ModelClient[], roomId = 'build', text = 'Critique the idea.', partner = false) {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const stage = await store.loadStage();
    if (partner) await store.saveStage({ ...stage, rooms: [...stage.rooms, { id: roomId, name: 'Sam', role: 'Partner', accent: '#fff', brief: '', partner: true, x: 0, y: 0, w: 1, h: 1 }] });
    const feed = createRoomFeed();
    const heard: string[] = [];
    feed.watch((event) => { if ('restart' in event) heard.push('feed restart'); });
    const { chat } = createChat({
      store, roomFeed: feed, busy: new Set(), clients, usage: createUsage(null), seams: createSeams(),
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async () => [{ role: 'system', content: `You are ${roomId}.` }, { role: 'user', content: 'q' }],
      toolsFor: () => [],
    });
    const out = new PassThrough();
    const events: Record<string, unknown>[] = [];
    out.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); });
    const res = Object.assign(out, { writeHead: () => res }) as unknown as ServerResponse;
    await chat(roomId, text, res);
    return { store, events, heard };
  }
  const answering = (name: string, text: string): ModelClient => ({
    name, model: `${name}-1`, maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 },
    async step(_messages, { onToken }) { onToken(text); return { text: '', calls: [] }; },
  });
  const breaking: ModelClient = {
    name: 'groq-qwen', model: 'qwen', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 },
    async step(_messages, { onToken }) {
      for (const token of ['Let', ' me', ' ground']) onToken(token);
      throw Object.assign(new Error("400 Failed to call a function. See 'failed_generation'."), { status: 400 });
    },
  };
  const down = (name: string): ModelClient => ({
    name, model: `${name}-1`, maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 },
    async step() { throw Object.assign(new Error('503 overloaded'), { status: 503 }); },
  });

  it('empties the bubble on every window when a broken reply is dropped for the next model, and saves only the whole answer', async () => {
    const { store, events, heard } = await turnChat([breaking, answering('openrouter', 'The whole critique.')]);
    const order = events.map((one) => ('restart' in one ? 'restart' : 'token' in one ? `token ${one.token}` : 'done' in one ? 'done' : 'notice' in one ? 'notice' : 'turn'));
    expect(order).toEqual(['turn', 'token Let', 'token  me', 'token  ground', 'restart', 'token The whole critique.', 'notice', 'done']);
    expect(heard).toEqual(['feed restart']);
    const saved = (await store.readChat('build')).at(-1)!;
    expect(saved).toMatchObject({ role: 'assistant', text: 'The whole critique.', provider: 'openrouter' });
  });

});
