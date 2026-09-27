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
import { HELD_BACK, NOT_WRITTEN, verdictStanding } from './truth.ts';
import { createUsage } from './usage.ts';

type Step = ModelClient['step'];
async function setup(steps?: Step, extra: ModelClient[] = [], system = '') {
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
    promptFor: async (stage, roomId) => [{ role: 'system', content: `You are ${roomId}.${system}` }, { role: 'user', content: 'q' }],
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

  it('puts the truth net\'s line under a judge\'s answer that names a verdict her doc does not hold', async () => {
    const standing = `\n\n${verdictStanding('Rohan has not written "4. Founder-market fit" yet', ['WEAK', 'PIVOT REQUIRED', 'STRONG'])}`;
    const LINE = 'Unconfirmed: the verdict was not written; Rohan has not written "4. Founder-market fit" yet.';
    const said = await setup(async (_messages, { onToken }) => { onToken('PIVOT REQUIRED, 6/10.'); return { text: '', calls: [] }; }, [], standing);
    const answer = await said.consult({ fromRoomId: 'marketing', toRoomId: 'build', question: 'What is the verdict?' });
    // The asker never reads the word the doc refused: it is taken out before the answer is kept or relayed.
    expect(answer).toBe(`${NOT_WRITTEN}.\n\n${LINE}`);
    expect((await said.store.readChat('build')).at(-1)?.text).toBe(answer);
    const relayed = await setup(async (_messages, { onToken }) => { onToken('No verdict yet: Rohan has not written section 4.'); return { text: '', calls: [] }; }, [], standing);
    expect(await relayed.consult({ fromRoomId: 'marketing', toRoomId: 'build', question: 'What is the verdict?' })).toBe('No verdict yet: Rohan has not written section 4.');
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

  it('saves the error as the reply when no model answers, so a reload shows it', async () => {
    const { store, events } = await turnChat([down('gemini'), down('groq')]);
    expect(events.some((one) => 'error' in one)).toBe(true);
    const talk = await store.readChat('build');
    expect(talk.map((one) => one.role)).toEqual(['user', 'assistant']);
    expect(talk[1].text).toBe('No model could answer this time (gemini down, groq down). Ask again in a minute.');
    expect(talk[1].failed).toBe(true);
  });

  it('says a failed tool call and a busy key in plain words, in the notice and in the saved line', async () => {
    const busy: ModelClient = { ...down('gemini'), async step() { throw Object.assign(new Error('429 Too Many Requests'), { status: 429 }); } };
    const { store, events } = await turnChat([breaking, busy]);
    const notices = events.filter((one) => 'notice' in one).map((one) => String(one.notice)).join(' ');
    expect(notices).not.toMatch(/failed_generation|Failed to call a function/);
    expect(notices).toMatch(/groq-qwen could not answer \(its tool call came out malformed\)/);
    const saved = (await store.readChat('build')).at(-1)!;
    expect(saved.text).not.toMatch(/failed_generation/);
  });

  it('does not count a consult every model broke off part way as a good answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const usage = createUsage(null);
    const recorded: string[] = [];
    const record = usage.record.bind(usage);
    usage.record = (name, ...rest) => { recorded.push(name); return record(name, ...rest); };
    const { consult } = createChat({
      store, roomFeed: createRoomFeed(), busy: new Set(), clients: [breaking], usage, seams: createSeams(),
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async () => [{ role: 'system', content: 'You are build.' }, { role: 'user', content: 'q' }], toolsFor: () => [],
    });
    expect(await consult({ fromRoomId: 'marketing', toRoomId: 'build', question: 'How long?' })).toBe('Let me ground');
    expect(recorded).toEqual([]);
  });

  it('lets a consult fail over when the colleague\'s stream breaks part way', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const { consult } = createChat({
      store, roomFeed: createRoomFeed(), busy: new Set(), clients: [breaking, answering('openrouter', 'About two weeks.')], usage: createUsage(null), seams: createSeams(),
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async () => [{ role: 'system', content: 'You are build.' }, { role: 'user', content: 'q' }], toolsFor: () => [],
    });
    expect(await consult({ fromRoomId: 'marketing', toRoomId: 'build', question: 'How long?' })).toBe('About two weeks.');
  });

  it('keeps a partner\'s first answer, labelled, when taking another look fails', async () => {
    let asked = 0;
    const once: ModelClient = {
      name: 'gemini', model: 'g', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 },
      async step(_messages, { onToken }) {
        asked += 1;
        if (asked > 1) throw Object.assign(new Error('503 overloaded'), { status: 503 });
        onToken('Phase 1: SAFE with a $2M cap.');
        return { text: '', calls: [] };
      },
    };
    const { store, events } = await turnChat([once], 'sam', 'I want to raise a $2M pre-seed next week. Draft the plan.', true);
    expect(events.some((one) => 'error' in one)).toBe(false);
    const saved = (await store.readChat('sam')).at(-1)!;
    expect(saved.text).toBe('Phase 1: SAFE with a $2M cap.\n\n*Partner did not check preconditions.*');
    const done = events.find((one) => 'done' in one) as { message: { text: string } };
    expect(done.message.text).toBe(saved.text);
    // The window was emptied for the second look, so it is given the first answer back.
    const tokens = events.map((one) => ('restart' in one ? '<restart>' : 'token' in one ? String(one.token) : '')).join('');
    expect(tokens.split('<restart>').at(-1)).toBe('Phase 1: SAFE with a $2M cap.');
  });
});

