import type { Attention } from '../../shared/model.ts';

// A background run that asked the founder something and never heard back. Half a day is long enough: the answer is
// no, the run carries on without it, and the founder is told that is what happened.
export const WAITED_TOO_LONG = 12 * 3_600_000;
export const UNANSWERED = 'Nobody answered this for twelve hours, so it was answered no and the task went on without it. Run it again when you want it.';

// A coder's question counts too: nobody at the card for half a day means the coder is told no, and why.
export const overdue = (list: Attention[], at: number, limit = WAITED_TOO_LONG): Attention[] =>
  list.filter((one) => (one.kind === 'run-approval' || one.id.startsWith('coder:')) && !!one.event && !one.lapsed && at - one.at >= limit);
// What the coder is told when the founder never answered.
export const NO_ANSWER = 'no answer in time';
