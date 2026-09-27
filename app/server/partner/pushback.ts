import { PARTNER_PRECONDITIONS, PARTNER_STANCE, STANCE } from '../../shared/model.ts';
import type { TurnResult } from '../loop.ts';
import { forCustomers } from './audience.ts';

// The partner's stance says to check preconditions before any plan to raise, hire, spend or pivot. A small model
// read past it and drafted a $2M raise for a company with no users, so it is held to it in code too: a reply to such
// an ask that shows no sign of the check is asked for once more with the rule in front of it, and a second miss is
// posted with a line that tells the founder so.

// A plan that commits money or people: raising a round, hiring headcount, spending a real sum or setting a budget
// for something, pivoting. The word alone is not enough: "raise the price", "spend the afternoon", "an investor
// update", "the monthly email to investors", "the $300 ad budget" and "hire a contractor" are the founder's ordinary
// week, and asking for preconditions on them only buys a "Not yet" nobody needed.
// What a price is called: raising one is the founder's week, however the ask is put ("should we raise the price?",
// "raise our monthly pricing"). Checked right after the word "raise", with a possessive and one word between.
const PRICED = '(?!\\s+(?:(?:the|our|my|its|their|your)\\s+)?(?:[a-z-]+\\s+)?(?:price|prices|pricing|rate|rates|fee|fees|bar)\\b)';
const COMMIT = new RegExp([
  `\\braise\\w*\\b${PRICED}[^.?!]{0,40}(?:\\$\\s?\\d|\\d+\\s?[kmb]\\b|round|pre-?seed|seed\\b|series [a-d]|money|capital|funding|from investors|investors|angels?|vcs?\\b|loan|offer)`,
  '\\b(?:fund-?rais\\w*|pre-?seed round|seed round|series [a-d] round)',
  '\\b(?:hire|hiring|recruit\\w*)\\b[^.?!]{0,40}\\b(?:a|an|two|three|four|five|\\d+|first|our|my|someone|people|engineers?|developers?|designers?|marketers?|sales\\w*|staff|team|cto|vp)\\b',
  '\\bspend\\w*\\b[^.?!]{0,30}(?:savings|runway|on hiring)',
  '\\bpivot\\w*\\b',
  `\\bshould (?:i|we) (?:raise\\b${PRICED}|fund-?raise|hire)\\b`,
  '\\b(?:take|accept)\\b[^.?!]{0,40}\\b(?:offer|loan|investment|term sheet)\\b',
  '\\b(?:our|a|the) (?:pre-?)?seed\\b',
].join('|'), 'i');
// Help from outside by the job is not headcount: a contractor, a freelancer or an agency.
const HIRED_HELP = /\b(?:hire|hiring|recruit\w*)\b[^.?!]{0,30}\b(?:contractors?|freelanc\w*|agency|agencies|virtual assistants?)\b/i;
const HEADCOUNT = /\b(?:hire|hiring|recruit\w*)\b/i;
// A sum is a commitment from this much: below it, a spend is a week's ad test, not a bet of the company.
export const SPEND_FROM = 1000;
// A sum of money: "$15k", "$50,000", "1,500 dollars", or a bare "10k" (read as money only in the right company).
const SUM = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kmb])?\b|\b(\d[\d,]*(?:\.\d+)?)\s?([kmb])\b|\b(\d[\d,]*(?:\.\d+)?)\s+(?:dollars|usd|euros|pounds)\b/gi;
// Money about to go out, in the present or the future: "spent", "burned" and "we pay" rent are the past or the
// running cost, and an "offer" is a raise only when it is taken (the pattern above).
const MONEY_VERB = /\b(?:spend|spends|spending|put|putting|allocate|allocating|invest|investing|budget|budgeting|burn|burning|loans?)\b/i;
const NEAR = 30;
const sums = (said: string) => [...said.matchAll(SUM)].map((found) => {
  const digits = found[1] ?? found[3] ?? found[5];
  const scale = (found[2] ?? found[4] ?? '').toLowerCase();
  return { value: Number(digits.replace(/,/g, '')) * ({ k: 1e3, m: 1e6, b: 1e9 }[scale as 'k'] ?? 1), at: found.index, end: found.index + found[0].length, bare: found[3] !== undefined };
});
// A "$" sum or one in dollars counts beside a money verb on either side. A bare "10k" counts only after one
// ("invest 10k"), and never as a count of something ("20k users").
const bigSpend = (said: string) => sums(said).some((sum) => {
  if (sum.value < SPEND_FROM) return false;
  const before = said.slice(Math.max(0, sum.at - NEAR), sum.at);
  if (sum.bare) return MONEY_VERB.test(before) && !/^\s+[a-z][a-z-]*s\b/i.test(said.slice(sum.end));
  return MONEY_VERB.test(`${before} ${said.slice(sum.end, sum.end + NEAR)}`);
});
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

// ---------------------------------------------------------------- the team's verdict

