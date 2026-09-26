import type { Attention, Stage } from '../../shared/model.ts';
import { dueOf, parsePlan, planTaskTitle, type PlanProposal, type PlanStep } from '../../shared/partner.ts';
import type { Boards } from '../boards.ts';
import { localDay } from '../clock.ts';
import { wired } from '../prompt.ts';
import type { Store } from '../store.ts';
import { placeOf } from './company.ts';

// A plan a person wrote becomes tasks only when the founder says so: the steps wait in Needs you as one question,
// "add these N tasks to the board?", and a yes puts each on the board as a task to do.

const SHOWN = 4;

// Steps handed over one per line by a person: a day at the front is kept as the day, anything else is the step.
export function stepsFrom(lines: string[]): PlanStep[] {
  return lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 40).map((line) => parsePlan(line)[0] ?? { text: line.replace(/^[-*+]\s+|^\d+[.)]\s+/, '').slice(0, 160) });
}

export const planAttention = (plans: PlanProposal[]): Attention[] => plans.map((plan) => ({
  id: `proposed-plan:${plan.id}`, kind: 'proposed-plan', at: plan.at, who: plan.who, roomId: plan.roomId,
  title: `${plan.steps.length === 1 ? 'Add this task' : `Add these ${plan.steps.length} tasks`} to the board? (${plan.title})`,
  detail: `${plan.steps.slice(0, SHOWN).map(planTaskTitle).join('; ')}${plan.steps.length > SHOWN ? `; and ${plan.steps.length - SHOWN} more` : ''}.`,
}));

// The board a plan goes on: the one wired to whoever wrote it, else the first on the stage.
export const boardFor = (stage: Stage, roomId: string) => {
  const boards = (stage.cards ?? []).filter((card) => card.kind === 'board').map((card) => card.id);
  return wired(stage, roomId, boards)[0] ?? boards[0];
};

export const NO_BOARD = 'There is no task board on the stage yet.';

// A new board for a plan, put down right of everything on the stage and wired to whoever wrote the plan, for the
// founder who said "add a board and put them on it".
export async function boardForPlan(store: Pick<Store, 'patchStage'>, roomId: string): Promise<string> {
  const id = `board-${Math.random().toString(36).slice(2, 8)}`;
  await store.patchStage((draft) => {
    draft.cards = [...(draft.cards ?? []), { id, kind: 'board', ...placeOf(draft), w: 980, h: 440 }];
    if (draft.rooms.some((room) => room.id === roomId)) draft.wires.push({ id: `${roomId}-${id}`, from: roomId, fromHandle: 'r', to: id, toHandle: 'l' });
  });
  return id;
}

// The founder's yes: every step a task to do, in the order written.
// Each task carries the calendar day its label names, read against today in the founder's time zone.
export async function addPlan(boards: Pick<Boards, 'add'>, stage: Stage, plan: PlanProposal, now = Date.now()): Promise<{ boardId: string; added: number }> {
  const boardId = boardFor(stage, plan.roomId);
  if (!boardId) throw new Error(NO_BOARD);
  const today = localDay(now);
  for (const step of plan.steps) {
    const due = step.day ? dueOf(step.day, today) : undefined;
    await boards.add(boardId, { title: planTaskTitle(step), detail: `From the plan "${plan.title}", written by ${plan.who}.`, column: 'todo', ...(due ? { due } : {}) });
  }
  return { boardId, added: plan.steps.length };
}
