import { execFile } from 'node:child_process';
import type { Stage, ToolEvent } from '../shared/model.ts';
import type { createApprovals } from './approvals.ts';
import type { AttentionBook } from './attention.ts';
import type { Boards } from './boards.ts';
import { nextDue } from './boards.ts';
import { runTurn } from './loop.ts';
import type { ModelMessage } from './prompt.ts';
import { promptSize, type ModelClient } from './providers.ts';
import { route } from './router.ts';
import type { Seams } from './seams.ts';
import type { Store } from './store.ts';
import type { Tool } from './tools/registry.ts';
import type { UsageBook } from './usage.ts';

export type Notify = (title: string, body: string) => void;

// A desktop notification through whatever the system offers; silent when it offers nothing.
export const desktopNotify: Notify = (title, body) => {
  if (process.platform === 'linux') execFile('notify-send', ['--app-name=Cubicle', title, body], () => {});
  else if (process.platform === 'darwin') execFile('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], () => {});
};

const line = (event: ToolEvent) => `${event.ok ? '✓' : '✗'} ${event.name} ${String(event.args.doc ?? event.args.title ?? event.args.path ?? event.args.to ?? event.args.name ?? event.args.action ?? (Array.isArray(event.args.queries) ? event.args.queries.join(' | ') : '')).slice(0, 80)}${event.ok ? '' : ` · ${(event.result ?? '').slice(0, 140)}`}`.trim();

// Background work on a task: the same turn a chat runs, started by the founder (the Run button or a repeat the founder set),
// written into the task instead of a conversation. An outward step parks the run in "waiting" until the founder answers on the board.
export function createRuns(deps: {
  boards: Boards; store: Store; tools: Tool[]; clients: ModelClient[]; usage: UsageBook; approvals: ReturnType<typeof createApprovals>; attention?: AttentionBook;
  promptFor: (stage: Stage, roomId: string, toolNames: string[], fresh?: boolean) => Promise<ModelMessage[]>; busy: Set<string>; notify: Notify; seams?: Seams;
}) {
  const { boards, store, tools, clients, usage, approvals, attention, promptFor, busy, notify, seams } = deps;
  const stops = new Map<string, AbortController>();

  async function start(boardId: string, taskId: string): Promise<void> {
    const stage = await store.loadStage();
    const task = (await boards.list(boardId)).find((one) => one.id === taskId);
    if (!task) throw new Error('unknown task');
    const room = stage.rooms.find((one) => one.id === task.assignee);
    if (!room) throw new Error('give the task to a person first');
    if (task.run?.state === 'running' || task.run?.state === 'waiting') throw new Error('this task is already running');
    if (busy.has(room.id)) throw new Error(`${room.name} is in the middle of something. Try again when they are done.`);
    busy.add(room.id);
    const stop = new AbortController();
    stops.set(taskId, stop);
    await boards.update(boardId, taskId, (one) => { one.column = 'doing'; one.missed = undefined; one.run = { state: 'running', startedAt: Date.now(), log: [`${room.name} started`] }; if (one.repeat) one.nextRun = nextDue(one.repeat, Date.now()); });
    const log = (text: string) => boards.update(boardId, taskId, (one) => { one.run!.log = [...one.run!.log.slice(-199), text]; });

    void (async () => {
      let result = '';
      try {
        const asked = `${task.title}${task.detail ? `\n\n${task.detail}` : ''}`;
        const messages = await promptFor(stage, room.id, tools.map((tool) => tool.name), true);
        messages.push({ role: 'user', content: `The founder started this task from the board. Do it now with your tools, then report the result in a few lines.\n\nTask: ${asked}` });
        const { order } = route(clients, usage, { pinned: room.model, promptChars: promptSize(messages), tools: true });
        const reply = await runTurn({
          messages, tools, clients: order, usage, signal: stop.signal, seams, source: 'run', query: asked,
          context: { stage, roomId: room.id, store, granted: new Map() },
          events: {
            token: (token) => { result += token; },
            notice: (text) => { void log(text); },
            tool: (event) => {
              if (event.effect) boards.tell(boardId, { effect: event.effect, roomId: room.id });
              if (event.ok !== undefined) void log(line(event));
            },
          },
          approve: async (event, signal) => {
            await boards.update(boardId, taskId, (one) => { one.run!.state = 'waiting'; one.run!.approval = event; });
            notify(`${room.name} needs your OK`, `${task.title}: ${event.question ?? event.name.replace(/_/g, ' ')}`);
            await attention?.raise({ id: `approval:${event.id}`, kind: 'run-approval', title: event.question ?? event.name.replace(/_/g, ' '), detail: task.title, at: Date.now(), roomId: room.id, who: room.name, cardId: boardId, taskId, event });
            const answer = await approvals.ask(event.id, signal).finally(() => attention?.clear(`approval:${event.id}`));
            await boards.update(boardId, taskId, (one) => { one.run!.state = 'running'; one.run!.approval = undefined; });
            return answer;
          },
        });
        await boards.update(boardId, taskId, (one) => { one.column = 'review'; one.run = { ...one.run!, state: reply.stopped ? 'stopped' : 'done', finishedAt: Date.now(), result: reply.text, provider: reply.provider, model: reply.model, usage: reply.usage }; });
        if (!reply.stopped) notify(`${room.name} finished`, task.title);
      } catch (error) {
        await boards.update(boardId, taskId, (one) => { one.column = 'review'; one.run = { ...one.run!, state: 'failed', finishedAt: Date.now(), approval: undefined, result: result || undefined, log: [...one.run!.log, `failed: ${(error as Error).message.slice(0, 300)}`] }; });
        notify(`${room.name} could not finish`, task.title);
      } finally {
        busy.delete(room.id);
        stops.delete(taskId);
      }
    })();
  }

  return {
    start,
    stop(taskId: string) { stops.get(taskId)?.abort(); },
    // Called every half minute: start the repeating tasks that are due. One whose person is busy stays due and is tried again.
    async tick() {
      const stage = await store.loadStage();
      for (const card of stage.cards ?? []) {
        if (card.kind !== 'board') continue;
        for (const task of await boards.due(card.id)) await start(card.id, task.id).catch(() => {});
      }
    },
  };
}
