import type { Boards } from '../boards.ts';
import { shortDay } from '../clock.ts';
import { wired } from '../prompt.ts';
import { text, type Tool, type ToolContext } from './registry.ts';

const board = (context: ToolContext) => wired(context.stage, context.roomId, (context.stage.cards ?? []).filter((card) => card.kind === 'board').map((card) => card.id))[0];
const NO_BOARD = 'no task board is connected to your room. The founder adds one from the dock and draws a wire to it.';

// People suggest work; the founder decides what gets done. A proposal waits in the first column until the founder takes it.
export function taskTools(boards: Boards): Tool[] {
  return [
    {
      name: 'propose_task',
      perTurn: 5,
      description: 'Suggest a task on the board connected to your room. It lands in Proposed; the founder decides whether and when it is done, and by whom. Use it for follow-up work you noticed, not for what the founder just asked you to do now.',
      parameters: { type: 'object', properties: { title: { type: 'string', description: 'Short, starts with a verb' }, detail: { type: 'string', description: 'What done looks like, and anything the person doing it must know' } }, required: ['title'] },
      async run(args, context) {
        const id = board(context);
        if (!id) throw new Error(NO_BOARD);
        const me = context.stage.rooms.find((room) => room.id === context.roomId)!;
        const task = await boards.add(id, { title: text(args, 'title', 200), detail: typeof args.detail === 'string' ? args.detail : '', column: 'proposed', proposedBy: me.name });
        return { text: `Proposed "${task.title}". It waits for the founder.` };
      },
    },
    {
      name: 'list_tasks',
      description: 'Read the task board connected to your room. Each task says the day it was put up, when it next runs, and when its last run finished; compare those with today\'s date before you call anything late or done.',
      parameters: { type: 'object', properties: {} },
      async run(_args, context) {
        const id = board(context);
        if (!id) throw new Error(NO_BOARD);
        const tasks = await boards.list(id);
        const name = (roomId?: string) => context.stage.rooms.find((room) => room.id === roomId)?.name;
        // Without the days, a board is a list of things all equally "now": a task put up in March and one from this
        // morning read the same, and a run that has not happened for weeks reads as fresh.
        return { text: tasks.map((task) => `- [${task.column}] ${task.title}${task.assignee ? ` (${name(task.assignee) ?? 'unassigned'})` : ''}`
          + ` · put up ${shortDay(task.createdAt)}${task.nextRun ? ` · next run ${shortDay(task.nextRun)}` : ''}${task.missed ? ' · missed while the app was closed' : ''}`
          + `${task.run?.finishedAt ? ` · last ran ${shortDay(task.run.finishedAt)}` : ''}${task.run?.result ? ` · result: ${task.run.result.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`).join('\n') || 'The board is empty.' };
      },
    },
  ];
}
