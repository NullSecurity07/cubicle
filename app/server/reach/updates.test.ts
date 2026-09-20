import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Stage, Task, TaskRun } from '../../shared/model.ts';
import type { Boards } from '../boards.ts';
import { createBook } from './state.ts';
import { createUpdates, notesFor } from './updates.ts';

const run = (over: Partial<TaskRun> = {}): TaskRun => ({ state: 'done', startedAt: 1000, finishedAt: 2000, log: [], ...over });
const task = (over: Partial<Task> = {}): Task => ({ id: 't1', title: 'the weekly numbers', detail: '', column: 'done', createdAt: 0, assignee: 'marketing', ...over });
const stage: Stage = {
  rooms: [{ id: 'marketing', name: 'Maya', role: 'x', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }],
  docs: [], wires: [], cards: [{ kind: 'board', id: 'board', x: 0, y: 0, w: 1, h: 1 }],
};

function bench(tasks: Task[], on = { finished: true, stuck: true }) {
  const book = createBook(mkdtempSync(join(tmpdir(), 'reach-up-')));
  const told: { text: string; loud: boolean }[] = [];
  const updates = createUpdates({
    boards: { list: async () => tasks, onChange: () => () => {} } as unknown as Boards,
    stage: async () => stage, book, on: async () => on,
    tell: async (note) => { told.push({ text: note.text, loud: note.loud }); },
  });
  return { updates, told, book };
}

describe('what one task has to say', () => {
  it('says who finished what, quietly, and why something fell over, out loud', () => {
    expect(notesFor(task({ run: run({ result: 'Revenue is up 4%.' }) }), 'Maya', false)).toEqual([
      { key: 'run:t1:1000', text: 'Maya finished: the weekly numbers\n\nRevenue is up 4%.', loud: false },
    ]);
    const [failed] = notesFor(task({ run: run({ state: 'failed', log: ['failed: the spreadsheet was locked'] }) }), 'Maya', false);
    expect(failed).toEqual({ key: 'run:t1:1000', text: 'Maya could not finish: the weekly numbers\nthe spreadsheet was locked', loud: true });
  });

  it('says what could not start at all, and what fell due while the app was closed', () => {
    const [blocked] = notesFor(task({ run: run({ state: 'blocked', finishedAt: undefined, result: 'did not start: nobody is assigned to it' }) }), 'Maya', false);
    expect(blocked).toMatchObject({ key: 'blocked:t1:1000', loud: true });
    expect(blocked.text).toContain('nobody is assigned to it');
    const [missed] = notesFor(task({ missed: true, nextRun: 500 }), 'Maya', false);
    expect(missed).toMatchObject({ key: 'missed:t1:500', loud: false });
  });

  it('says a repeat that keeps failing once, then nothing, then that it is working again', () => {
    const repeat = { every: 'day', time: '09:00' } as const;
    const [second] = notesFor(task({ repeat, fails: 2, run: run({ state: 'failed', log: ['failed: no answer'] }) }), 'Maya', false);
    expect(second.text).toContain('That is 2 times in a row');
    expect(notesFor(task({ repeat, fails: 3, run: run({ state: 'failed' }) }), 'Maya', true)).toEqual([]);
    expect(notesFor(task({ repeat, run: run() }), 'Maya', true)[0].text).toBe('Maya finished the weekly numbers — it is working again.');
  });
});

describe('telling the founder without being asked', () => {
  it('says nothing about what was already over when it started, and everything after that', async () => {
    const tasks = [task({ run: run({ result: 'done and dusted' }) })];
    const { updates, told } = bench(tasks);
    await updates.look();
    expect(told).toEqual([]);
    tasks.push(task({ id: 't2', title: 'the launch note', run: run({ startedAt: 3000, finishedAt: 4000, result: 'here it is' }) }));
    await updates.look();
    expect(told.map((one) => one.text)).toEqual(['Maya finished: the launch note\n\nhere it is']);
  });

  it('sends each one once, however often the board changes', async () => {
    const tasks = [task({ run: run() })];
    const { updates, told } = bench(tasks);
    await updates.look();
    tasks.push(task({ id: 't2', title: 'the launch note', run: run({ startedAt: 3000 }) }));
    await updates.look();
    await updates.look();
    await updates.look();
    expect(told).toHaveLength(1);
  });

  it('leaves the founder alone about a switch they turned off, and does not unpack it later', async () => {
    const tasks = [task({ run: run() })];
    const on = { finished: false, stuck: true };
    const { updates, told } = bench(tasks, on);
    await updates.look();
    tasks.push(task({ id: 't2', title: 'the launch note', run: run({ startedAt: 3000 }) }));
    await updates.look();
    expect(told).toEqual([]);
    on.finished = true;
    await updates.look();
    expect(told).toEqual([]);
  });

  it('writes down what it has said, so a restart does not send it all again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reach-up-'));
    const tasks = [task({ run: run() })];
    const book = createBook(dir);
    const told: string[] = [];
    const updates = createUpdates({
      boards: { list: async () => tasks, onChange: () => () => {} } as unknown as Boards,
      stage: async () => stage, book, on: async () => ({ finished: true, stuck: true }),
      tell: async (note) => { told.push(note.text); },
    });
    await updates.look();
    tasks.push(task({ id: 't2', title: 'the launch note', run: run({ startedAt: 3000 }) }));
    await updates.look();
    expect(told).toHaveLength(1);
    await book.settled();
    // The app closes and starts again: what was said is on disk, and is not said a second time.
    const after = createBook(dir);
    expect(await after.told('run:t2:3000')).toBe(true);
    expect(await after.told('run:t1:1000')).toBe(true);
  });
});
