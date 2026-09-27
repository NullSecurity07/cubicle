import type { TurnResult } from '../loop.ts';
import { didSomething, oneCall, stripStance } from './pushback.ts';
import type { StandingParts } from './standing.ts';

// Journeys 5-7: asked "what do I do now?", the partner answered from one room at a time: "build invoicing" beside a
// PIVOT REQUIRED verdict, a runway of 3.8 months and a bet on record it never named. The standing facts were in the
// prompt; a prompt line did not make the answer weigh them. So a reply to "what now", "what's next" or "plan the week"
// is checked in code: it has to name at least two standing facts (the verdict, the numbers, a bet, what we learned,
// a task due, a promise, a decision), from two kinds when the stage has two. A miss is asked for once more with the
// facts quoted, and a second miss is labelled.

export const asksWhatNext = (said: string) => /\bwhat(?:'s| is)? next\b(?!\s+to\b)|\bwhat (?:do|should|shall|can) (?:i|we) do\b|\bwhat now\b|\bplan (?:the|my|our|this|next) week\b|\bwhere (?:do|should) (?:i|we) start\b|\bnext steps?\b|\bwhat should (?:i|we) (?:focus on|work on|do)\b|\bwhat(?:'s| is) (?:the|my|our) (?:priority|plan) for (?:today|this week)\b/i.test(said);

export type FactKind = 'verdict' | 'numbers' | 'bets' | 'learned' | 'due' | 'promise' | 'decided';
// One standing fact: its line as the standing block has it, and the ways a reply can name it.
export type Fact = { kind: FactKind; line: string; names: RegExp[]; words?: string[] };

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (text: string) => new RegExp(`(?<![\\w])${escaped(text.trim().toLowerCase()).replace(/\s+/g, '\\s+')}(?![\\w])`, 'i');
const STOP = new Set(['with', 'from', 'that', 'this', 'into', 'onto', 'than', 'then', 'them', 'they', 'your', 'ours', 'what', 'when', 'will', 'would', 'should', 'have', 'been', 'more', 'most', 'less', 'each', 'every', 'about', 'after', 'before', 'until', 'over', 'under', 'just', 'only', 'also', 'very', 'made', 'make', 'week', 'today']);
// The words of a title that say what it is: four letters or more, and not the glue of a sentence.
const wordsOf = (text: string) => [...new Set(text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [])].filter((word) => !STOP.has(word));
// Money words that name one number on their own: "your cash", "the burn".
const MONEY = /^(?:cash|burn|runway|mrr|arr|revenue|price|pricing|churn|margin|savings)$/i;
const digits = (text: string) => text.replace(/,/g, '');

