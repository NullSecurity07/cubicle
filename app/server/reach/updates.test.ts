import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Stage, Task, TaskRun } from '../../shared/model.ts';
import type { Boards } from '../boards.ts';
import { createBook } from './state.ts';
import { createUpdates, notesFor } from './updates.ts';

// Pinned time: half past three on Sunday 20 September 2026, and a run that finished at twenty past two that afternoon.
const NOW = new Date(2026, 8, 20, 15, 30).getTime();
const STARTED = new Date(2026, 8, 20, 14, 10).getTime();
const FINISHED = new Date(2026, 8, 20, 14, 20).getTime();
const LATER = 60_000;
const run = (over: Partial<TaskRun> = {}): TaskRun => ({ state: 'done', startedAt: STARTED, finishedAt: FINISHED, log: [], ...over });
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
    stage: async () => stage, book, on: async () => on, now: () => NOW,
    tell: async (note) => { told.push({ text: note.text, loud: note.loud }); },
  });
  return { updates, told, book };
}

describe('what one task has to say', () => {
  it('says who finished what, quietly, and why something fell over, out loud', () => {
    expect(notesFor(task({ run: run({ result: 'Revenue is up 4%.' }) }), 'Maya', false, NOW)).toEqual([
      { key: `run:t1:${STARTED}`, text: 'Maya finished at 14:20: the weekly numbers\n\nRevenue is up 4%.', loud: false },
    ]);
    const [failed] = notesFor(task({ run: run({ state: 'failed', log: ['failed: the spreadsheet was locked'] }) }), 'Maya', false, NOW);
    expect(failed).toEqual({ key: `run:t1:${STARTED}`, text: 'Maya could not finish at 14:20: the weekly numbers\nthe spreadsheet was locked', loud: true });
  });

  // The whole point of saying when: a founder who opens the phone on Sunday evening after two days away can tell
  // this morning's work from Friday's without asking.
  it('says today by the clock and any other day by its name', () => {
    const friday = new Date(2026, 8, 18, 9, 5).getTime();
    const [old] = notesFor(task({ run: run({ startedAt: friday - LATER, finishedAt: friday, result: 'Revenue is up 4%.' }) }), 'Maya', false, NOW);
    expect(old.text).toBe('Maya finished on Friday 18 September: the weekly numbers\n\nRevenue is up 4%.');
    const [stopped] = notesFor(task({ run: run({ state: 'stopped' }) }), 'Maya', false, NOW);
    expect(stopped.text).toBe('the weekly numbers was stopped at 14:20, before it finished.');
  });

  it('says what could not start at all, and what fell due while the app was closed', () => {
    const [blocked] = notesFor(task({ run: run({ state: 'blocked', finishedAt: undefined, result: 'did not start: nobody is assigned to it' }) }), 'Maya', false, NOW);
    expect(blocked).toMatchObject({ key: `blocked:t1:${STARTED}`, loud: true });
    expect(blocked.text).toContain('could not start at 14:10.');
    expect(blocked.text).toContain('nobody is assigned to it');
    const next = new Date(2026, 8, 21, 9, 0).getTime();
    const [missed] = notesFor(task({ missed: true, nextRun: next }), 'Maya', false, NOW);
    expect(missed).toMatchObject({ key: `missed:t1:${next}`, loud: false });
    expect(missed.text).toBe('the weekly numbers was due while the app was closed, so it did not run. It is set for next time, on Monday 21 September.');
  });

  it('says a repeat that keeps failing once, then nothing, then that it is working again', () => {
    const repeat = { every: 'day', time: '09:00' } as const;
    const [second] = notesFor(task({ repeat, fails: 2, run: run({ state: 'failed', log: ['failed: no answer'] }) }), 'Maya', false, NOW);
    expect(second.text).toContain('That is 2 times in a row');
    expect(notesFor(task({ repeat, fails: 3, run: run({ state: 'failed' }) }), 'Maya', true, NOW)).toEqual([]);
    expect(notesFor(task({ repeat, run: run() }), 'Maya', true, NOW)[0].text).toBe('Maya finished the weekly numbers at 14:20 — it is working again.');
  });
});

describe('telling the founder without being asked', () => {
  it('says nothing about what was already over when it started, and everything after that', async () => {
    const tasks = [task({ run: run({ result: 'done and dusted' }) })];
    const { updates, told } = bench(tasks);
    await updates.look();
    expect(told).toEqual([]);
    tasks.push(task({ id: 't2', title: 'the launch note', run: run({ startedAt: STARTED + LATER, finishedAt: FINISHED + LATER, result: 'here it is' }) }));
    await updates.look();
    expect(told.map((one) => one.text)).toEqual(['Maya finished at 14:21: the launch note\n\nhere it is']);
  });

  it('sends each one once, however often the board changes', async () => {
    const tasks = [task({ run: run() })];
    const { updates, told } = bench(tasks);
    await updates.look();
    tasks.push(task({ id: 't2', title: 'the launch note', run: run({ startedAt: STARTED + LATER }) }));
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
    tasks.push(task({ id: 't2', title: 'the launch note', run: run({ startedAt: STARTED + LATER }) }));
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
    tasks.push(task({ id: 't2', title: 'the launch note', run: run({ startedAt: STARTED + LATER }) }));
    await updates.look();
    expect(told).toHaveLength(1);
    await book.settled();
    // The app closes and starts again: what was said is on disk, and is not said a second time.
    const after = createBook(dir);
    expect(await after.told(`run:t2:${STARTED + LATER}`)).toBe(true);
    expect(await after.told(`run:t1:${STARTED}`)).toBe(true);
  });
});