// Journey 6: the standing facts held "PIVOT REQUIRED 6/10" and the partner still told the founder three times to build
// invoicing. A prompt line was not enough, so it is held to it in code: a weak verdict (WEAK, PIVOT, KILL, or a score
// of five or less) and a reply whose call is to build, ship, launch or code, without a word about the verdict, is
// asked for once more with the verdict in front of it, and a second miss is labelled.
export type TeamVerdict = { title: string; word?: string; score?: number };
export const isWeak = (verdict: TeamVerdict) => /\b(?:weak|pivot|kill|no[- ]go|dead|stop)\b/i.test(verdict.word ?? '') || (verdict.score !== undefined && verdict.score <= 5);
export const verdictName = (verdict: TeamVerdict) => `${[verdict.word, verdict.score !== undefined ? `${verdict.score}/10` : ''].filter(Boolean).join(' ')} (${verdict.title})`;
export const BUILDS = /\b(?:build|building|ship|shipping|launch|launching|code|coding|develop|developing|implement|implementing|dive\s+(?:straight\s+)?into)\b/i;
// "Do not build yet", "pause coding", "before you build", "instead of shipping": a call against building.
const NOT_BUILD = /\b(?:don'?t|do not|not|never|no|pause|stop|hold off(?: on)?|before|until|instead of|rather than|without)\s+(?:\w+\s+){0,2}$/i;
export function buildsAgainst(reply: string, verdict: TeamVerdict): boolean {
  const first = (verdict.word ?? '').split(/\s+/)[0];
  if (/\bverdict\b/i.test(reply) || (first && new RegExp(`\\b${first.replace(/[^\w]/g, '')}\\b`, 'i').test(reply))) return false;
  // Only the partner's call is held to it: a reply with no "My call:" line (a draft, an email) is not a call to build.
  // The call runs from the last "My call" to the end of its line, at the start of a line or after a sentence.
  const call = [...reply.matchAll(/\bmy call\b[^\n]*/gi)].at(-1)?.[0];
  if (!call) return false;
  return [...call.matchAll(new RegExp(BUILDS.source, 'gi'))].some((found) => !NOT_BUILD.test(call.slice(Math.max(0, found.index - 40), found.index)));
}
export const verdictNudge = (verdict: TeamVerdict) => `The team's verdict is ${verdictName(verdict)}; answer in its light or say why you overrule it. `
  + 'Name the verdict in your reply.';
// Said under the reply, so short: the founder reads the answer, not the check.
export const UNWEIGHED = '*Team verdict not weighed.*';

// ---------------------------------------------------------------- the stance, said back

// Journey 6: raise, hire and price replies carried the preconditions rule almost word for word ("Before any plan to
// raise money, hire, spend or pivot, we must check its preconditions…"). A sentence that is a near copy of one of the
// partner's own instructions is taken out: the founder reads the answer, not the rules.
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const RULES = [PARTNER_STANCE, PARTNER_PRECONDITIONS, STANCE].flatMap((rule) => rule.split(/(?<=[.!?])\s+/)).map((one) => new Set(words(one))).filter((one) => one.size >= 8);
// A short rule said back word for word ("Be concise."), and the runway rule in any words ("Never round this upward.").
const SHORT_RULES = new Set([PARTNER_STANCE, PARTNER_PRECONDITIONS, STANCE].flatMap((rule) => rule.split(/(?<=[.!?])\s+/)).map((one) => words(one).join(' ')).filter((one) => one && one.split(' ').length < 8));
const RUNWAY_RULE = /^\W*never\s+round\b[^.!?]*(?:up|upward|upwards|better side)\W*$/i;
const copiesRule = (sentence: string) => {
  const said = words(sentence);
  if (RUNWAY_RULE.test(sentence) || SHORT_RULES.has(said.join(' '))) return true;
  if (said.length < 8) return false;
  return RULES.some((rule) => said.filter((word) => rule.has(word)).length / said.length >= 0.75);
};
export function stripStance(text: string): string {
  const lines = text.split('\n').flatMap((line) => {
    if (!line.trim()) return [line];
    const kept = line.split(/(?<=[.!?])\s+/).filter((sentence) => !copiesRule(sentence.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')));
    return kept.length ? [kept.join(' ')] : [];
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

// The partner's finished reply, held to the check. `again` answers once more in words only, with the first answer and
// the nudge in front of it. A first answer that already did something (wrote a doc, proposed a decision) is not asked
// again, so nothing is done twice; it is only labelled when it skipped the check.
// With a weak team verdict on the stage, the reply is held to it too; at most one second look per turn, so a reply
// asked again for its preconditions that still builds against the verdict is only labelled.
export async function holdPartner(asked: string, first: TurnResult, again: (first: TurnResult, nudge?: string) => Promise<TurnResult>, verdict?: TeamVerdict | null): Promise<TurnResult> {
  let reply = first;
  let lookedAgain = false;
  const label = (turn: TurnResult, line: string) => ({ ...turn, text: `${turn.text.replace(/\s+$/, '')}\n\n${line}` });
  const joined = (one: TurnResult, two: TurnResult) => ({ ...two, tools: [...one.tools, ...two.tools], usage: { input: one.usage.input + two.usage.input, output: one.usage.output + two.usage.output } });
  if (!first.stopped && asksCommitment(asked) && !checksPreconditions(first.text)) {
    if (didSomething(first)) reply = label(first, UNCHECKED);
    else {
      const second = await again(first, PRECONDITION_NUDGE);
      lookedAgain = true;
      reply = joined(first, second);
      if (!second.stopped && !checksPreconditions(second.text)) reply = label(reply, UNCHECKED);
    }
  }
  // Never on something written for customers: the verdict is the company's own, not theirs to read.
  if (verdict && isWeak(verdict) && !reply.stopped && !forCustomers(asked) && buildsAgainst(reply.text, verdict)) {
    if (lookedAgain || didSomething(reply)) reply = label(reply, UNWEIGHED);
    else {
      const second = await again(reply, verdictNudge(verdict));
      reply = joined(reply, second);
      if (!second.stopped && buildsAgainst(second.text, verdict)) reply = label(reply, UNWEIGHED);
    }
  }
  return { ...reply, text: oneCall(stripStance(reply.text)) };
}
