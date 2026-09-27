import type { DashDay } from '../../shared/dashboard';
import type { TodayItem } from '../../shared/today';

type Lists = Pick<DashDay, 'needsYou' | 'decisionsPending' | 'tasksDue' | 'tasksRunning'>;

// The dashboard's Today reads top to bottom: Today's five, Needs you, Tasks, Decisions to make. One thing waiting on the
// founder shows once, in the first of those it belongs to, so two waiting decisions are not three lists of the same
// two lines. `today` is null until Today's five has been read: then only Needs you and Decisions are weighed.
export function firstPlace(today: TodayItem[] | null, day: Lists): Lists {
  const items = today ?? [];
  const seen = new Set(items.map((one) => one.id));
  const decided = new Set(items.flatMap((one) => (one.decisionId ? [one.decisionId] : [])));
  const tasks = new Set(items.flatMap((one) => (one.taskId ? [one.taskId] : [])));
  const needsYou = day.needsYou.filter((one) => !seen.has(one.id) && !(one.decisionId && decided.has(one.decisionId)));
  for (const one of needsYou) if (one.decisionId) decided.add(one.decisionId);
  return {
    needsYou,
    tasksDue: day.tasksDue.filter((one) => !tasks.has(one.id)),
    tasksRunning: day.tasksRunning.filter((one) => !tasks.has(one.id)),
    decisionsPending: day.decisionsPending.filter((one) => !decided.has(one.id)),
  };
}