describe('the last look at a reply', () => {
  it('keeps and shows what a slice adds under the reply, in the saved message and as a token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const seams = createSeams();
    const asked: string[] = [];
    seams.on('turn:reply', async (payload, next) => { asked.push(payload.query); return next({ ...payload, reply: { ...payload.reply, text: `${payload.reply.text}\n\n*Kept.*` } }); });
    const client: ModelClient = { name: 'gemini', model: 'm', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 }, async step(_messages, { onToken }) { onToken('Fine.'); return { text: '', calls: [] }; } };
    const { chat } = createChat({
      store, roomFeed: createRoomFeed(), busy: new Set(), clients: [client], usage: createUsage(null), seams,
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async () => [{ role: 'system', content: 'You are Maya.' }, { role: 'user', content: 'q' }], toolsFor: () => [],
    });
    const out = new PassThrough();
    const events: Record<string, unknown>[] = [];
    out.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); });
    const res = Object.assign(out, { writeHead: () => res }) as unknown as ServerResponse;
    await chat('marketing', 'We have 3 paying users.', res);
    expect(asked).toEqual(['We have 3 paying users.']);
    expect(events.filter((one) => 'token' in one).map((one) => one.token).join('')).toBe('Fine.\n\n*Kept.*');
    expect((await store.readChat('marketing')).at(-1)!.text).toBe('Fine.\n\n*Kept.*');
  });
});

