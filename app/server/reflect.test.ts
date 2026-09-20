import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newMessageId, type ToolEvent } from '../shared/model.ts';
import type { TurnResult } from './loop.ts';
import type { ModelMessage } from './prompt.ts';
import type { ModelClient } from './providers.ts';
import { createRecall, wordEmbedder, type Piece } from './recall.ts';
import { asksToLearn, checkVerdict, createLearner, isCorrection, plain, shouldReflect } from './reflect.ts';
import { createSeams } from './seams.ts';
import { createSkills } from './skills.ts';
import { createStore } from './store.ts';
import { createUsage } from './usage.ts';

const at = new Date('2026-09-20T11:00:00').getTime();
// A model that says what it was told to say, keeping every prompt it was handed.
const says = (...replies: string[]): ModelClient & { seen: ModelMessage[][] } => {
  const seen: ModelMessage[][] = [];
  return {
    name: 'script', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {}, seen,
    async step(messages, { onToken }) { seen.push(messages); onToken(replies.shift() ?? '{"action": "none"}'); return { text: '', calls: [], usage: { input: 1, output: 1 } }; },
  };
};
const call = (name: string, args: Record<string, unknown>, ok: boolean, result: string): ToolEvent => ({ id: name, name, args, ok, result });
const answered = (text: string, tools: ToolEvent[] = []): TurnResult => ({ text, tools, provider: 'script', model: 's-1', usage: { input: 1, output: 1 }, stopped: false });
const THREE = [call('web_search', { queries: ['page speed'] }, true, 'SECRET PAGE TEXT'), call('read_file', { path: 'notes.md' }, true, 'SECRET FILE TEXT'), call('write_doc', { doc: 'Brand doc' }, true, 'SECRET DOC TEXT')];

const skill = { name: 'Ship a launch page', when: 'When the founder asks for a landing page for a launch or a new feature', procedure: ['Read the brand doc for voice', 'Write the headline first'], pitfalls: [], verify: 'A stranger can say what the product does.' };
const CREATE = JSON.stringify({ action: 'create', ...skill });

async function setup(clients: ModelClient[], now = () => at) {
  const dir = await mkdtemp(join(tmpdir(), 'reflect-'));
  const store = createStore(dir);
  const skills = createSkills(dir, now);
  const gather = async (): Promise<Piece[]> => (await skills.list()).filter((one) => one.state === 'active')
    .map((one) => ({ kind: 'skill', id: one.id, title: one.name, text: `${one.when}\n\n${one.procedure.join('\n')}` }));
  const recall = createRecall({ dir, embed: wordEmbedder, gather });
  const learned: { name: string; action: string }[] = [];
  const problems: Error[] = [];
  const learner = createLearner({ skills, recall, store, clients, usage: createUsage(null), now, roomName: async () => 'Maya', onLearned: (one) => learned.push({ name: one.name, action: one.action }) });
  const seams = createSeams((_name, error) => problems.push(error));
  seams.on('turn:after', learner.after);
  const after = (query: string, reply: TurnResult, source: 'chat' | 'run' = 'run') => seams.run('turn:after', { roomId: 'marketing', source, query, reply });
  return { dir, store, skills, learner, learned, problems, seams, after };
}

