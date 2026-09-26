import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catchUp, cleanRepeat, nextDue } from '../shared/automation.ts';
import { COLUMNS, type BoardEvent, type Column, type Task } from '../shared/model.ts';
import { automate } from './automation/fields.ts';

export type Boards = ReturnType<typeof createBoards>;
const GRACE = 10 * 60_000;
const safe = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`); return id; };
const newId = () => `task-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// What a schedule means in time, and what a founder's sentence means at all, both live in `shared/automation.ts`:
// the field on the board and the server read one sentence exactly the same way.
export { cleanRepeat, nextDue };

// Tasks live beside the stage, one file per board card. The server owns them: runs and proposals change them while
// the founder's window only asks for changes. Every change is pushed to whoever watches the board.
export function createBoards(dir: string, now: () => number = Date.now) {
  const path = (boardId: string) => join(dir, 'boards', `${safe(boardId)}.json`);
  const cache = new Map<string, Task[]>();
  const watchers = new Map<string, Set<(event: BoardEvent) => void>>();
  const listeners = new Set<() => void>();
  // Whoever carries every board at once (the window's one feed) rather than picking a board to watch.
  const all = new Set<(boardId: string, event: BoardEvent) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  function shout(boardId: string, event: BoardEvent) {
    for (const tell of watchers.get(boardId) ?? []) tell(event);
    for (const tell of all) tell(boardId, event);
  }

  async function load(boardId: string): Promise<Task[]> {
    const known = cache.get(boardId);
    if (known) return known;
    let tasks: Task[] = [];
    try { tasks = JSON.parse(await readFile(path(boardId), 'utf8')); } catch { /* a new board */ }
    // A run cut short by the app closing cannot still be running.
    for (const task of tasks) if (task.run && (task.run.state === 'running' || task.run.state === 'waiting')) { task.run = { ...task.run, state: 'stopped', finishedAt: now(), approval: undefined, log: [...task.run.log, 'stopped: the app was closed'] }; task.column = 'review'; }
    cache.set(boardId, tasks);
    return tasks;
  }
  function save(boardId: string) {
    const text = JSON.stringify(cache.get(boardId) ?? [], null, 2);
    queue = queue.then(async () => { await mkdir(join(dir, 'boards'), { recursive: true }); await writeFile(`${path(boardId)}.tmp`, text); await rename(`${path(boardId)}.tmp`, path(boardId)); }).catch(() => {});
    shout(boardId, { tasks: cache.get(boardId) ?? [] });
    for (const tell of listeners) tell();
  }

  return {
    settled: () => queue,
    list: load,
    // Any change on any board, for whoever keeps a view across all of them.
    onChange(tell: () => void) { listeners.add(tell); return () => { listeners.delete(tell); }; },
    async add(boardId: string, input: { title: string; detail?: string; column?: Column; proposedBy?: string; due?: string }): Promise<Task> {
      const title = input.title.trim().slice(0, 200);
      if (!title) throw new Error('a task needs a title');
      const due = typeof input.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.due) ? input.due : undefined;
      const task: Task = { id: newId(), title, detail: (input.detail ?? '').trim().slice(0, 4000), column: input.column ?? 'todo', createdAt: now(), ...(input.proposedBy ? { proposedBy: input.proposedBy } : {}), ...(due ? { due } : {}) };
      (await load(boardId)).push(task);
      save(boardId);
      return task;
    },
    // The founder's edits. Only known fields, each checked; a repeat sets the next due time.
    async change(boardId: string, taskId: string, patch: Record<string, unknown>): Promise<Task> {
      const tasks = await load(boardId);
      const task = tasks.find((one) => one.id === taskId);
      if (!task) throw new Error('unknown task');
      if (typeof patch.title === 'string' && patch.title.trim()) task.title = patch.title.trim().slice(0, 200);
      if (typeof patch.detail === 'string') task.detail = patch.detail.slice(0, 4000);
      if (typeof patch.column === 'string' && (COLUMNS as readonly string[]).includes(patch.column)) task.column = patch.column as Column;
      if ('assignee' in patch) task.assignee = typeof patch.assignee === 'string' && patch.assignee ? safe(patch.assignee) : undefined;
      if ('repeat' in patch) { task.repeat = cleanRepeat(patch.repeat); task.nextRun = task.repeat ? nextDue(task.repeat, now()) : undefined; task.missed = undefined; }
      // The rest of what a task can do by itself: a script, a skill, what it waits for, what a missed run means here.
      automate(task, patch, tasks);
      save(boardId);
      return task;
    },
    // Used by runs: any field, no checks.
    async update(boardId: string, taskId: string, change: (task: Task) => void) {
      const task = (await load(boardId)).find((one) => one.id === taskId);
      if (!task) return;
      change(task);
      save(boardId);
    },
    async remove(boardId: string, taskId: string) {
      const tasks = await load(boardId);
      const index = tasks.findIndex((one) => one.id === taskId);
      if (index < 0) return;
      const [gone] = tasks.splice(index, 1);
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      queue = queue.then(async () => { await mkdir(join(dir, 'trash'), { recursive: true }); await writeFile(join(dir, 'trash', `${stamp}-${gone.id}.json`), JSON.stringify(gone, null, 2)); }).catch(() => {});
      save(boardId);
    },
    // Repeating tasks that are due now. One that fell due while the app was closed is marked missed and never run
    // late; whether it is then caught up once on return is the task's own choice.
    async due(boardId: string): Promise<Task[]> {
      const ready: Task[] = [];
      let changed = false;
      for (const task of await load(boardId)) {
        if (!task.repeat || !task.nextRun || task.nextRun > now()) continue;
        const late = now() - task.nextRun > GRACE;
        if (late) { task.missed = true; task.nextRun = nextDue(task.repeat, now()); changed = true; }
        if (task.run?.state === 'running' || task.run?.state === 'waiting') continue;
        // However many were missed, one run makes up for them: what was wanted is today's answer, not five old ones.
        if (!late || catchUp(task.repeat, task.onMissed)) ready.push(task);
      }
      if (changed) save(boardId);
      return ready;
    },
    watch(boardId: string, tell: (event: BoardEvent) => void) {
      const set = watchers.get(boardId) ?? new Set();
      watchers.set(boardId, set);
      set.add(tell);
      return () => { set.delete(tell); };
    },
    // Every board at once, named as it speaks: a board card put on the stage later needs nobody to subscribe to it.
    watchAll(tell: (boardId: string, event: BoardEvent) => void) { all.add(tell); return () => { all.delete(tell); }; },
    tell(boardId: string, event: BoardEvent) { shout(boardId, event); },
  };
}