// Journey 6: a scripted stage with the team's PIVOT REQUIRED verdict, and a partner who answers "build invoicing".
describe('a partner\'s turn against the team\'s verdict', () => {
  it('asks again with the verdict quoted, says why in a notice, and keeps the answer that weighs it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const stage = await store.loadStage();
    const rules = { framework: 'startup-evaluation', sections: [], verdict: { heading: '6. Verdict', by: 'judge' }, outcomes: ['PIVOT REQUIRED', 'WEAK', 'STRONG'] };
    await store.saveStage({ ...stage, rooms: [...stage.rooms, { id: 'sam', name: 'Sam', role: 'Partner', accent: '#fff', brief: '', partner: true, x: 0, y: 0, w: 1, h: 1 }],
      docs: [...stage.docs, { id: 'eval', title: 'Evaluation', x: 0, y: 0, w: 1, h: 1, rules }] });
    await store.writeDoc('eval', '# Evaluation\n\n## 6. Verdict\n\nVerdict: PIVOT REQUIRED\nScore: 6/10\nPause coding; run 10 discovery calls.\n');
    const replies = ['My call: dive straight into building the client profile form today.', 'The team\'s PIVOT REQUIRED verdict comes first.\n\nMy call: run the 10 discovery calls before any code.'];
    const steps: ModelMessage[][] = [];
    let at = 0;
    const client: ModelClient = { name: 'gemini', model: 'm', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 }, async step(messages, { onToken }) { steps.push(messages); onToken(replies[at++] ?? 'done'); return { text: '', calls: [] }; } };
    const { chat } = createChat({
      store, roomFeed: createRoomFeed(), busy: new Set(), clients: [client], usage: createUsage(null), seams: createSeams(),
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async () => [{ role: 'system', content: 'You are Sam, Partner.' }, { role: 'user', content: 'q' }], toolsFor: () => [],
    });
    const out = new PassThrough();
    const events: Record<string, unknown>[] = [];
    out.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); });
    const res = Object.assign(out, { writeHead: () => res }) as unknown as ServerResponse;
    await chat('sam', 'so what do I do right now?', res);
    expect(steps).toHaveLength(2);
    expect(String(steps[1].at(-1)!.content)).toBe('The team\'s verdict is PIVOT REQUIRED 6/10 (Evaluation); answer in its light or say why you overrule it. Name the verdict in your reply.');
    expect(events).toContainEqual({ notice: 'Sam is taking another look: weighing the team\'s verdict.' });
    expect((await store.readChat('sam')).at(-1)!.text).toBe(replies[1]);
  });
});

// Journeys 6-8: a judge whose doc refused the verdict still said "PIVOT REQUIRED ... 5/10" in chat, and a colleague
// relayed it. The words the founder keeps say "[not written]" in its place.
describe('a verdict the doc does not hold, in a turn', () => {
  const OUTCOMES = ['WEAK', 'PIVOT REQUIRED', 'STRONG'];
  const LINE = 'Unconfirmed: the verdict was not written; Rohan has not written "4. Founder-market fit" yet.';
  async function turn(roomId: string, said: string, system: string, tools: Tool[] = [], calls: { id: string; name: string; args: string }[] = []) {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const stage = await store.loadStage();
    const rules = { framework: 'startup-evaluation', sections: [], verdict: { heading: '5. Verdict', by: 'judge' }, outcomes: OUTCOMES };
    const person = (id: string, name: string) => ({ id, name, role: name, accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 });
    await store.saveStage({ ...stage, rooms: [...stage.rooms, person('priya', 'Priya'), person('meera', 'Meera')], docs: [...stage.docs, { id: 'eval', title: 'Evaluation', x: 0, y: 0, w: 1, h: 1, rules }] });
    let step = 0;
    const client: ModelClient = {
      name: 'gemini', model: 'm', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 },
      async step(_messages, { onToken }) { step += 1; if (step === 1 && calls.length) return { text: '', calls }; onToken(said); return { text: said, calls: [] }; },
    };
    const { chat } = createChat({
      store, roomFeed: createRoomFeed(), busy: new Set(), clients: [client], usage: createUsage(null), seams: createSeams(),
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async () => [{ role: 'system', content: system }, { role: 'user', content: 'q' }], toolsFor: () => tools,
    });
    const out = new PassThrough();
    const events: Record<string, unknown>[] = [];
    out.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); });
    const res = Object.assign(out, { writeHead: () => res }) as unknown as ServerResponse;
    await chat(roomId, 'What is the verdict?', res);
    const done = events.find((one) => 'done' in one) as { message: ChatMessage } | undefined;
    return { kept: (await store.readChat(roomId)).at(-1)!.text, shown: done?.message.text };
  }

  it('keeps the judge\'s reply with the verdict word and score replaced, and the Unconfirmed line once', async () => {
    const system = `You are Priya, the judge.\n\n${verdictStanding('Rohan has not written "4. Founder-market fit" yet', OUTCOMES)}`;
    const { kept, shown } = await turn('priya', '**PIVOT REQUIRED**\n\n**Score:** 5/10 (Fit: 1/2)', system);
    expect(kept).toBe(`**${NOT_WRITTEN}**\n\n**Score:** ${NOT_WRITTEN} (Fit: 1/2)\n\n${LINE}`);
    expect(shown).toBe(kept);
    expect(kept.match(/Unconfirmed/g)).toHaveLength(1);
  });

  it('holds a colleague who relays what an unwritten judge said', async () => {
    const ask: Tool = { name: 'ask_person', description: 'Asks.', parameters: { type: 'object', properties: {} }, run: async () => ({ text: `Priya: ${NOT_WRITTEN}.\n\n${LINE}` }) };
    const { kept } = await turn('meera', 'Priya said PIVOT REQUIRED, 6/10.', 'You are Meera.', [ask], [{ id: 'c1', name: 'ask_person', args: '{}' }]);
    expect(kept).toBe(`Priya said ${NOT_WRITTEN}.\n\n${LINE}`);
  });

  it('leaves a reply alone when no verdict is held back', async () => {
    const { kept } = await turn('priya', 'PIVOT REQUIRED, 5/10.', 'You are Priya, the judge.');
    expect(kept).toBe('PIVOT REQUIRED, 5/10.');
  });
});

