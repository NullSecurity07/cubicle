import type { TurnResult } from '../loop.ts';

// The partner's stance says to check preconditions before any plan to raise, hire, spend or pivot. A small model
// read past it and drafted a $2M raise for a company with no users, so it is held to it in code too: a reply to such
// an ask that shows no sign of the check is asked for once more with the rule in front of it, and a second miss is
// posted with a line that tells the founder so.

// A plan that commits money or people: raising a round, hiring someone, spending a sum or a budget, pivoting. The
// word alone is not enough: "raise the price", "spend the afternoon" and "an investor update" commit nothing.
const COMMIT = new RegExp([
  '\\braise\\w*\\b(?!\\s+(?:the\\s+|our\\s+|my\\s+)?(?:price|prices|rate|rates|fee|fees|bar)\\b)[^.?!]{0,40}(?:\\$\\s?\\d|\\d+\\s?[kmb]\\b|round|pre-?seed|seed\\b|series [a-d]|money|capital|funding|from investors|investors)',
  '\\b(?:fund-?rais\\w*|pre-?seed round|seed round|series [a-d] round)',
  '\\b(?:hire|hiring|recruit\\w*)\\b[^.?!]{0,40}\\b(?:a|an|two|three|four|five|\\d+|first|our|my|someone|people|engineers?|developers?|designers?|marketers?|sales\\w*|staff|team|cto|vp)\\b',
  '\\bspend\\w*\\b[^.?!]{0,30}(?:\\$\\s?\\d|\\d+\\s?[kmb]\\b|budget|savings|runway|on (?:ads|hiring|a (?:contractor|agency)))',
  '\\bpivot\\w*\\b',
].join('|'), 'i');
const PLAN = /\b(plan|draft|prepare|steps|roadmap|timeline|how (?:do|should|can|would) (?:i|we)|should (?:i|we)|thoughts|what would|help me|let'?s|i want to|we want to|we'?re going to|i'?m going to)\b/i;
// Asked for a plan that commits money or people: "raised the price" is past, and matches neither word list.
export const asksCommitment = (said: string) => COMMIT.test(said) && PLAN.test(said);

// A reply that pushed back or weighed the preconditions, in the ways people say it.
const CHECKED = /^\W*no\b|\b(not yet|not now|before that|preconditions?|i disagree|wait|hold off|too early|first (?:get|need|prove|find|show))\b|\bdon'?t \w+ yet\b|my call:\s*(?:\*\*)?\s*(?:no|not|wait|hold)\b/im;
export const checksPreconditions = (reply: string) => CHECKED.test(reply);

export const PRECONDITION_NUDGE = 'Take another look before this goes to the founder: it is a plan to raise money, hire, spend or pivot. List its preconditions and check each '
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

// Tools that only read: a first answer that used only these can be asked for again without doing anything twice.
const READS = /^(read_|list_|web_search|web_fetch|recall|search_|gather_|crawl_site|ask_person)/;
export const didSomething = (turn: TurnResult) => turn.tools.some((tool) => tool.ok && !READS.test(tool.name));

// The partner's finished reply, held to the check. `again` answers once more in words only, with the first answer and
// the nudge in front of it. A first answer that already did something (wrote a doc, proposed a decision) is not asked
// again, so nothing is done twice; it is only labelled when it skipped the check.
export async function holdPartner(asked: string, first: TurnResult, again: (first: TurnResult) => Promise<TurnResult>): Promise<TurnResult> {
  let reply = first;
  if (!first.stopped && asksCommitment(asked) && !checksPreconditions(first.text)) {
    if (didSomething(first)) reply = { ...first, text: `${first.text.replace(/\s+$/, '')}\n\n${UNCHECKED}` };
    else {
      const second = await again(first);
      reply = { ...second, tools: [...first.tools, ...second.tools], usage: { input: first.usage.input + second.usage.input, output: first.usage.output + second.usage.output } };
      if (!second.stopped && !checksPreconditions(second.text)) reply = { ...reply, text: `${second.text.replace(/\s+$/, '')}\n\n${UNCHECKED}` };
    }
  }
  return { ...reply, text: oneCall(reply.text) };
}
