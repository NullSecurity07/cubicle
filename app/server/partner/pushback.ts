import type { TurnResult } from '../loop.ts';

// The partner's stance says to check preconditions before any plan to raise, hire, spend or pivot. A small model
// read past it and drafted a $2M raise for a company with no users, so it is held to it in code too: a reply to such
// an ask that shows no sign of the check is asked for once more with the rule in front of it, and a second miss is
// posted with a line that tells the founder so.

// A plan that commits money or people: raising a round, hiring headcount, spending a real sum or setting a budget
// for something, pivoting. The word alone is not enough: "raise the price", "spend the afternoon", "an investor
// update", "the monthly email to investors", "the $300 ad budget" and "hire a contractor" are the founder's ordinary
// week, and asking for preconditions on them only buys a "Not yet" nobody needed.
const COMMIT = new RegExp([
  '\\braise\\w*\\b(?!\\s+(?:the\\s+|our\\s+|my\\s+)?(?:price|prices|rate|rates|fee|fees|bar)\\b)[^.?!]{0,40}(?:\\$\\s?\\d|\\d+\\s?[kmb]\\b|round|pre-?seed|seed\\b|series [a-d]|money|capital|funding|from investors|investors|angels?|vcs?\\b|loan|offer)',
  '\\b(?:fund-?rais\\w*|pre-?seed round|seed round|series [a-d] round)',
  '\\b(?:hire|hiring|recruit\\w*)\\b[^.?!]{0,40}\\b(?:a|an|two|three|four|five|\\d+|first|our|my|someone|people|engineers?|developers?|designers?|marketers?|sales\\w*|staff|team|cto|vp)\\b',
  '\\bspend\\w*\\b[^.?!]{0,30}(?:savings|runway|on hiring)',
  '\\bpivot\\w*\\b',
  '\\bshould (?:i|we) (?:raise|fund-?raise|hire)\\b',
  '\\b(?:our|a|the) (?:pre-?)?seed\\b',
].join('|'), 'i');
// Help from outside by the job is not headcount: a contractor, a freelancer or an agency.
const HIRED_HELP = /\b(?:hire|hiring|recruit\w*)\b[^.?!]{0,30}\b(?:contractors?|freelanc\w*|agency|agencies|virtual assistants?)\b/i;
const HEADCOUNT = /\b(?:hire|hiring|recruit\w*)\b/i;
// A sum is a commitment from this much: below it, a spend is a week's ad test, not a bet of the company.
export const SPEND_FROM = 1000;
// A sum of money: "$15k", "$50,000", "10k", "1,500 dollars".
const SUM = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kmb])?\b|\b(\d[\d,]*(?:\.\d+)?)\s?([kmb])\b|\b(\d[\d,]*(?:\.\d+)?)\s+(?:dollars|usd|euros|pounds)\b/gi;
// What makes a sum money going out or coming in, said on either side of it.
const MONEY_VERB = /\b(?:spend\w*|put\w*|allocat\w*|invest\w*|budget\w*|pay\w*|burn\w*|loans?|offers?)\b/i;
const NEAR = 30;
const sums = (said: string) => [...said.matchAll(SUM)].map((found) => {
  const digits = found[1] ?? found[3] ?? found[5];
  const scale = (found[2] ?? found[4] ?? '').toLowerCase();
  return { value: Number(digits.replace(/,/g, '')) * ({ k: 1e3, m: 1e6, b: 1e9 }[scale as 'k'] ?? 1), at: found.index, end: found.index + found[0].length };
});
const bigSpend = (said: string) => sums(said).some((sum) => sum.value >= SPEND_FROM
  && MONEY_VERB.test(`${said.slice(Math.max(0, sum.at - NEAR), sum.at)} ${said.slice(sum.end, sum.end + NEAR)}`));
// "The budget for" something is a commitment, unless the sum it names is a small one.
const budgetFor = (said: string) => /\bbudget for\b/i.test(said) && !sums(said).some((sum) => sum.value < SPEND_FROM);
const commits = (said: string) => {
  if (bigSpend(said) || budgetFor(said)) return true;
  if (!COMMIT.test(said)) return false;
  // Only a hire of outside help matched: that is not a commitment. A raise or a pivot said beside it still is.
  if (HIRED_HELP.test(said)) return COMMIT.test(said.replace(HEADCOUNT, ''));
  return true;
};
const PLAN = /\b(plan|draft|prepare|steps|roadmap|timeline|how (?:do|should|can|would) (?:i|we)|should (?:i|we)|thoughts|what would|help me|let'?s|i want to|we want to|we'?re going to|i'?m going to)\b/i;
// Asked for a plan that commits money or people: "raised the price" is past, and matches neither word list.
export const asksCommitment = (said: string) => commits(said) && PLAN.test(said);

// A reply that pushed back or weighed the preconditions, in the ways people say it.
// Only the reply's own first word counts as a "No": a line further down that starts "No existing marketplace…" or
// "- No-code page" is not pushback. "Wait" counts only as "wait until".
const CHECKED = /^\W*no[.,!:;]|\b(not yet|not now|before that|preconditions?|i disagree|hold off|too early|push back|wait (?:until|till)|first (?:get|need|prove|find|show))\b|\bdon'?t \w+ yet\b|\bcan'?t \w+ without\b|my call:\s*(?:\*\*)?\s*(?:no|not|wait|hold)\b/i;
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