describe('what is worth learning from', () => {
  it('reads a correction in the founder\'s own words', () => {
    for (const said of ['No, the other one.', 'That was close. Not like that — shorter.', 'Instead of the table, use a list.', 'I said Tuesday.', 'Wrong file.', 'Should be in the brand doc.', "Don't send it yet.", 'Looks good.\nNo, wait, change the title.']) {
      expect(isCorrection(said), said).toBe(true);
    }
    for (const said of ['There is nothing wrong with it.', 'Can you do the instead-of version?', 'I know you said Tuesday and that is fine.', 'No idea, but carry on.', 'Add a note about what not to do.']) {
      expect(isCorrection(said), said).toBe(false);
    }
  });

  it('hears the founder ask for it outright', () => {
    for (const said of ['Learn this.', 'learn from that, please', 'Remember how you did that.', 'Add this to the playbook.', 'Write that down for next time.']) expect(asksToLearn(said), said).toBe(true);
    for (const said of ['What did you learn at school?', 'This is a playbook for the sales team.', 'Do you remember Tuesday?']) expect(asksToLearn(said), said).toBe(false);
  });

  it('starts on real effort, on getting round a failure, on a correction and on being asked', () => {
    expect(shouldReflect({ source: 'run', query: 'Write the launch page', reply: answered('done', THREE) })).toBe('effort');
    expect(shouldReflect({ source: 'run', query: 'Write the launch page', reply: answered('done', THREE.slice(0, 2)) })).toBe(null);
    expect(shouldReflect({ source: 'run', query: 'Write the launch page', reply: answered('done', [call('browse', {}, false, 'timed out'), call('web_search', {}, true, 'ok')]) })).toBe('recovered');
    // A failure with nothing after it taught nobody anything.
    expect(shouldReflect({ source: 'run', query: 'Write the launch page', reply: answered('done', [call('web_search', {}, true, 'ok'), call('browse', {}, false, 'timed out')]) })).toBe(null);
    expect(shouldReflect({ source: 'chat', query: 'No, the other one.', reply: answered('Sorry — changed.') })).toBe('corrected');
    expect(shouldReflect({ source: 'chat', query: 'Thanks, that is right.', reply: answered('Glad it helps.') })).toBe(null);
    expect(shouldReflect({ source: 'chat', query: 'Learn this.', reply: answered('Noted.') })).toBe('taught');
    // A turn the founder stopped is not a turn that finished.
    expect(shouldReflect({ source: 'run', query: 'Write the launch page', reply: { ...answered('half', THREE), stopped: true } })).toBe(null);
    expect(shouldReflect({ source: 'chat', query: 'Learn this.', reply: { ...answered(''), stopped: true } })).toBe(null);
  });

  it('knows the three shapes an answer may take, and says what is wrong with the rest', () => {
    expect(checkVerdict({ action: 'none' })).toEqual({ action: 'none' });
    expect(checkVerdict({ action: 'create', ...skill })).toMatchObject({ action: 'create', name: skill.name });
    expect(checkVerdict({ action: 'patch', skill: 'ship-a-launch-page', changes: [{ field: 'pitfalls', old: '', new: 'Not on a Friday' }] }))
      .toEqual({ action: 'patch', skill: 'ship-a-launch-page', changes: [{ field: 'pitfalls', old: '', new: 'Not on a Friday' }] });
    expect(() => checkVerdict({ action: 'maybe' })).toThrow(/"action" must be/);
    expect(() => checkVerdict({ action: 'create', ...skill, name: 'x'.repeat(61) })).toThrow(/"name" is too long/);
    expect(() => checkVerdict({ action: 'patch', changes: [] })).toThrow(/"skill" is missing/);
    expect(() => checkVerdict({ action: 'patch', skill: 'a', changes: [{ field: 'colour', old: '', new: 'blue' }] })).toThrow(/"field" must be one of/);
    expect(() => checkVerdict(null)).toThrow(/"action" must be/);
  });
});

