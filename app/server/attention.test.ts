import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Attention } from '../shared/model.ts';
import { boardAttention, createAttention } from './attention.ts';
import { createBoards } from './boards.ts';
import { createStore } from './store.ts';

const waiting = (id: string): Attention => ({ id: `approval:${id}`, kind: 'approval', title: 'Send this email?', at: 1, roomId: 'marketing', who: 'Maya', event: { id, name: 'send_email', args: { to: 'a@b.co' }, waiting: true } });

describe('attention', () => {
  it('keeps everything raised in the first moment, when several ask before the file has been read', async () => {
    const attention = createAttention(await mkdtemp(join(tmpdir(), 'attention-')));
    await Promise.all([attention.raise(waiting('c1')), attention.list(), attention.raise(waiting('c2')), attention.list()]);
    expect((await attention.list()).map((one) => one.id).sort()).toEqual(['approval:c1', 'approval:c2']);
  });

  it('holds an approval while it waits and lets it go when the founder answers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const attention = createAttention(dir);
    const seen: number[] = [];
    attention.watch((list) => seen.push(list.length));
    await attention.raise(waiting('c1'));
    expect((await attention.list()).map((one) => one.id)).toEqual(['approval:c1']);
    await attention.clear('approval:c1');
    expect(await attention.list()).toEqual([]);
    expect(seen).toEqual([1, 0]);
  });

  it('an approval whose turn ended with the app comes back as lapsed, until the founder lets it go', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const before = createAttention(dir);
    await before.raise(waiting('c2'));
    await before.settled();
    expect(JSON.parse(await readFile(join(dir, 'attention.json'), 'utf8')).open).toHaveLength(1);

    const after = createAttention(dir);
    const [entry] = await after.list();
    expect(entry).toMatchObject({ id: 'approval:c2', lapsed: true, who: 'Maya' });
    expect(entry.event).toBeUndefined();
    await after.dismiss('approval:c2');
    await after.settled();
    expect(await createAttention(dir).list()).toEqual([]);
  });

  it('adds what other parts of the app report, newest first, and hides what the founder dismissed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const attention = createAttention(dir);
    let failedAt = 5;
    attention.source(async () => [
      { id: 'proposed:b1:t1', kind: 'proposed-task', title: 'Draft the launch post', at: 3, cardId: 'b1', taskId: 't1', who: 'Maya' },
      { id: `run-failed:t2:${failedAt}`, kind: 'run-failed', title: 'Weekly numbers', at: failedAt, cardId: 'b1', taskId: 't2' },
    ]);
    await attention.raise(waiting('c3'));
    expect((await attention.list()).map((one) => one.id)).toEqual(['run-failed:t2:5', 'proposed:b1:t1', 'approval:c3']);

    await attention.dismiss('run-failed:t2:5');
    expect((await attention.list()).map((one) => one.kind)).toEqual(['proposed-task', 'approval']);
    // The same task failing again is a new thing to look at.
    failedAt = 9;
    expect((await attention.list())[0].id).toBe('run-failed:t2:9');
    // A proposal cannot be waved away; it goes when the founder accepts or declines it on the board.
    await expect(attention.dismiss('proposed:b1:t1')).rejects.toThrow();
  });

  it('a source that breaks does not take the list down with it', async () => {
    const attention = createAttention(await mkdtemp(join(tmpdir(), 'attention-')));
    attention.source(async () => { throw new Error('board file is broken'); });
    await attention.raise(waiting('c4'));
    expect(await attention.list()).toHaveLength(1);
  });

  it('reads proposals, failed runs and missed repeats straight from the boards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const store = createStore(dir); const boards = createBoards(dir);
    const stage = await store.loadStage();
    await store.saveStage({ ...stage, cards: [{ id: 'b1', kind: 'board', x: 0, y: 0, w: 900, h: 400 }] });
    const attention = createAttention(dir);
    attention.source(boardAttention(store, boards));
    const told: number[] = [];
    attention.watch((list) => told.push(list.length));
    boards.onChange(() => { void attention.refresh(); });

    const proposed = await boards.add('b1', { title: 'Draft the launch post', column: 'proposed', proposedBy: 'Maya' });
    const failing = await boards.add('b1', { title: 'Weekly numbers' });
    await boards.update('b1', failing.id, (task) => { task.assignee = 'build'; task.run = { state: 'failed', startedAt: 7, finishedAt: 8, log: ['Dev started', 'failed: no provider answered'] }; });
    const late = await boards.add('b1', { title: 'Morning digest' });
    await boards.update('b1', late.id, (task) => { task.missed = true; task.nextRun = 99; });

    // A task that could not even start waits for the founder too, with the reason it gave.
    const stuck = await boards.add('b1', { title: 'Nightly tidy-up' });
    await boards.update('b1', stuck.id, (task) => { task.run = { state: 'blocked', startedAt: 11, finishedAt: 11, log: ['did not start: the skill it names is switched off'], result: 'the skill it names is switched off' }; });

    const list = await attention.list();
    expect(list.map((one) => one.kind).sort()).toEqual(['missed', 'proposed-task', 'run-failed', 'run-failed']);
    expect(list.find((one) => one.taskId === stuck.id)).toMatchObject({ kind: 'run-failed', title: 'Nightly tidy-up', detail: 'the skill it names is switched off' });
    expect(list.find((one) => one.kind === 'proposed-task')).toMatchObject({ who: 'Maya', cardId: 'b1', taskId: proposed.id, title: 'Draft the launch post' });
    expect(list.find((one) => one.taskId === failing.id)).toMatchObject({ who: 'Dev', detail: 'no provider answered' });

    // The founder accepts the proposal on the board: it leaves the list by itself.
    await boards.change('b1', proposed.id, { column: 'todo' });
    expect((await attention.list()).map((one) => one.kind).sort()).toEqual(['missed', 'run-failed', 'run-failed']);
    await new Promise((done) => setTimeout(done, 20));
    expect(told.at(-1)).toBe(3);
    // A board that left the stage takes its entries with it.
    await store.saveStage({ ...(await store.loadStage()), cards: [] });
    expect(await attention.list()).toEqual([]);
  });

  it('does not show a cut-off task run twice: the board already reports it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'attention-'));
    const before = createAttention(dir);
    await before.raise({ ...waiting('c5'), kind: 'run-approval', cardId: 'b1', taskId: 't1' });
    await before.settled();
    expect(await createAttention(dir).list()).toEqual([]);
  });
});
