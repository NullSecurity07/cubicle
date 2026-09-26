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
const plan = { id: 'plan-1', at: 5, who: 'Sam', roomId: 'sam', title: '2-week plan', steps: stepsFrom(['Day 1: draft the page', '- post in r/SaaS', 'Mon 5 Oct – email 20 leads', '4', '5', '6']) };

describe('a plan as tasks', () => {
  it('reads steps a person hands over, keeping a day written at the front', () => {
    expect(plan.steps.slice(0, 3)).toEqual([{ day: 'Day 1', text: 'draft the page' }, { text: 'post in r/SaaS' }, { day: 'Mon 5 Oct', text: 'email 20 leads' }]);
  });

  it('asks the founder once, naming how many and the first few', () => {
    expect(planAttention([plan])).toEqual([{ id: 'proposed-plan:plan-1', kind: 'proposed-plan', at: 5, who: 'Sam', roomId: 'sam', title: 'Add these 6 tasks to the board? (2-week plan)', detail: 'Day 1: draft the page; post in r/SaaS; Mon 5 Oct: email 20 leads; 4; and 2 more.' }]);
  });

  it('puts every step on the board wired to the writer, as tasks to do, and refuses with no board', async () => {
    expect(boardFor(stage, 'sam')).toBe('board-b');
    expect(boardFor({ ...stage, wires: [] }, 'sam')).toBe('board-a');
    const boards = createBoards(await mkdtemp(join(tmpdir(), 'plans-')));
    expect(await addPlan(boards, stage, plan)).toEqual({ boardId: 'board-b', added: 6 });
    const tasks = await boards.list('board-b');
    expect(tasks.map((task) => [task.title, task.column])).toEqual([['Day 1: draft the page', 'todo'], ['post in r/SaaS', 'todo'], ['Mon 5 Oct: email 20 leads', 'todo'], ['4', 'todo'], ['5', 'todo'], ['6', 'todo']]);
    expect(tasks[0].detail).toBe('From the plan "2-week plan", written by Sam.');
    await expect(addPlan(boards, { ...stage, cards: [] }, plan)).rejects.toThrow('There is no task board on the stage yet');
  });
});