describe('the learner', () => {
  it('shows the model what was asked and what was done, and never a word a tool came back with', async () => {
    const client = says(CREATE);
    const { after, skills, learned } = await setup([client]);
    await after('Write the launch page\n\nThree sections, our voice.', answered('Done — the page is in the brand doc.', THREE));

    expect(client.seen).toHaveLength(1);
    const words = client.seen[0].map((message) => message.content).join('\n');
    expect(words).toContain('web_search');
    expect(words).toContain('page speed');
    expect(words).toContain('Write the launch page');
    expect(words).toContain('Done — the page is in the brand doc.');
    for (const secret of ['SECRET PAGE TEXT', 'SECRET FILE TEXT', 'SECRET DOC TEXT']) expect(words).not.toContain(secret);
    // The doctrine goes with every one of these questions.
    expect(client.seen[0][0].content).toContain('a lesson, not a log');
    expect(client.seen[0][0].content).toContain('none is the usual answer');
    expect(client.seen[0][0].content).toContain('json');

    expect((await skills.list())[0]).toMatchObject({ name: skill.name, by: { roomId: 'marketing', name: 'Maya' }, source: { kind: 'run', ref: 'marketing' } });
    expect(learned).toEqual([{ name: skill.name, action: 'create' }]);
  });

  it('carries what was said before a correction, and not the turn it is correcting twice', async () => {
    const client = says('{"action": "none"}');
    const { after, store } = await setup([client]);
    for (const [role, text] of [['user', 'Write me a headline.'], ['assistant', 'Ship faster, worry less.'], ['user', 'No, the other one.']] as const) {
      await store.appendChat('marketing', { id: newMessageId(), role, text, at });
    }
    await after('No, the other one.', answered('Here is another: Build in a day.'), 'chat');
    const words = client.seen[0].at(-1)!.content;
    expect(words).toContain('Founder: Write me a headline.');
    expect(words).toContain('Maya: Ship faster, worry less.');
    expect(words).toContain('The founder corrected the person here.');
    expect(words.match(/No, the other one\./g)).toHaveLength(1);
  });

  it('drops a new skill that says what one already in the playbook says', async () => {
    const copy = JSON.stringify({ action: 'create', name: 'Build a landing page for a release', when: 'When the founder wants a new landing page for launching a feature or product', procedure: ['Read the brand doc', 'Headline first'], pitfalls: [], verify: 'It reads well.' });
    const { after, skills, learned } = await setup([says(copy)]);
    await skills.create({ ...skill, by: { roomId: 'marketing', name: 'Maya' }, source: { kind: 'run', ref: 'task-1' } });
    await after('Write the launch page', answered('Done.', THREE));
    expect(await skills.list()).toHaveLength(1);
    expect(learned).toEqual([]);
  });

  it('changes the skill the model pointed at rather than writing a second one', async () => {
    const patch = JSON.stringify({ action: 'patch', skill: 'ship-a-launch-page', changes: [{ field: 'pitfalls', old: '', new: 'The brand doc is the voice; do not invent one' }] });
    const { after, skills, learned } = await setup([says(patch)]);
    await skills.create({ ...skill, by: { roomId: 'marketing', name: 'Maya' }, source: { kind: 'run', ref: 'task-1' } });
    await after('Write the launch page', answered('Done.', THREE));
    const [one] = await skills.list();
    expect(one.pitfalls).toEqual(['The brand doc is the voice; do not invent one']);
    expect(one.patches).toBe(1);
    expect(learned).toEqual([{ name: skill.name, action: 'patch' }]);
    // The model is shown what is nearest before it writes, which is why a patch is the usual answer.
    expect(JSON.stringify(await skills.list())).toContain('Ship a launch page');
  });

  it('thinks six times an hour and no more', async () => {
    let now = at;
    // Eight lessons with nothing to do with one another, so nothing here is dropped for being a near-copy.
    const apart = ['Ship a launch page', 'Chase an unpaid invoice', 'Prepare the weekly update', 'Answer a support ticket', 'Book a customer interview', 'Renew the domain name', 'Read a pull request', 'Refund a subscription'];
    const { after, skills } = await setup([says(...apart.map((name, round) => JSON.stringify({ action: 'create', ...skill, name, when: `When somebody has to ${name.toLowerCase()} and round ${round} comes` })))], () => now);
    for (let round = 0; round < 8; round += 1) await after(`Task ${round}`, answered('Done.', THREE));
    expect(await skills.list()).toHaveLength(6);
    now = at + 3_600_001;
    await after('Task nine', answered('Done.', THREE));
    expect(await skills.list()).toHaveLength(7);
  });

  it('never costs a turn, however badly it goes', async () => {
    const broken: ModelClient = { name: 'broken', model: 'b-1', maxPromptChars: Infinity, tools: true, limits: {}, step: async () => { throw new Error('the model is down'); } };
    const { after, problems, skills } = await setup([broken]);
    await expect(after('Write the launch page', answered('Done.', THREE))).resolves.toBeTruthy();
    expect(problems.map((one) => one.message).join(' ')).toContain('the model is down');
    expect(await skills.list()).toEqual([]);

    // Told twice what was wrong with it and wrong twice over is not a failure, it is an answer: there was no lesson
    // here. Nothing is written down and nothing is reported, because nothing went wrong.
    const { after: again, problems: more, skills: none } = await setup([says('I would rather not.', 'Still no.')]);
    await expect(again('Write the launch page', answered('Done.', THREE))).resolves.toBeTruthy();
    expect(more).toEqual([]);
    expect(await none.list()).toEqual([]);
  });

  it('lets go of the turn before it starts thinking', async () => {
    let answer = (_reply: string) => {};
    const slow: ModelClient = {
      name: 'slow', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {},
      async step(_messages, { onToken }) { await new Promise<void>((done) => { answer = (reply) => { onToken(reply); done(); }; }); return { text: '', calls: [], usage: { input: 1, output: 1 } }; },
    };
    const { seams, after, skills } = await setup([slow]);
    const order: string[] = [];
    seams.on('turn:after', async (payload, next) => { order.push('the next handler'); return next(payload); });
    const turn = after('Write the launch page', answered('Done.', THREE));
    await new Promise((done) => { setTimeout(done, 5); });
    // Everything else that watches a finished turn has been and gone while the learner is still waiting on a model.
    expect(order).toEqual(['the next handler']);
    expect(await skills.list()).toEqual([]);
    answer(CREATE);
    await turn;
    expect(await skills.list()).toHaveLength(1);
  });
});

describe('plain', () => {
  const lesson = { action: 'create' as const, name: 'Write a launch FAQ', when: 'When something new is about to go out', pitfalls: [], verify: 'It is there to read.' };

  it('takes the tool label off a step, but only for tools the person really called', () => {
    const verdict = plain({ ...lesson, procedure: ['read_doc – review the briefing', 'recall: find what customers asked', 'Write_doc - draft five questions', 'send_email – tell everyone', 'Re-read it once'] }, ['read_doc', 'recall', 'write_doc']);
    expect(verdict).toMatchObject({ procedure: ['Review the briefing', 'Find what customers asked', 'Draft five questions', 'send_email – tell everyone', 'Re-read it once'] });
  });

  it('does the same for a step a patch adds, and leaves everything else alone', () => {
    expect(plain({ action: 'patch', skill: 'a', changes: [{ field: 'procedure', old: '', new: 'read_doc – read the brief first' }, { field: 'verify', old: 'x', new: 'read_doc – stays' }] }, ['read_doc']))
      .toMatchObject({ changes: [{ new: 'Read the brief first' }, { new: 'read_doc – stays' }] });
    expect(plain({ action: 'none' }, ['read_doc'])).toEqual({ action: 'none' });
    expect(plain({ ...lesson, procedure: ['recall – as written'] }, [])).toMatchObject({ procedure: ['recall – as written'] });
  });
});
