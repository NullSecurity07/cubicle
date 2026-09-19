import { mkdtemp, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardEvent } from '../shared/model.ts';
import { cleanRepeat, createBoards, nextDue } from './boards.ts';

const local = (text: string) => new Date(text).getTime();
const folder = () => mkdtemp(join(tmpdir(), 'boards-'));

describe('nextDue', () => {
  it('finds the next slot strictly after now, for every kind of repeat', () => {
    expect(nextDue({ every: 'day', time: '09:00' }, local('2026-09-19T08:00'))).toBe(local('2026-09-19T09:00'));
    expect(nextDue({ every: 'day', time: '09:00' }, local('2026-09-19T09:00'))).toBe(local('2026-09-20T09:00'));
    // 2026-09-19 is a Saturday
    expect(nextDue({ every: 'weekdays', time: '09:00' }, local('2026-09-19T08:00'))).toBe(local('2026-09-21T09:00'));
    expect(nextDue({ every: 'week', time: '18:30', weekday: 3 }, local('2026-09-19T08:00'))).toBe(local('2026-09-23T18:30'));
  });

  it('accepts only a well-formed repeat', () => {
    expect(cleanRepeat({ every: 'week', time: '07:05' })).toEqual({ every: 'week', time: '07:05', weekday: 1 });
    expect(cleanRepeat({ every: 'day', time: '9:00' })).toBeUndefined();
    expect(cleanRepeat({ every: 'hourly', time: '09:00' })).toBeUndefined();
    expect(cleanRepeat(null)).toBeUndefined();
  });
});

describe('boards', () => {
  it('keeps tasks, tells watchers about every change, and checks the founder\'s edits', async () => {
    const dir = await folder();
    const boards = createBoards(dir);
    const seen: BoardEvent[] = [];
    boards.watch('b1', (event) => seen.push(event));
    const task = await boards.add('b1', { title: '  Write launch post ', proposedBy: 'Maya', column: 'proposed' });
    expect(task).toMatchObject({ title: 'Write launch post', column: 'proposed', proposedBy: 'Maya' });
    await boards.change('b1', task.id, { column: 'todo', assignee: 'marketing', title: '', nonsense: 1, repeat: { every: 'day', time: '09:00' } });
    const [kept] = await boards.list('b1');
    expect(kept).toMatchObject({ title: 'Write launch post', column: 'todo', assignee: 'marketing', repeat: { every: 'day', time: '09:00' } });
    expect(kept.nextRun).toBeGreaterThan(Date.now());
    await expect(boards.change('b1', task.id, { assignee: '../x' })).rejects.toThrow(/bad id/);
    await expect(boards.add('b1', { title: ' ' })).rejects.toThrow(/title/);
    expect(seen.length).toBe(2);
    await boards.settled();
    expect((await createBoards(dir).list('b1'))[0].title).toBe('Write launch post');
  });

  it('moves a removed task to trash', async () => {
    const dir = await folder();
    const boards = createBoards(dir);
    const task = await boards.add('b1', { title: 'Old idea' });
    await boards.remove('b1', task.id);
    await boards.settled();
    expect(await boards.list('b1')).toEqual([]);
    expect((await readdir(join(dir, 'trash')))[0]).toContain(task.id);
  });

  it('runs a repeat that is due, marks one that fell due while the app was closed as missed, and never runs it late', async () => {
    let now = local('2026-09-21T08:59');
    const boards = createBoards(await folder(), () => now);
    const task = await boards.add('b1', { title: 'Morning numbers' });
    await boards.change('b1', task.id, { repeat: { every: 'day', time: '09:00' } });
    expect(await boards.due('b1')).toEqual([]);
    now = local('2026-09-21T09:00:20');
    expect((await boards.due('b1')).map((one) => one.id)).toEqual([task.id]);
    now = local('2026-09-21T13:00');
    expect(await boards.due('b1')).toEqual([]);
    expect((await boards.list('b1'))[0]).toMatchObject({ missed: true, nextRun: local('2026-09-22T09:00') });
  });

  it('does not believe a run that the app closing cut short', async () => {
    const dir = await folder();
    await mkdir(join(dir, 'boards'), { recursive: true });
    await writeFile(join(dir, 'boards', 'b1.json'), JSON.stringify([{ id: 't', title: 'x', detail: '', column: 'doing', createdAt: 1, run: { state: 'waiting', startedAt: 1, log: [], approval: { id: 'c', name: 'send_email', args: {} } } }]));
    const [task] = await createBoards(dir).list('b1');
    expect(task).toMatchObject({ column: 'review', run: { state: 'stopped' } });
    expect(task.run!.approval).toBeUndefined();
  });
});
