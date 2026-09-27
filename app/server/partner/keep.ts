import { replaceSection } from '../tools/sections.ts';
import { filled, sectionBody } from '../tools/verdict.ts';
import { addToSection, sectionText } from './company.ts';

// The partner keeps the Company document current. Journey 5 found Idea, Customer and Numbers still empty after a week
// of the founder saying all of it in chat, so a new person on day six knew neither the name nor the cash. The facts
// are read here, in code, out of what the founder said: a price, the cash, the burn, a count of users or customers,
// and the one line of what the company does. They go into the matching section with a receipt under the reply.

export type CompanyFact = { label: string; value: string };
export type CompanyFacts = { numbers: CompanyFact[]; idea?: string; customer?: string };

const MONEY = /([$€£])\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k|m)\b)?((?:\s?\/\s?(?:month|mo|year|yr))|\s(?:per|a|an)\s(?:month|year|user|seat))?/gi;
const WORD_COUNTS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const COUNT = new RegExp(`\\b(\\d[\\d,]*|${WORD_COUNTS.join('|')})\\s+((?:(?:paying|active|beta|trial|free|pilot)\\s+){0,2})(users|customers|subscribers|clients)\\b`, 'gi');
// A sentence about what might be, what was or what is wanted is not where the company stands.
const NOT_NOW = /\b(?:if|would|could|should|plan\w*|want|goal|target|aim|will|next (?:week|month|year|quarter)|last (?:week|month|year|quarter)|ago|was|were|used to|by (?:the end|q\d))\b/i;
const BURN = /\b(?:burn\w*|spend\w*|expenses?|costs? us)\b/i;
const CASH = /\b(?:bank|cash|savings|saved|left|runway)\b/i;
const MRR = /\b(?:mrr|revenue|making|bringing in)\b/i;
const PRICE = /\b(?:charge|charging|price[ds]?|pricing|costs?|subscription|plan)\b/i;
// A request to the partner ("draft an update about what we are building") says what the founder wants, not what the company does.
const ASKING = /^(?:please\s+)?(?:draft|write|help|make|create|send|give|tell|show|plan|prepare|put|email|can you|could you|would you)\b|\b(?:what|how|why)\s+(?:i'?m|i am|we'?re|we are)\s+building\b/i;
const IDEA = /\b(?:(?:i'?m|i am|we'?re|we are)\s+building|we (?:make|build|sell|help)|(?:it|this) is an?)\b/i;

const sentences = (said: string) => said.split(/\n+/).flatMap((line) => line.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)).map((one) => one.trim()).filter(Boolean);
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export function companyFacts(said: string): CompanyFacts {
  const numbers: CompanyFact[] = [];
  const put = (label: string, value: string) => { if (!numbers.some((one) => one.label === label)) numbers.push({ label, value }); };
  let idea: string | undefined;
  for (const sentence of sentences(said)) {
    const plain = sentence.replace(/[.!]+$/, '');
    if (!idea && !sentence.endsWith('?') && !ASKING.test(plain) && IDEA.test(plain)) idea = plain.slice(0, 200);
    if (NOT_NOW.test(plain) || sentence.endsWith('?')) continue;
    for (const match of plain.matchAll(MONEY)) {
      // What the figure is: the words before it back to a comma, a colon or an "and", and the few words after it.
      const before = plain.slice(0, match.index).split(/[,;]|\band\b|\bbut\b/).at(-1) ?? '';
      const after = plain.slice(match.index + match[0].length).split(/[,;]|\band\b|\bbut\b|[$€£]/)[0].slice(0, 24);
      const value = match[0].trim();
      const period = !!match[4];
      if (BURN.test(before) && period) put('Burn', value);
      else if (CASH.test(before) || CASH.test(after)) put('Cash', value);
      else if (MRR.test(before) || MRR.test(after)) put('MRR', value);
      else if (period || PRICE.test(before)) put('Price', value);
    }
    for (const match of plain.matchAll(COUNT)) {
      // "an update for our 3 beta users" names who a thing is for, not how many there are now.
      if (/\b(?:to|for|with)\s+(?:(?:our|my|the|all|your)\s+)?$/i.test(plain.slice(0, match.index))) continue;
      const count = WORD_COUNTS.includes(match[1].toLowerCase()) ? String(WORD_COUNTS.indexOf(match[1].toLowerCase())) : match[1];
      put(capital(`${match[2].toLowerCase()}${match[3].toLowerCase()}`), count);
    }
  }
  const customer = idea ? /\bfor\s+(.+?)(?=\s+(?:that|who|which|to|so|by|with|from)\b|[,;:.]|$)/i.exec(idea.replace(/^[^:]*:\s*/, (head) => (/\bfor\b/i.test(head) ? head : '')))?.[1] : undefined;
  return { numbers, ...(idea ? { idea } : {}), ...(customer ? { customer: customer.trim() } : {}) };
}

