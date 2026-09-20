import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Skill, Stage, Task } from '../../shared/model.ts';
import { createBoards } from '../boards.ts';
import type { ModelClient } from '../providers.ts';
import type { Skills } from '../skills.ts';
import { createAutomation, HANDOVER } from './run.ts';

const folder = () => mkdtemp(join(tmpdir(), 'automation-'));
const stage = { rooms: [{ id: 'marketing', name: 'Maya' }], docs: [], wires: [], cards: [] } as unknown as Stage;
const client = { name: 's', model: 's-1' } as unknown as ModelClient;
const skillOf = (state: Skill['state'] = 'active'): Skill => ({
  id: 'how-to-send-the-friday-note', name: 'How to send the Friday note', when: 'When it is Friday', procedure: ['Read what everybody finished'],
  pitfalls: [], verify: 'The founder sent it.', state, by: { roomId: 'marketing', name: 'Maya' }, source: { kind: 'run', ref: 'x' },
  uses: 0, patches: 0, createdAt: 1, history: [],
});
const until = async (check: () => Promise<boolean>) => { for (let at = 0; at < 600; at += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timed out'); };

async function setup(held?: Skill) {
  const dir = await folder();
  const boards = createBoards(dir);
  const told: string[] = [];
  const started: string[] = [];
  const used: string[] = [];
  const skills = {
    get: async (id: string) => (held?.id === id ? held : undefined),
    used: async (id: string) => { used.push(id); return held!; },
  } as unknown as Skills;
  const plan = createAutomation({
    boards, filesDir: join(dir, 'files'), skills, clients: [client], runs: { start: async (_board, taskId) => { started.push(taskId); } },
    notify: (title, body) => told.push(`${title} | ${body}`),
  });
  const task = await boards.add('b1', { title: 'Morning numbers' });
  const state = async (id = task.id) => (await boards.list('b1')).find((one) => one.id === id)!;
  return { boards, plan, task, state, told, started, used };
}

describe('before anything is spent', () => {
  it('holds a task up and says why, without asking a model a thing', async () => {
    const { plan, task, state } = await setup();
    expect(await plan.check('b1', task, stage)).toBe('give the task to a person first');
    expect(await state()).toMatchObject({ run: { state: 'blocked', result: 'give the task to a person first' } });
    expect((await state()).run!.log).toEqual(['did not start: give the task to a person first']);
  });

  it('will not run a task whose skill was switched off or thrown away', async () => {
    const off = await setup(skillOf('off'));
    await off.boards.change('b1', off.task.id, { assignee: 'marketing', skill: 'how-to-send-the-friday-note' });
    expect(await off.plan.check('b1', await off.state(), stage)).toContain('is switched off');

    const gone = await setup();
    await gone.boards.change('b1', gone.task.id, { assignee: 'marketing', skill: 'how-to-send-the-friday-note' });
    expect(await gone.plan.check('b1', await gone.state(), stage)).toContain('not in the playbook any more');
  });

  it('will not run a script that does not hold together, and needs nobody for one that does', async () => {
    const { boards, plan, task, state } = await setup();
    await boards.change('b1', task.id, { script: { language: 'javascript', code: 'const x = ;' } });
    expect(await plan.check('b1', await state(), stage)).toContain('mistake in it');
    await boards.change('b1', task.id, { script: { language: 'python', code: 'print("hello"' } });
    expect(await plan.check('b1', await state(), stage)).toContain('do not close');
    await boards.change('b1', task.id, { script: { language: 'javascript', code: 'console.log(1)' } });
    expect(await plan.check('b1', await state(), stage)).toBe('');
  });
});

describe('work that is a script', () => {
  it('runs in the sandbox, with the same record as anybody else\'s run', async () => {
    const { boards, plan, task, state } = await setup();
    await boards.change('b1', task.id, { script: { language: 'javascript', code: "console.log('seven visitors');" } });
    await plan.script('b1', await state());
    expect(await state()).toMatchObject({ column: 'doing', run: { state: 'running' } });
    await until(async () => (await state()).run?.state === 'done');
    expect(await state()).toMatchObject({ column: 'review', run: { state: 'done', result: 'seven visitors' } });
    expect((await state()).run!.log).toEqual(['the JavaScript script started', 'the script finished']);
  });

  it('is a quiet success when it prints nothing, and says so out loud when it fails', async () => {
    const quiet = await setup();
    await quiet.boards.change('b1', quiet.task.id, { script: { language: 'javascript', code: 'const kept = 1 + 1;' } });
    await quiet.plan.script('b1', await quiet.state());
    await until(async () => (await quiet.state()).run?.state === 'done');
    expect((await quiet.state()).run!.result).toBeUndefined();
    expect(quiet.told).toEqual([]);

    const broken = await setup();
    await broken.boards.change('b1', broken.task.id, { script: { language: 'javascript', code: "throw new Error('the file was not there');" } });
    await broken.plan.script('b1', await broken.state());
    await until(async () => (await broken.state()).run?.state === 'failed');
    expect(broken.told[0]).toContain('The script could not finish');
    expect(broken.told[0]).toContain('the file was not there');
  });
});

describe('one task after another', () => {
  it('hands the result over as material, once, and says on the card where it came from', async () => {
    const { boards, plan, task, state, started } = await setup();
    const next = await boards.add('b1', { title: 'Write it up' });
    await boards.change('b1', next.id, { assignee: 'marketing', after: task.id });
    await plan.done('b1', task, 'Forty seven people came by.');
    expect(started).toEqual([next.id]);
    expect((await state(next.id)).from).toMatchObject({ title: 'Morning numbers', result: 'Forty seven people came by.' });

    // The run is already on the card by the time the work opens, so the handover can be written into its log.
    await boards.update('b1', next.id, (one) => { one.run = { state: 'running', startedAt: 1, log: ['Maya started'] }; });
    const opening = await plan.opening('b1', await state(next.id));
    expect(opening).toContain(HANDOVER);
    expect(opening).toContain('Forty seven people came by.');
    expect((await state(next.id)).from).toBeUndefined();
    expect((await state(next.id)).run!.log).toEqual(['Maya started', 'after "Morning numbers"']);
    // Run again by hand, it works from the task itself rather than from last week's answer.
    expect(await plan.opening('b1', await state(next.id))).toBe('');
  });

  it('refuses a chain that would go round in a circle, in words, while it is being set up', async () => {
    const { boards, task } = await setup();
    const second = await boards.add('b1', { title: 'Write it up' });
    await boards.change('b1', second.id, { after: task.id });
    await expect(boards.change('b1', task.id, { after: second.id })).rejects.toThrow(/round in a circle/);
    await expect(boards.change('b1', task.id, { after: task.id })).rejects.toThrow(/cannot wait for itself/);
    expect((await boards.list('b1')).find((one) => one.id === task.id)!.after).toBeUndefined();
  });
});

describe('a task that names a skill', () => {
  it('puts the skill in front of the work and counts it as used', async () => {
    const { boards, plan, task, state, used } = await setup(skillOf());
    await boards.change('b1', task.id, { assignee: 'marketing', skill: 'how-to-send-the-friday-note' });
    const opening = await plan.opening('b1', await state());
    expect(opening).toContain('How this is done here, from the playbook');
    expect(opening).toContain('Read what everybody finished');
    expect(used).toEqual(['how-to-send-the-friday-note']);
  });
});

describe('a repeat that keeps failing', () => {
  it('is said out loud once and counted quietly after that, until it works again', async () => {
    const { boards, plan, task, state, told } = await setup();
    await boards.change('b1', task.id, { assignee: 'marketing', repeat: { every: 'day', time: '09:00' } });
    await plan.failed('b1', await state(), 'Maya', 'the page would not load');
    expect(told).toEqual(['Maya could not finish | Morning numbers: the page would not load. It will keep trying on its own, quietly from now on.']);
    expect((await state()).fails).toBe(1);
    await plan.failed('b1', await state(), 'Maya', 'the page would not load');
    await plan.failed('b1', await state(), 'Maya', 'the page would not load');
    expect(told).toHaveLength(1);
    expect((await state()).fails).toBe(3);
    // The day it works, the count starts again.
    await plan.done('b1', await state(), 'Forty seven.');
    expect((await state()).fails).toBeUndefined();
  });

  it('tells the founder every time a task they started by hand fails', async () => {
    const { plan, state, told } = await setup();
    await plan.failed('b1', await state(), 'Maya', 'the page would not load');
    await plan.failed('b1', await state(), 'Maya', 'the page would not load');
    expect(told).toHaveLength(2);
    expect(told[0]).not.toContain('quietly');
  });
});

describe('a board written before any of this', () => {
  it('loads, keeps its repeat, and falls due exactly as it did', async () => {
    const dir = await folder();
    await mkdir(join(dir, 'boards'), { recursive: true });
    await writeFile(join(dir, 'boards', 'b1.json'), JSON.stringify([{
      id: 'task-old', title: 'Morning numbers', detail: '', column: 'todo', createdAt: 1,
      assignee: 'marketing', repeat: { every: 'week', time: '09:00', weekday: 1 }, nextRun: new Date('2026-09-21T09:00').getTime(),
    } satisfies Task]));
    let now = new Date('2026-09-21T08:59').getTime();
    const boards = createBoards(dir, () => now);
    expect((await boards.list('b1'))[0].repeat).toEqual({ every: 'week', time: '09:00', weekday: 1 });
    expect(await boards.due('b1')).toEqual([]);
    now = new Date('2026-09-21T09:00:30').getTime();
    expect((await boards.due('b1')).map((one) => one.id)).toEqual(['task-old']);
  });
});
