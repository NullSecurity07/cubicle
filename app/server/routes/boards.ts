import type { createBoards } from '../boards.ts';
import { answer, body, openFeed, type Route } from '../http.ts';
import type { Store } from '../store.ts';
import type { Learn } from './work.ts';

// A board card's tasks, and the runs that do them.
export function boardRoutes(deps: { store: Store; boards: ReturnType<typeof createBoards>; runs: { start(boardId: string, taskId: string): Promise<unknown>; stop(taskId: string): void }; learn: Learn }): Route {
  const { store, boards, runs, learn } = deps;
  return async (req, res, path) => {
    const board = /^\/api\/boards\/([^/]+)(?:\/(events|tasks)(?:\/([^/]+)(?:\/(run|stop|learn))?)?)?$/.exec(path);
    if (board) {
      const [, boardId, part, taskId, action] = board;
      if (!(await store.loadStage()).cards?.some((card) => card.id === boardId && card.kind === 'board')) return answer(res, 404, { error: 'unknown board' });
      if (!part && req.method === 'GET') return answer(res, 200, await boards.list(boardId));
      if (part === 'events' && req.method === 'GET') {
        openFeed(res);
        const tell = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        tell({ tasks: await boards.list(boardId) });
        res.on('close', boards.watch(boardId, tell));
        return true;
      }
      if (part === 'tasks' && !taskId && req.method === 'POST') return answer(res, 200, await boards.add(boardId, await body(req)));
      if (taskId && !action && req.method === 'PATCH') return answer(res, 200, await boards.change(boardId, taskId, await body(req)));
      if (taskId && !action && req.method === 'DELETE') { runs.stop(taskId); await boards.remove(boardId, taskId); return answer(res, 200, { ok: true }); }
      // A task that cannot start (nobody to do it, already running, its person busy, a skill switched off) is not the
      // server breaking: the reason goes back as a plain "not now", and the card and needs-you show it as they always did.
      if (taskId && action === 'run' && req.method === 'POST') {
        try { await runs.start(boardId, taskId); } catch (error) { return answer(res, 409, { error: (error as Error).message }); }
        return answer(res, 200, { ok: true });
      }
      if (taskId && action === 'stop' && req.method === 'POST') { runs.stop(taskId); return answer(res, 200, { ok: true }); }
      if (taskId && action === 'learn' && req.method === 'POST') {
        const task = (await boards.list(boardId)).find((one) => one.id === taskId);
        if (!task?.run || task.run.state !== 'done' || !task.assignee) return answer(res, 400, { error: 'only a task that a person finished can be learned from' });
        // The names of what it reached for, out of the log. Not a word of what any of them came back with.
        const did = task.run.log.flatMap((one) => { const call = /^([✓✗]) (\w+)/.exec(one); return call ? [{ id: call[2], name: call[2], args: {}, ok: call[1] === '✓' }] : []; });
        return answer(res, 200, await learn({
          roomId: task.assignee, source: 'run', ref: taskId, query: `${task.title}${task.detail ? `\n\n${task.detail}` : ''}`,
          reply: { text: task.run.result ?? '', tools: did, provider: task.run.provider ?? '', model: task.run.model ?? '', usage: task.run.usage ?? { input: 0, output: 0 }, stopped: false },
        }));
      }
    }
    return false;
  };
}