// Program 6: the partner slice may ask a finished reply once more (a "what now" that names no standing facts); the
// turn hands it the same road the other second looks take, and says so.
describe('a second look asked for by a slice', () => {
  it('hands the reply seam a way to ask again in words only, and keeps the second answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const stage = await store.loadStage();
    await store.saveStage({ ...stage, rooms: [...stage.rooms, { id: 'sam', name: 'Sam', role: 'Partner', accent: '#fff', brief: '', partner: true, x: 0, y: 0, w: 1, h: 1 }] });
    const replies = ['My call: build it.', 'The verdict and the cash say interviews first.'];
    const steps: { messages: ModelMessage[]; tools: unknown }[] = [];
    let at = 0;
    const client: ModelClient = { name: 'gemini', model: 'm', maxPromptChars: Infinity, tools: true, limits: { rpd: 1000 }, async step(messages, options) { steps.push({ messages, tools: options.tools }); options.onToken(replies[at++] ?? 'done'); return { text: '', calls: [] }; } };
    const seams = createSeams();
    const seen: boolean[] = [];
    seams.on('turn:reply', async (payload, next) => {
      seen.push(!!payload.lookedAgain);
      const second = await payload.again!(payload.reply, 'Take another look before this goes to the founder: they asked what to do next.');
      return next({ ...payload, reply: second });
    });
    const { chat } = createChat({
      store, roomFeed: createRoomFeed(), busy: new Set(), clients: [client], usage: createUsage(null), seams,
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async () => [{ role: 'system', content: 'You are Sam, Partner.' }, { role: 'user', content: 'q' }], toolsFor: () => [],
    });
    const out = new PassThrough();
    const events: Record<string, unknown>[] = [];
    out.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); });
    const res = Object.assign(out, { writeHead: () => res }) as unknown as ServerResponse;
    await chat('sam', 'what now?', res);
    expect(seen).toEqual([false]);
    expect(steps).toHaveLength(2);
    expect(steps[1].tools ?? []).toEqual([]);
    expect(String(steps[1].messages.at(-1)!.content)).toBe('Take another look before this goes to the founder: they asked what to do next.');
    expect(events).toContainEqual({ notice: 'Sam is taking another look: tying it to the standing facts.' });
    expect((await store.readChat('sam')).at(-1)!.text).toBe(replies[1]);
  });
});

