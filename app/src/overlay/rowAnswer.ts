import type { Attention, ToolEvent } from '../../shared/model';
import { answerApproval } from '../api';
import { yesOf } from '../nodes/Approval';

// A step that waits for the founder's OK, answered on its dashboard row with the same two words the Needs-you list
// gives it, in the same approvals book, so the answer clears it everywhere. Only a step the founder can answer as it
// stands: a question waits for their words, a step done by hand for their hands, a coder's ask for once or always,
// and a step the app restarted under can only be asked again.
export type Quick = { tool: ToolEvent; yes: string };
const BY_HAND = new Set(['ask_founder', 'browse_help']);
export function quickAnswer(entry: Attention | undefined): Quick | null {
  if (!entry?.event || entry.lapsed || entry.coder) return null;
  if (entry.kind !== 'approval' && entry.kind !== 'run-approval') return null;
  if (BY_HAND.has(entry.event.name)) return null;
  return { tool: entry.event, yes: yesOf(entry.event.name) };
}

// Yes carries the step as it was asked; no carries nothing, as on the card.
const words = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
export const answerQuick = (quick: Quick, ok: boolean) => answerApproval(quick.tool.id, ok, ok ? words(quick.tool.args) : undefined);
