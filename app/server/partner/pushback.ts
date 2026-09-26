import type { TurnResult } from '../loop.ts';

// The partner's stance says to check preconditions before any plan to raise, hire, spend or pivot. A small model
// read past it and drafted a $2M raise for a company with no users, so it is held to it in code too: a reply to such
// an ask that shows no sign of the check is asked for once more with the rule in front of it, and a second miss is
// posted with a line that tells the founder so.

const COMMIT = /\b(raise|raising|fund-?rais\w*|pre-?seed|seed round|series [a-d]|investors?|hire|hiring|recruit\w*|spend|spending|budget|pivot\w*)\b/i;
const PLAN = /\b(plan|draft|prepare|steps|roadmap|timeline|how (?:do|should|can|would) (?:i|we)|help me|let'?s|i want to|we want to|we'?re going to|i'?m going to)\b/i;
// Asked for a plan that commits money or people: "raised the price" is past, and matches neither word list.
export const asksCommitment = (said: string) => COMMIT.test(said) && PLAN.test(said);

const CHECKED = /\b(not yet|before that|preconditions?|i disagree|wait)\b|my call:\s*(?:\*\*)?\s*no\b/i;
export const checksPreconditions = (reply: string) => CHECKED.test(reply);

export const PRECONDITION_NUDGE = 'Before you answer: this is a plan to raise money, hire, spend or pivot. List its preconditions and check each '
  + 'against the Company document and the chat. When one is not met, say "Not yet" first, give the shortest path to meeting it, '
  + 'and only then any plan. Quote a teammate\'s section or the Company document where it contradicts the founder\'s premise.';
export const UNCHECKED = '*Partner did not check preconditions.*';

const CALL = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*my call\b/i;
// One "My call:" line per reply: the last one stands, earlier ones go.
export function oneCall(text: string): string {
  const lines = text.split('\n');
  const calls = lines.flatMap((line, index) => (CALL.test(line) ? [index] : []));
  if (calls.length < 2) return text;
  const drop = new Set(calls.slice(0, -1));
  return lines.filter((_, index) => !drop.has(index)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

// The partner's finished reply, held to the check. `again` runs the turn once more with the nudge in front of it.
export async function holdPartner(asked: string, first: TurnResult, again: () => Promise<TurnResult>): Promise<TurnResult> {
  let reply = first;
  if (!first.stopped && asksCommitment(asked) && !checksPreconditions(first.text)) {
    const second = await again();
    reply = { ...second, tools: [...first.tools, ...second.tools], usage: { input: first.usage.input + second.usage.input, output: first.usage.output + second.usage.output } };
    if (!second.stopped && !checksPreconditions(second.text)) reply = { ...reply, text: `${second.text.replace(/\s+$/, '')}\n\n${UNCHECKED}` };
  }
  return { ...reply, text: oneCall(reply.text) };
}
