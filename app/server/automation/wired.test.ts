import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApprovals } from '../approvals.ts';
import { createBoards } from '../boards.ts';
import { buildMessages } from '../prompt.ts';
import type { ModelClient } from '../providers.ts';
import { createRuns } from '../runs.ts';
import type { Skills } from '../skills.ts';
import { createStore } from '../store.ts';
import { createUsage } from '../usage.ts';
import { createAutomation, fillAutomation, HANDOVER } from './run.ts';

// The run path with automation installed, which is how the founder meets all of this: the Run button and the tick go
// through `runs.start`, and everything the board does by itself has to happen there or it does not happen.
const until = async (check: () => Promise<boolean>) => { for (let at = 0; at < 600; at += 1) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timed out'); };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'wired-'));
  const store = createStore(dir);
  const boards = createBoards(dir);
  const asked: string[] = [];
  const told: string[] = [];
  const client: ModelClient = { name: 's', model: 's-1', maxPromptChars: Infinity, tools: true, limits: {}, async step(messages, { onToken }) {
    asked.push(String(messages.at(-1)?.content ?? ''));
    onToken('Forty seven people came by.');
    return { text: '', calls: [], usage: { input: 5, output: 5 } };
  } };
  const skills = { get: async () => undefined, used: async () => undefined } as unknown as Skills;
  const runs = createRuns({
    boards, store, approvals: createApprovals(), busy: new Set<string>(), clients: [client], usage: createUsage(null), tools: [],
    notify: (title, body) => told.push(`${title} | ${body}`),
    promptFor: async (stage, roomId, names, fresh) => buildMessages(stage, roomId, {}, fresh ? [] : [], names),
  });
  fillAutomation(createAutomation({ boards, filesDir: join(dir, 'files'), skills, clients: [client], notify: (title, body) => told.push(`${title} | ${body}`), runs }));
  const state = async (id: string) => (await boards.list('b1')).find((one) => one.id === id)!;
  return { boards, runs, state, asked, told };
}
afterEach(() => fillAutomation(null));

describe('a board that gets on with it', () => {
  it('runs a script task with nobody on it and no model asked a thing', async () => {
    const { boards, runs, state, asked } = await setup();
    const task = await boards.add('b1', { title: 'Count the files' });
    await boards.change('b1', task.id, { script: { language: 'javascript', code: "console.log('three files');" } });
    await runs.start('b1', task.id);
    await until(async () => (await state(task.id)).run?.state === 'done');
    expect(await state(task.id)).toMatchObject({ column: 'review', run: { result: 'three files' } });
    expect(asked).toEqual([]);
  });

  it('holds a task up before a model is asked, and says why on the card', async () => {
    const { boards, runs, state, asked } = await setup();
    const task = await boards.add('b1', { title: 'Write the Friday note' });
    await boards.change('b1', task.id, { assignee: 'marketing', skill: 'how-to-send-the-friday-note' });
    await expect(runs.start('b1', task.id)).rejects.toThrow(/not in the playbook any more/);
    expect((await state(task.id)).run).toMatchObject({ state: 'blocked' });
    expect(asked).toEqual([]);
  });

  it('starts the next task in a chain when the first is done, with what it came back with as material', async () => {
    const { boards, runs, state, asked } = await setup();
    const first = await boards.add('b1', { title: 'Morning numbers' });
    const second = await boards.add('b1', { title: 'Write it up' });
    await boards.change('b1', first.id, { assignee: 'marketing' });
    await boards.change('b1', second.id, { assignee: 'marketing', after: first.id });
    await runs.start('b1', first.id);
    await until(async () => (await state(second.id)).run?.state === 'done');
    expect((await state(first.id)).run?.state).toBe('done');
    // The same person did both, one after the other: the chain waits for them to be free rather than falling over.
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain(HANDOVER);
    expect(asked[1]).toContain('Forty seven people came by.');
    expect((await state(second.id)).run!.log).toContain('after "Morning numbers"');
  });

  // Today's date is already in every person's instructions. What a repeat is missing is the other end of the stretch:
  // without it "this week's signups" is a question nobody can answer twice the same way.
  it('tells a repeating task where last time was, and says nothing of the sort the first time it runs', async () => {
    const { boards, runs, state, asked } = await setup();
    const task = await boards.add('b1', { title: "This week's signups" });
    await boards.change('b1', task.id, { assignee: 'marketing', repeat: { every: 'day', time: '09:00' } });
    await runs.start('b1', task.id);
    await until(async () => (await state(task.id)).run?.state === 'done');
    expect(asked[0]).not.toContain('This task repeats');

    const ran = new Date(2026, 8, 18, 9, 0).getTime();
    await boards.update('b1', task.id, (one) => { one.run = { state: 'done', startedAt: ran, finishedAt: ran + 5 * 60_000, log: [] }; });
    await runs.start('b1', task.id);
    await until(async () => (await state(task.id)).run?.startedAt !== ran);
    expect(asked[1]).toContain('This task repeats; it last ran on Friday, 18 September 2026 and finished at 09:05.');
  });
});