describe('a turn when the only model able cannot hold the room prompt (round 6)', () => {
  const check: Tool = { name: 'check', description: 'Checks.', parameters: { type: 'object', properties: {} }, run: async () => ({ text: 'checked' }) };
  const holding = (name: string, maxPromptChars: number, sizes: number[] = []): ModelClient => ({
    name, model: `${name}-1`, maxPromptChars, tools: true, limits: { rpd: 1000 },
    async step(messages, { onToken }) { sizes.push(messages.reduce((sum, one) => sum + (one.content ?? '').length, 0)); onToken(`${name} answers.`); return { text: '', calls: [] }; },
  });
  async function groqTurn(clients: ModelClient[], before?: (usage: ReturnType<typeof createUsage>) => void) {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const usage = createUsage(null);
    before?.(usage);
    const asked: boolean[] = [];
    const payloads: unknown[] = [];
    const seams = createSeams();
    seams.on('turn:before', async (payload, next) => { payloads.push(payload); return next(payload); });
    const { chat } = createChat({
      store, roomFeed: createRoomFeed(), busy: new Set(), clients, usage, seams,
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async (_stage, roomId, _names, _fresh, slim) => {
        asked.push(!!slim);
        return [{ role: 'system', content: slim ? `You are ${roomId}. Numbers: cash 9k.` : `You are ${roomId}. ${'Numbers in full. '.repeat(2000)}` }, { role: 'user', content: 'Raise now?' }];
      },
      toolsFor: () => [check],
    });
    const out = new PassThrough();
    const events: Record<string, unknown>[] = [];
    out.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); });
    const res = Object.assign(out, { writeHead: () => res }) as unknown as ServerResponse;
    await chat('marketing', 'Raise now?', res);
    return { store, asked, payloads, notices: events.flatMap((one) => ('notice' in one ? [one.notice] : [])) };
  }

  it('builds the short prompt, says so, and Groq answers', async () => {
    const sizes: number[] = [];
    const { store, asked, payloads, notices } = await groqTurn([holding('groq', 18_000, sizes)]);
    expect(asked).toEqual([false, true]);
    expect(notices).toContain('Groq answers with a short prompt: the documents\' titles and openings only, no playbook, and only the latest talk.');
    expect(payloads).toEqual([expect.objectContaining({ slim: true })]);
    expect(sizes[0]).toBeLessThan(18_000);
    expect((await store.readChat('marketing')).at(-1)).toMatchObject({ text: 'groq answers.', provider: 'groq' });
  });

  it('keeps the whole prompt while a model that holds it is set up', async () => {
    const { asked, payloads, notices } = await groqTurn([holding('groq', 18_000), holding('gemini', 400_000)]);
    expect(asked).toEqual([false]);
    expect(notices.join(' ')).not.toMatch(/short prompt/);
    expect(payloads).toEqual([expect.not.objectContaining({ slim: true })]);
  });

  it('builds the short prompt when the model that would hold it had its key refused', async () => {
    const { asked } = await groqTurn([holding('gemini', 400_000), holding('groq', 18_000)], (usage) => { usage.failed('gemini', Object.assign(new Error('401 invalid key'), { status: 401 })); });
    expect(asked).toEqual([false, true]);
  });
});

