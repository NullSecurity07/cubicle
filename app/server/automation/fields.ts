import type { Task } from '../../shared/model.ts';
import { chainProblem } from './chain.ts';
import { cleanScript } from './script.ts';

const SKILL = /^[a-z0-9][a-z0-9-]{0,79}$/;

// The rest of what the founder may set on a task, beside the schedule: a script instead of a person, a skill to work
// from, what it waits for, and what a missed run means here. Each one is checked, and a link that would go round in a
// circle is refused now, in words, rather than run for ever later.
export function automate(task: Task, patch: Record<string, unknown>, tasks: Task[]) {
  if ('script' in patch) task.script = cleanScript(patch.script);
  if ('skill' in patch) task.skill = typeof patch.skill === 'string' && SKILL.test(patch.skill) ? patch.skill : undefined;
  if ('onMissed' in patch) task.onMissed = patch.onMissed === 'once' || patch.onMissed === 'skip' ? patch.onMissed : undefined;
  if ('after' in patch) {
    const afterId = typeof patch.after === 'string' ? patch.after : '';
    const problem = afterId ? chainProblem(tasks, task, afterId) : '';
    if (problem) throw new Error(problem);
    task.after = afterId || undefined;
  }
}
