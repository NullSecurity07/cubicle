import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Stage } from '../../shared/model.ts';
import { createBoards } from '../boards.ts';
import { addPlan, boardFor, planAttention, stepsFrom } from './plans.ts';

const stage: Stage = {
  rooms: [{ id: 'sam', name: 'Sam', role: 'x', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }], docs: [],
  cards: [{ id: 'board-a', kind: 'board', x: 0, y: 0, w: 1, h: 1 }, { id: 'board-b', kind: 'board', x: 0, y: 0, w: 1, h: 1 }],
  wires: [{ id: 'w', from: 'sam', fromHandle: 'r', to: 'board-b', toHandle: 'l' }],
};
const plan = { id: 'plan-1', at: new Date('2026-09-26T09:00').getTime(), who: 'Sam', roomId: 'sam', title: '2-week plan', steps: stepsFrom(['Day 1: draft the page', '- post in r/SaaS', 'Mon 5 Oct – email 20 leads', '4', '5', '6']) };
const SAT = new Date('2026-09-26T10:00').getTime();

describe('a plan as tasks', () => {
  it('reads steps a person hands over, keeping a day written at the front', () => {
    expect(plan.steps.slice(0, 3)).toEqual([{ day: 'Day 1', text: 'draft the page' }, { text: 'post in r/SaaS' }, { day: 'Mon 5 Oct', text: 'email 20 leads' }]);
  });

  it('asks the founder once, naming how many and the first few', () => {
    expect(planAttention([plan])).toEqual([{ id: 'proposed-plan:plan-1', kind: 'proposed-plan', at: plan.at, who: 'Sam', roomId: 'sam', title: 'Add these 6 tasks to the board? (2-week plan)', detail: 'Day 1: draft the page; post in r/SaaS; Mon 5 Oct: email 20 leads; 4; and 2 more.' }]);
  });

  it('puts every step on the board wired to the writer, as tasks to do, and refuses with no board', async () => {
    expect(boardFor(stage, 'sam')).toBe('board-b');
    expect(boardFor({ ...stage, wires: [] }, 'sam')).toBe('board-a');
    const boards = createBoards(await mkdtemp(join(tmpdir(), 'plans-')));
    expect(await addPlan(boards, stage, plan, SAT)).toEqual({ boardId: 'board-b', added: 6 });
    const tasks = await boards.list('board-b');
    // "Day 1" is the day the plan was written: dated, so the label leaves the title.
    expect(tasks.map((task) => [task.title, task.column])).toEqual([['draft the page', 'todo'], ['post in r/SaaS', 'todo'], ['email 20 leads', 'todo'], ['4', 'todo'], ['5', 'todo'], ['6', 'todo']]);
    expect(tasks[0].detail).toBe('From the plan "2-week plan", written by Sam.');
    expect(tasks.map((task) => task.due)).toEqual(['2026-09-26', undefined, '2026-10-05', undefined, undefined, undefined]);
    await expect(addPlan(boards, { ...stage, cards: [] }, plan)).rejects.toThrow('There is no task board on the stage yet');
  });

  it('puts a dated step on the board by its words alone, dated, and keeps the whole step in the detail when the title is cut', async () => {
    const boards = createBoards(await mkdtemp(join(tmpdir(), 'plans-')));
    const long = 'Set up a dead-simple, free static landing page listing 10 hand-picked abandoned SaaS projects under $5k for indie hackers';
    await addPlan(boards, stage, { ...plan, steps: [{ day: 'Sep 26', text: long }, { day: 'Sep 28', text: 'Email 20 leads' }] }, SAT);
    const [first, second] = await boards.list('board-b');
    expect(first.title.length).toBeLessThanOrEqual(80);
    expect(first.title.startsWith('Set up a dead-simple')).toBe(true);
    expect(first.due).toBe('2026-09-26');
    expect(first.detail).toBe(`${long}\n\nFrom the plan "2-week plan", written by Sam.`);
    expect([second.title, second.due, second.detail]).toEqual(['Email 20 leads', '2026-09-28', 'From the plan "2-week plan", written by Sam.']);
  });
});