function numberFact(line: string): Fact | null {
  const row = /^\s*[-*+]?\s*([^:]+):\s*(.+)$/.exec(line);
  if (!row) return null;
  const label = row[1].replace(/[*_`]/g, '').trim();
  const names = [phrase(label)];
  const last = label.split(/\s+/).at(-1) ?? '';
  if (MONEY.test(last)) names.push(new RegExp(`\\b${escaped(last)}\\b`, 'i'));
  const value = /\d[\d,]*(?:\.\d+)?/.exec(row[2])?.[0];
  if (value) {
    // A figure of two digits or more is its own name ("€4,200" or "4200"); a small count only with its noun ("3
    // paying users"), since a bare 3 is every step of every list.
    if (digits(value).replace('.', '').length >= 2) names.push(new RegExp(`(?<![\\d.,])${escaped(value)}(?![\\d])|(?<![\\d.,])${escaped(digits(value))}(?![\\d])`));
    else names.push(new RegExp(`\\b${escaped(value)}\\s+(?:[a-z-]+\\s+){0,2}${escaped(last.toLowerCase())}\\b`, 'i'));
  }
  return { kind: 'numbers', line, names };
}

// Every standing fact, in the order the standing block gives them.
export function standingFacts(parts: StandingParts): Fact[] {
  const facts: Fact[] = [];
  for (const line of parts.verdicts) {
    const title = /^\s*-\s*([^,]+),/.exec(line)?.[1];
    const word = /:\s*([A-Z]{2,}(?:[ -][A-Z]{2,})*)\b/.exec(line)?.[1];
    facts.push({ kind: 'verdict', line, names: [/\bverdicts?\b/i, ...(title ? [phrase(title)] : []), ...(word ? [new RegExp(`\\b${escaped(word).replace(/[ -]/g, '[\\s-]+')}\\b`, 'i')] : [])] });
  }
  for (const line of (parts.numbers ?? '').split('\n').filter((one) => one.trim())) {
    const fact = numberFact(line);
    if (fact) facts.push(fact);
  }
  // A bet by its metric as the card keeps it, by its words whole, or by being called a bet.
  for (const bet of parts.open) facts.push({ kind: 'bets', line: `- Open bet: ${bet.what} ("${bet.metric}" to ${bet.target} by ${bet.checkDate})`, names: [/\bbets?\b/i, phrase(bet.what), ...(/[_:]/.test(bet.metric) ? [phrase(bet.metric)] : [])] });
  for (const line of parts.learned ?? []) {
    const what = /^-\s*\S+:\s*(.+?)\s+(?:worked|did not work);/.exec(line)?.[1] ?? '';
    facts.push({ kind: 'learned', line, names: [/\b(?:we )?learned\b/i, ...(what ? [phrase(what)] : [])], words: wordsOf(what) });
  }
  for (const line of parts.planned) {
    const title = line.replace(/^\s*-\s*(?:left from \S+:\s*)?/, '');
    facts.push({ kind: 'due', line, names: [phrase(title)], words: wordsOf(title) });
  }
  for (const line of parts.promised ?? []) {
    const what = line.replace(/^\s*-\s*/, '').replace(/\s*\(due [^)]*\)\s*$/, '');
    facts.push({ kind: 'promise', line, names: [phrase(what), /\byou said you would\b|\byour promise\b/i], words: wordsOf(what) });
  }
  for (const line of parts.decided) {
    const [title, chosen = ''] = line.replace(/^\s*-\s*\S+\s+/, '').split(/:\s*/, 2);
    facts.push({ kind: 'decided', line, names: [phrase(title), ...(chosen ? [phrase(chosen)] : [])], words: [...wordsOf(title), ...wordsOf(chosen)] });
  }
  return facts;
}

// A title said in other words still counts when most of its own words are there: "finish the VAT export format" names
// "Build the VAT export format". At least two words, and three of five.
const mostWords = (reply: string, words: string[]) => {
  if (words.length < 2) return false;
  const said = new Set(reply.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []);
  const hit = words.filter((word) => said.has(word)).length;
  return hit >= 2 && hit >= Math.ceil(words.length * 0.6);
};
export const citedFacts = (reply: string, facts: Fact[]) => facts.filter((fact) => fact.names.some((name) => name.test(reply)) || (!!fact.words && mostWords(reply, fact.words)));

// Two facts named, from two kinds when the stage holds two kinds; with fewer facts than two there is nothing to hold.
export function synthesises(reply: string, facts: Fact[]): boolean {
  if (facts.length < 2) return true;
  const cited = citedFacts(reply, facts);
  const kinds = new Set(facts.map((fact) => fact.kind)).size;
  return cited.length >= 2 && (kinds < 2 || new Set(cited.map((fact) => fact.kind)).size >= 2);
}

const MOST_QUOTED = 10;
export const SYNTHESIS_HEAD = 'Take another look before this goes to the founder: they asked what to do next.';
export const synthesisNudge = (facts: Fact[]) => `${SYNTHESIS_HEAD} Answer across the company as it stands: name at least two of these standing facts, from different lines, `
  + `and say how each shapes your call.\n${facts.slice(0, MOST_QUOTED).map((fact) => fact.line).join('\n')}`;
export const UNTIED = '*Not tied to the standing facts.*';

// The partner's reply to "what now", held to the facts. `again` answers once more in words only with the nudge; a
// first answer that already did something, or a turn that already took its second look, is only labelled.
export async function holdSynthesis(asked: string, first: TurnResult, again: ((first: TurnResult, nudge: string) => Promise<TurnResult>) | undefined, facts: Fact[], lookedAgain = false): Promise<TurnResult> {
  if (first.stopped || !asksWhatNext(asked) || synthesises(first.text, facts)) return first;
  const label = (turn: TurnResult) => ({ ...turn, text: `${turn.text.replace(/\s+$/, '')}\n\n${UNTIED}` });
  if (lookedAgain || !again || didSomething(first)) return label(first);
  const second = await again(first, synthesisNudge(facts));
  const joined = { ...second, text: oneCall(stripStance(second.text)), tools: [...first.tools, ...second.tools], usage: { input: first.usage.input + second.usage.input, output: first.usage.output + second.usage.output } };
  return second.stopped || synthesises(joined.text, facts) ? joined : label(joined);
}
