import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Attention, Stage, Task } from '../../shared/model.ts';
import { AGE_MOST, gather, rank, readWaved, wave, WEIGHTS, type Signal } from './rank.ts';

const NOW = new Date('2026-09-25T08:00').getTime();
const DAY = 86_400_000;
const signal = (id: string, kind: string, daysAgo: number, extra: Partial<Signal> = {}): Signal => ({ id, kind, title: id, at: NOW - daysAgo * DAY, ...extra });

describe('rank', () => {
  it('puts a person waiting on an OK first, then money, then a lead, and keeps only five', () => {
    const five = rank([
      signal('source', 'proposed-source', 0), signal('lead', 'lead-stale', 0), signal('ok', 'approval', 0, { who: 'Maya' }),
      signal('cash', 'runway-low', 0), signal('number', 'metric-alert', 0), signal('decide', 'proposed-decision', 0), signal('page', 'page-changed', 0),
    ], NOW);
    expect(five.map((one) => one.id)).toEqual(['ok', 'cash', 'lead', 'number', 'decide']);
    expect(five[0]).toMatchObject({ title: 'Maya needs your OK: ok', score: WEIGHTS.approval.weight });
  });

  it('says a question put to the founder is a question, not an OK', async () => {
    expect(rank([signal('Which fit?', 'approval', 0, { who: 'Priya', question: true })], NOW)[0].title).toBe('Priya asks you: Which fit?');
    const needs = [{ id: 'approval:ask-1', kind: 'approval', title: 'Which fit?', at: NOW, who: 'Priya', event: { id: 'ask-1', name: 'ask_founder', args: {}, choices: ['Lived it'] } }] as Attention[];
    const [found] = await gather({ attention: { list: async () => needs }, boards: { list: async () => [] }, stage: async () => ({ rooms: [], docs: [], wires: [], cards: [] }) }, NOW);
    expect(rank([found], NOW)[0].title).toBe('Priya asks you: Which fit?');
  });

  it('adds a little for every day waited, capped, so an old item climbs past a slightly heavier new one', () => {
    const [first, second] = rank([signal('fresh', 'metric-alert', 0), signal('old', 'lead-stale', 3)], NOW);
    expect(first).toMatchObject({ id: 'old', score: 75 + 15 });
    expect(first.why).toBe('First of today\'s 5: "A lead is waiting on you" weighs 75, plus 15 for waiting 3 days. A fixed table ranks these; no model picks them.');
    expect(first.reason).toBe('A lead is waiting on you · waiting 3 days');
    expect(second.reason).toBe('A number to look at · new today');
    expect(second.score).toBe(70);
    expect(rank([signal('ancient', 'page-changed', 400)], NOW)[0].score).toBe(25 + AGE_MOST);
  });

  it('breaks ties by what waited longer, then by id, so the same inputs give the same order', () => {
    const order = rank([signal('b', 'metric-alert', 1), signal('a', 'metric-alert', 1), signal('c', 'metric-alert', 1.5)], NOW).map((one) => one.id);
    expect(order).toEqual(['c', 'a', 'b']);
  });

  it('leaves out what was dismissed today, lets a lapsed question sink, and gives an unknown kind the default weight', () => {
    const items = rank([signal('ok', 'approval', 0, { lapsed: true }), signal('new-kind', 'something-new', 0), signal('gone', 'runway-low', 0)], NOW, new Set(['gone']));
    expect(items.map((one) => [one.id, one.score])).toEqual([['new-kind', 20], ['ok', 15]]);
  });

  it('says a task falling due by its time, and carries the ids that open its place', () => {
    const [task] = rank([signal('task-due:t1:1', 'task-due', -0.1, { title: 'Weekly numbers', who: 'Dev', cardId: 'board-1', taskId: 't1' })], NOW);
    expect(task.reason).toMatch(/^Due today · Dev · at \d\d:\d\d/);
    expect(task).toMatchObject({ cardId: 'board-1', taskId: 't1' });
  });
});

describe('gather and the day\'s dismissals', () => {
  it('reads Needs you and today\'s repeats, and does not count a task twice', async () => {
    const stage = { rooms: [{ id: 'build', name: 'Dev' }], docs: [], wires: [], cards: [{ id: 'board-1', kind: 'board' }] } as unknown as Stage;
    const tasks = [
      { id: 't1', title: 'Weekly numbers', column: 'todo', createdAt: 0, detail: '', assignee: 'build', repeat: { every: 'day', time: '09:00' }, nextRun: NOW + 3_600_000 },
      { id: 't2', title: 'Missed one', column: 'todo', createdAt: 0, detail: '', repeat: { every: 'day', time: '07:00' }, nextRun: NOW - 3_600_000, missed: true },
      { id: 't3', title: 'Tomorrow', column: 'todo', createdAt: 0, detail: '', repeat: { every: 'day', time: '09:00' }, nextRun: NOW + DAY },
    ] as Task[];
    const needs = [{ id: 'missed:t2:1', kind: 'missed', title: 'Missed one', at: NOW - DAY, taskId: 't2', cardId: 'board-1' }] as Attention[];
    const signals = await gather({ attention: { list: async () => needs }, boards: { list: async () => tasks }, stage: async () => stage }, NOW);
    expect(signals.map((one) => [one.id, one.kind, one.who])).toEqual([['missed:t2:1', 'missed', undefined], [`task-due:t1:${NOW + 3_600_000}`, 'task-due', 'Dev']]);
  });

  it('forgets what was dismissed when the day turns', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'today-'));
    await wave(workspace, 'one', NOW);
    expect([...await readWaved(workspace, NOW + 3_600_000)]).toEqual(['one']);
    expect([...await readWaved(workspace, NOW + DAY)]).toEqual([]);
  });
});
