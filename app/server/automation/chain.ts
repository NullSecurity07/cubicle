import type { Task } from '../../shared/model.ts';

// One task after another. A task holds the id of the one it waits for, so a chain is read from either end without
// anything having to keep a second list in step with the board.

// Whoever waits for this one. Order is the board's own, so a task written down first starts first.
export const waitingFor = (tasks: Task[], taskId: string) => tasks.filter((one) => one.after === taskId);

// Why this link cannot be made, in words the founder can act on. A chain that came back to where it started would run
// for ever, so it is refused while they are setting it up rather than at three in the morning.
export function chainProblem(tasks: Task[], task: Task, afterId: string): string {
  if (afterId === task.id) return 'a task cannot wait for itself';
  const target = tasks.find((one) => one.id === afterId);
  if (!target) return 'that task is not on this board';
  const seen = new Set([task.id]);
  for (let at: Task | undefined = target; at; at = tasks.find((one) => one.id === at?.after)) {
    if (seen.has(at.id)) return `that would go round in a circle: "${at.title}" already waits for this one`;
    seen.add(at.id);
  }
  return '';
}