// Where a Numbers line for one label is: "- Cash: €4,200 (founder, 2026-09-27)".
const lineOf = (label: string) => new RegExp(`^\\s*[-*]\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+?)(?:\\s+\\(founder, [\\d-]+\\))?\\s*$`, 'i');

// The document with the facts in it, and what went in, for the receipt. A figure goes in place of the one it
// updates and is left alone when it has not changed; Idea and Customer are written only while they are empty, since
// what the founder wrote there is theirs.
export function keepFacts(text: string, facts: CompanyFacts, day: string): { text: string; kept: string[] } {
  let next = text;
  const kept: string[] = [];
  const stamp = ` (founder, ${day})`;
  const changed: CompanyFact[] = [];
  if (facts.numbers.length) {
    const rows = sectionText(next, 'Numbers').split('\n');
    const added: string[] = [];
    for (const fact of facts.numbers) {
      const at = rows.findIndex((row) => lineOf(fact.label).test(row));
      if (at >= 0 && lineOf(fact.label).exec(rows[at])![1].trim() === fact.value) continue;
      const line = `- ${fact.label}: ${fact.value}${stamp}`;
      if (at >= 0) rows[at] = line; else added.push(line);
      changed.push(fact);
    }
    if (changed.length) {
      const body = [...rows.filter((row, index) => row.trim() || index > 0), ...added].join('\n').trim();
      const swapped = replaceSection(next, 'Numbers', body);
      next = 'text' in swapped ? swapped.text : addToSection(next, 'Numbers', body.split('\n'));
      kept.push(`Numbers (${changed.map((fact) => `${fact.label} ${fact.value}`).join(', ')})`);
    }
  }
  for (const [heading, line] of [['Idea', facts.idea], ['Customer', facts.customer]] as const) {
    if (!line || filled(sectionBody(next, heading)).length) continue;
    next = addToSection(next, heading, [`- ${line}${stamp}`]);
    kept.push(heading);
  }
  return { text: next, kept };
}

export const keptLine = (kept: string[]) => `*Kept in the Company document: ${kept.join(', ')}.*`;

// ---------------------------------------------------------------- runway in months

// A money figure as a number: "€4,200" is 4200, "$80k" is 80000.
const amount = (value: string) => {
  const found = /(\d[\d,]*(?:\.\d+)?)\s?(k|m)?/i.exec(value);
  if (!found) return null;
  return Number(found[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[(found[2] ?? '').toLowerCase() as 'k'] ?? 1);
};
const MONTHS = /(\d+(?:\.\d+)?)(\s?(?:-|–)?\s?months?)\b/gi;
const RUNWAY_WORDS = /\b(?:runway|cash|bank|burn|run out|left|remaining)\b/i;
// Said as a bound, not a figure: "under 4 months" is true of 3.8.
const BOUND = /\b(?:under|less than|below|nearly|almost|short of|not even|at most|up to)\s*(?:~|\*\*)?\s*$/i;

// Runway is never rounded toward the better side. A months figure in a sentence about runway or cash that is a
// rounded-up version of cash over burn, as the Company numbers or the founder have them, gets the months to one
// decimal, rounded down, beside it: "4 months (3.8 months)". A figure past the next whole month is left alone, since
// it may count revenue against the burn.
export function runwayFix(reply: string, facts: string): string {
  const numbers = companyFacts(facts).numbers;
  const cash = amount(numbers.find((one) => one.label === 'Cash')?.value ?? '');
  const burn = amount(numbers.find((one) => one.label === 'Burn')?.value ?? '');
  if (!cash || !burn) return reply;
  const exact = cash / burn;
  const down = Math.floor(exact * 10) / 10;
  return reply.replace(MONTHS, (whole, figure: string, unit: string, at: number) => {
    const value = Number(figure);
    const sentence = reply.slice(Math.max(reply.lastIndexOf('.', at - 1), reply.lastIndexOf('\n', at - 1)) + 1).split(/[.!?](?:\s|$)|\n/)[0];
    const before = reply.slice(Math.max(0, at - 30), at);
    if (value <= exact + 1e-9 || value - exact >= 1 || /\.\d{2,}/.test(figure) || BOUND.test(before) || !RUNWAY_WORDS.test(sentence) || /\bif\b/i.test(sentence)) return whole;
    return `${figure}${unit} (${down} months)`;
  });
}