describe('the short prompt, measured with what the extras add (round 6 review)', () => {
  const check: Tool = { name: 'check', description: 'Checks.', parameters: { type: 'object', properties: {} }, run: async () => ({ text: 'checked' }) };
  const holding = (name: string, maxPromptChars: number, sizes: number[] = [], limits: ModelClient['limits'] = { rpd: 1000 }): ModelClient => ({
    name, model: `${name}-1`, maxPromptChars, tools: true, limits,
    async step(messages, { onToken }) { sizes.push(messages.reduce((sum, one) => sum + (one.content ?? '').length, 0)); onToken(`${name} answers.`); return { text: '', calls: [] }; },
  });
  // A room whose whole prompt is `full` characters, and a seam that adds `extra` at turn:before, as the partner's
  // standing facts and the metrics block do.
  async function setupRoom(clients: ModelClient[], full: number, extra: number, usage = createUsage(null)) {
    const dir = await mkdtemp(join(tmpdir(), 'chat-'));
    const store = createStore(dir);
    const built: boolean[] = [];
    const payloads: { slim?: boolean }[] = [];
    const seams = createSeams();
    seams.on('turn:before', async (payload, next) => {
      payloads.push(payload);
      const [system, ...rest] = payload.messages;
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${'F'.repeat(extra)}` }, ...rest] });
    });
    const { chat, consult } = createChat({
      store, roomFeed: createRoomFeed(), busy: new Set(), clients, usage, seams,
      attention: createAttention(dir), approvals: createApprovals(), memory: { fold: async () => false },
      promptFor: async (_stage, roomId, _names, _fresh, slim) => {
        built.push(!!slim);
        return [{ role: 'system', content: slim ? `You are ${roomId}. Short.` : `You are ${roomId}. ${'x'.repeat(full)}` }, { role: 'user', content: 'Raise now?' }];
      },
      toolsFor: () => [check],
    });
    const turn = async () => {
      const out = new PassThrough();
      const events: Record<string, unknown>[] = [];
      out.on('data', (chunk: Buffer) => { for (const line of chunk.toString().split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); });
      const res = Object.assign(out, { writeHead: () => res }) as unknown as ServerResponse;
      await chat('marketing', 'Raise now?', res);
      return events.flatMap((one) => ('notice' in one ? [one.notice as string] : []));
    };
    return { store, built, payloads, turn, consult };
  }

  it('goes short when the prompt fits only without room for the extras, and Groq answers', async () => {
    const sizes: number[] = [];
    const { built, turn } = await setupRoom([holding('groq', 18_000, sizes)], 16_000, 3000);
    const notices = await turn();
    expect(built).toEqual([false, true]);
    expect(notices.some((one) => /short prompt/.test(one))).toBe(true);
    expect(sizes[0]).toBeLessThan(18_000);
  });

  it('goes short after the extras when they make a prompt that fitted too big, and says so once', async () => {
    const sizes: number[] = [];
    const { built, payloads, turn } = await setupRoom([holding('groq', 18_000, sizes)], 12_000, 6000);
    const notices = await turn();
    expect(built).toEqual([false, true]);
    expect(payloads.map((one) => !!one.slim)).toEqual([false, true]);
    expect(notices.filter((one) => /short prompt/.test(one))).toHaveLength(1);
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeLessThan(18_000);
  });

  it('keeps the whole prompt when it fits with the extras in', async () => {
    const { built, turn } = await setupRoom([holding('groq', 18_000)], 8000, 3000);
    expect((await turn()).some((one) => /short prompt/.test(one))).toBe(false);
    expect(built).toEqual([false]);
  });

  it('does not count a model spent for the day (Gemini at its daily allowance) as able to hold the prompt', async () => {
    const usage = createUsage(null);
    usage.record('gemini');
    const sizes: number[] = [];
    const { built } = await setupRoom([holding('gemini', 400_000, [], { rpd: 1 }), holding('groq', 18_000, sizes)], 30_000, 0, usage).then(async (room) => { await room.turn(); return room; });
    expect(built).toEqual([false, true]);
    expect(sizes[0]).toBeLessThan(18_000);
  });

  it('answers a colleague from the short prompt when nobody able holds the whole one', async () => {
    const sizes: number[] = [];
    const { built, payloads, consult } = await setupRoom([holding('groq', 18_000, sizes)], 30_000, 0);
    expect(await consult({ fromRoomId: 'build', toRoomId: 'marketing', question: 'Raise now?' })).toBe('groq answers.');
    expect(built).toEqual([false, true]);
    expect(payloads).toEqual([expect.objectContaining({ slim: true })]);
    expect(sizes[0]).toBeLessThan(18_000);
  });

  it('answers a colleague from the short prompt when the extras made the whole one too big', async () => {
    const { built, payloads, consult } = await setupRoom([holding('groq', 18_000)], 12_000, 6000);
    await consult({ fromRoomId: 'build', toRoomId: 'marketing', question: 'Raise now?' });
    expect(built).toEqual([false, true]);
    expect(payloads.map((one) => !!one.slim)).toEqual([false, true]);
  });
});
