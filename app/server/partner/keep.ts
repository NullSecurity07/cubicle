import { replaceSection } from '../tools/sections.ts';
import { filled, sectionBody } from '../tools/verdict.ts';
import { addToSection, sectionText } from './company.ts';

// The partner keeps the Company document current. Journey 5 found Idea, Customer and Numbers still empty after a week
// of the founder saying all of it in chat, so a new person on day six knew neither the name nor the cash. The facts
// are read here, in code, out of what the founder said: a price, the cash, the burn, a count of users or customers,
// and the one line of what the company does. They go into the matching section with a receipt under the reply.

// `sure`: a count said as a plain statement of where the company stands ("we have 3 paying users"), which may take the
// place of a count already in the document; one said in passing may only fill an empty place.
export type CompanyFact = { label: string; value: string; sure?: boolean };
export type CompanyFacts = { numbers: CompanyFact[]; idea?: string; customer?: string };

const MONEY = /([$€£])\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(k|m)\b)?((?:\s?\/\s?(?:month|mo|year|yr))|\s(?:per|a|an)\s(?:month|year|user|seat))?/gi;
const WORD_COUNTS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const COUNT = new RegExp(`\\b(\\d[\\d,]*|${WORD_COUNTS.join('|')})\\s+((?:(?:paying|active|beta|trial|free|pilot)\\s+){0,2})(users|customers|subscribers|clients)\\b`, 'gi');
// A sentence about what might be, what was or what is wanted is not where the company stands.
const NOT_NOW = /\b(?:if|would|could|should|plan(?:ning|s)?\s+(?:to|how)|planned|help me plan|want|goal|target|aim|will|next (?:week|month|year|quarter)|last (?:week|month|year|quarter)|ago|was|were|used to|by (?:the end|q\d))\b/i;
// The burn is the whole month's outgoing, said as such: one bill ("$300/month on ads", "hosting costs us $50/month")
// is not it, and never takes its place.
const BURN = /\b(?:burn\w*|expenses?|total\s+(?:spend\w*|costs?)|monthly\s+spend\w*|spend\w*\s+in\s+total)\b/i;
const CASH = /\b(?:bank|cash|savings|saved|left|runway)\b/i;
const MRR = /\b(?:mrr|revenue|making|bringing in)\b/i;
// A request to the partner ("draft an update about what we are building") says what the founder wants, not what the company does.
const ASKING = /^(?:please\s+)?(?:draft|write|help|make|create|send|give|tell|show|plan|prepare|put|email|can you|could you|would you)\b|\b(?:what|how|why)\s+(?:i'?m|i am|we'?re|we are)\s+building\b/i;
// A price is the company's own only when the company is the one charging: "we charge", "our price is", "we sell at",
// "$39/month for our base plan", or the line that says what the company is. A competitor's price, a cost the company
// pays, a hire, a customer's words and a market range are not.
const OURS_BEFORE = /\b(?:we|i)\s+(?:charge|sell|bill|price)\w*|\bour\s+(?!competitors?\b|rivals?\b)(?:\w+\s+)?(?:price|pricing|plan|subscription|tier)\b/i;
// "The price is $39/month" with nobody else named: only a clause that opens with the price itself.
const BARE_PRICE = /^\s*(?:(?:the|its|this|my)\s+(?:\w+\s+)?)?(?:price|priced|pricing)\s+(?:is|at|of)\b/i;
const OURS_AFTER = /^\s*(?:for\s+(?:our|the\s+(?:base|pro|starter|team))\b|per\s+(?:user|seat)\s+for\s+our\b)/i;
const THEIRS = /\b(?:competitors?|rivals?|they|their|customers?|clients?|users?|accountants?|agenc(?:y|ies)|freelancers?|hosting|hiring|pay\w*|wrote|said|market)\b/i;
// "I'm building Ledgerly: $29/month bookkeeping": the price of the thing the founder says they are building.
const BUILDING_PRICE = /\b(?:i'?m|i am|we'?re|we are)\s+building\s+[\w-]+\s*[:,\u2013\u2014-]\s*$/i;
function ours(sentence: string, at: number, length: number): boolean {
  const before = sentence.slice(0, at);
  // Words in quotes are somebody else's.
  if ((before.match(/["\u201c\u201d]/g) ?? []).length % 2 === 1 || /\b(?:wrote|said|says)\s*:/i.test(before)) return false;
  // Only the clause holding the figure says whose it is: "we have 3 paying users and charge $29/month" is ours, and
  // "we charge customers $29/month" is ours because the company is the one charging.
  const clause = before.split(/[,;]|\band\b|\bbut\b/).at(-1) ?? '';
  // "We have 3 users and charge $29/month": the "we" of the sentence charges in the second clause too.
  if (OURS_BEFORE.test(clause) || (/^\s*(?:charge|sell|bill)\w*\b/i.test(clause) && /^\s*(?:we|i)\b/i.test(sentence))) return true;
  if (THEIRS.test(clause)) return false;
  return BUILDING_PRICE.test(before) || BARE_PRICE.test(clause) || OURS_AFTER.test(sentence.slice(at + length));
}
// What the company does: "I'm building …", or "we make / build / sell / help …" when what follows is not money
// ("we make $300 a month" is revenue). A remark ("this is a hard week") is not the idea, and neither is a sentence
// that holds money, unless it is the "building" line itself.
const BUILDING = /\b(?:i'?m|i am|we'?re|we are)\s+building\b/i;
const WE_DO = /\bwe (?:make|build|sell|help)\b(?!\s+(?:about\s+|around\s+|roughly\s+)?(?:[$€£\d]|money\b))/i;
const HAS_MONEY = /[$€£]\s?\d|\b\d[\d,.]*\s?(?:k|m)?\s?(?:mrr|arr|dollars|euros|pounds)\b/i;
// "Ledgerly is a $29/month bookkeeping tool for EU solo consultants": the company by its name, a thing, and who for.
// Only with a product noun before "for": "Xero is a competitor for small firms" and "Monday is a good day for calls"
// are not what the company does. The founder's own "I'm building" or "we make" wins over a sentence by a name.
const NAMED = /^(?!(?:This|That|It|There|Today|Tomorrow|Life|Everything|Nothing|He|She|They|We|I|Our|My|The|A|An)\b)[A-Z][\w-]+\s+is\s+an?\s+[^.]*?\b(?:tool|app|platform|service|product|software|marketplace|newsletter|saas|api)s?\b[^.]*\bfor\b/;
const isIdea = (sentence: string) => BUILDING.test(sentence) || (WE_DO.test(sentence) && !HAS_MONEY.test(sentence));
// Who it is for is a group of people, never a length of time.
const TIME = /\d|\b(?:years?|months?|weeks?|days?|time|now|while|future|long)\b/i;

const TARGET_BEFORE = /\b(?:until|till|once|when|target\w*|goal|aim\w*|reach\w*|hits?|get(?:s|ting)? to|at|by|of|than|over|under)\s+(?:[\w']+\s+){0,2}$/i;
// "We have 3", "we now have 4", "there are 12", or the count opening its sentence ("120 customers so far").
const PLAIN_COUNT = /(?:\b(?:we|i)\s+(?:now\s+|still\s+|already\s+)?(?:have|'ve got|'ve|got|serve)\s+(?:\w+\s+){0,2}|\bthere\s+are\s+(?:now\s+)?|^\s*(?:(?:and|now|so far|today),?\s+)?)$/i;
const sentences = (said: string) => said.split(/\n+/).flatMap((line) => line.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)).map((one) => one.trim()).filter(Boolean);
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export function companyFacts(said: string): CompanyFacts {
  const numbers: CompanyFact[] = [];
  const put = (label: string, value: string) => { if (!numbers.some((one) => one.label === label)) numbers.push({ label, value }); };
  let idea: string | undefined;
  let named: string | undefined;
  let question = false;
  for (const sentence of sentences(said)) {
    const plain = sentence.replace(/[.!]+$/, '');
    // A sentence right after a question answers it or lays out choices ("should I build now? Maybe at 20 users."):
    // its counts are not where the company stands unless it says so plainly.
    const afterQuestion = question;
    question = sentence.endsWith('?');
    if (!idea && !sentence.endsWith('?') && !ASKING.test(plain) && isIdea(plain)) idea = plain.slice(0, 200);
    if (!named && !sentence.endsWith('?') && NAMED.test(plain)) named = plain.slice(0, 200);
    if (NOT_NOW.test(plain) || sentence.endsWith('?')) continue;
    for (const match of plain.matchAll(MONEY)) {
      // What the figure is: the words before it back to a comma, a colon or an "and", and the few words after it.
      const before = plain.slice(0, match.index).split(/[,;]|\band\b|\bbut\b/).at(-1) ?? '';
      const after = plain.slice(match.index + match[0].length).split(/[,;]|\band\b|\bbut\b|[$€£]/)[0].slice(0, 24);
      const value = match[0].trim();
      const period = !!match[4];
      if (BURN.test(before) && period) { if (!/^\s*(?:on|for)\b/i.test(after)) put('Burn', value); }
      else if (CASH.test(before) || CASH.test(after)) put('Cash', value);
      else if (MRR.test(before) || MRR.test(after)) put('MRR', value);
      else if (ours(plain, match.index, match[0].length)) put('Price', value);
    }
    // A choice ("Options: build it now, or wait until 10 paying users") names no count the company has.
    const choice = /\boptions?\b|\s\bor\b\s/i.test(plain);
    for (const match of plain.matchAll(COUNT)) {
      const lead = plain.slice(0, match.index);
      // "an update for our 3 beta users" names who a thing is for, not how many there are now; "until 10 paying
      // users", "once we reach 50", "our goal is 100", "at 20 users", "two of the 5 users" name a target or a part.
      if (/\b(?:to|for|with)\s+(?:(?:our|my|the|all|your)\s+)?$/i.test(lead) || TARGET_BEFORE.test(lead)) continue;
      const sure = PLAIN_COUNT.test(lead);
      if (choice || (afterQuestion && !sure)) continue;
      const count = WORD_COUNTS.includes(match[1].toLowerCase()) ? String(WORD_COUNTS.indexOf(match[1].toLowerCase())) : match[1];
      const label = capital(`${match[2].toLowerCase()}${match[3].toLowerCase()}`);
      // "3 paying beta users … two of the three users": one count, kept the first way it was said.
      if (numbers.some((one) => countFamily(one.label) === countFamily(label))) continue;
      if (!numbers.some((one) => one.label === label)) numbers.push({ label, value: count, ...(sure ? { sure } : {}) });
    }
  }
  idea ??= named;
  const customer = idea ? /\bfor\s+(.+?)(?=\s+(?:that|who|which|to|so|by|with|from)\b|[,;:.]|$)/i.exec(idea.replace(/^[^:]*:\s*/, (head) => (/\bfor\b/i.test(head) ? head : '')))?.[1] : undefined;
  return { numbers, ...(idea ? { idea } : {}), ...(customer && !TIME.test(customer) ? { customer: customer.trim() } : {}) };
}

// Where a Numbers line for one label is: "- Cash: €4,200 (founder, 2026-09-27)".
const lineOf = (label: string) => new RegExp(`^\\s*[-*]\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+?)(?:\\s+\\(founder, [\\d-]+\\))?\\s*$`, 'i');

const MONEY_ROWS: Record<string, RegExp> = { Burn: /\bburn/i, Cash: /\b(?:cash|bank)\b/i, MRR: /\b(?:mrr|revenue)\b/i, Price: /\bpric(?:e|ing)\b/i };

// A Numbers row that counts people: "- Paying users: 3", "- 3 paying beta users", "- Customers: 3".
const COUNT_ROW = /^\s*[-*]\s+(?:[\w -]*?\b(?:users|customers|subscribers|clients)\s*:|(?:\d[\d,]*|\w+)\s+(?:[\w-]+\s+){0,2}(?:users|customers|subscribers|clients)\b)/i;
// Paying, beta and bare users or customers are one count; a total, a waitlist, the churned, the interviewed, the active, a target or
// the free ones are each their own.
const OTHER_COUNT = /\b(total|waitlist|wait-list|waiting|churn\w*|interview\w*|lost|active|target|goal|free|trial|new|signups?)\b/i;
const countFamily = (text: string) => (!/\b(?:users|customers|subscribers|clients)\b/i.test(text) ? null : OTHER_COUNT.exec(text)?.[1].toLowerCase().replace(/^churn\w*$/, 'churned').replace(/^interview\w*$/, 'interviewed') ?? 'paying');

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
      // Users, customers, paying users: one row, however they were counted before. Free or trial users are their own.
      const family = countFamily(fact.label);
      if (family) {
        // A second count of the same kind in one message never makes a second row.
        if (changed.some((one) => countFamily(one.label) === family)) continue;
        const counts = rows.map((row, index) => ({ row, index })).filter(({ row }) => COUNT_ROW.test(row) && countFamily(row) === family);
        if (counts.length === 1 && Number(/(\d[\d,]*)/.exec(counts[0].row.replace(/\(founder, [\d-]+\)/, ''))?.[1].replace(/,/g, '')) === Number(fact.value.replace(/,/g, ''))) continue;
        // A count said in passing never takes the place of one already there.
        if (counts.length && !fact.sure) continue;
        const line = `- ${fact.label}: ${fact.value}${stamp}`;
        if (counts.length) { rows[counts[0].index] = line; for (const extra of counts.slice(1).reverse()) rows.splice(extra.index, 1); } else added.push(line);
        changed.push(fact);
        continue;
      }
      // The row for this figure, however it is labelled ("- Monthly burn: €1,100" is the Burn row): the same amount
      // leaves it as it is, a new one takes its place.
      const key = MONEY_ROWS[fact.label];
      // A target, a plan, a forecast or a loan is its own row, never the company's figure now.
      const labelOf = (row: string) => /^\s*[-*]\s+([^:]{1,40}):/.exec(row)?.[1] ?? '';
      const at = rows.findIndex((row) => lineOf(fact.label).test(row) || (!!key && key.test(labelOf(row)) && !/\b(?:target|goal|plan\w*|forecast|loan|debt)\b/i.test(labelOf(row))));
      const was = at >= 0 ? (/^\s*[-*]\s+[^:]{1,40}:\s*(.+?)(?:\s+\(founder, [\d-]+\))?\s*$/.exec(rows[at])?.[1] ?? '') : '';
      if (at >= 0 && (was.trim() === fact.value || (amount(was) === amount(fact.value) && was.trim()[0] === fact.value[0]))) continue;
      // A Price line the founder typed into the document is theirs: it is never written over from chat.
      if (at >= 0 && fact.label === 'Price' && !/\(founder, [\d-]+\)\s*$/.test(rows[at])) continue;
      const line = `- ${fact.label}: ${fact.value}${stamp}`;
      if (at >= 0) rows[at] = line; else added.push(line);
      changed.push(fact);
    }
    if (changed.length) {
      const body = [rows.join('\n').trim(), ...added].filter(Boolean).join('\n');
      const swapped = replaceSection(next, 'Numbers', body);
      next = 'text' in swapped ? swapped.text : addToSection(next, 'Numbers', body.split('\n'));
      kept.push(`Numbers (${changed.map((fact) => `${fact.label} ${fact.value}`).join(', ')})`);
    }
  }
  for (const [heading, line] of [['Idea', facts.idea], ['Customer', facts.customer]] as const) {
    if (!line || filled(sectionBody(next, heading)).length) continue;
    // The idea already in the document anywhere (the partner may have written it elsewhere): never a second copy.
    if (heading === 'Idea' && next.toLowerCase().includes(line.slice(0, 40).toLowerCase())) continue;
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
const RUNWAY_WORDS = /\b(?:runway|left|remaining|of cash|in the bank)\b/i;
// Said as a bound, not a figure: "under 4 months" is true of 3.8.
// A floor is a bound too: "at least 6 months of runway" is a precondition, not the runway now (journey 9).
const BOUND = /\b(?:under|less than|below|nearly|almost|short of|not even|at most|up to|at least|more than|over|above|a minimum of|minimum)\s*(?:~|\*\*)?\s*$/i;
// Another input in the sentence: a scenario ("new", "if", "after", "would"), or a comparison ("vs", "from 5.9 to 6").
const SCENARIO = /\b(?:new|if|after|assum\w*|would|could|instead|scenario|once)\b/i;
const COMPARED = /\b(?:vs\.?|versus|compared|than|from\b[^.!?\n]*\bto)\b|→|->/i;
// A money figure in the sentence: "€1,500 burn" or "with €19" puts a figure in that is not the Numbers' own.
const SUM_SAID = /[$€£]\s?\d[\d,]*(?:\.\d+)?\s?[km]?\b|\b\d[\d,]*(?:\.\d+)?\s?(?:[km]\b\s*)?(?:dollars|euros|pounds|usd|eur)\b/gi;

// Runway is never rounded toward the better side. A months figure in a sentence about runway or cash that is
// cash over burn of the current Company numbers rounded up (to the whole month, or to the tenth it is said in) gets
// the months to one decimal, rounded down, beside it: "4 months (3.8 months)". Journey 9 pasted "(5.9 months)" after
// "New runway: 6.4 months" and "At least 6 months", so it is put only once, and never beside a bound, a scenario, a
// comparison, another money figure than the Numbers' own, or a sentence that already says the right months.
export function runwayFix(reply: string, facts: string): string {
  const numbers = companyFacts(facts).numbers;
  const cash = amount(numbers.find((one) => one.label === 'Cash')?.value ?? '');
  const burn = amount(numbers.find((one) => one.label === 'Burn')?.value ?? '');
  if (!cash || !burn) return reply;
  const exact = cash / burn;
  const down = Math.floor(exact * 10) / 10;
  // With MRR in the Numbers, a runway worked on the net burn is right up to cash over (burn - MRR).
  const mrr = amount(numbers.find((one) => one.label === 'MRR')?.value ?? '') ?? 0;
  const most = mrr > 0 && mrr < burn ? cash / (burn - mrr) : exact;
  return reply.replace(MONTHS, (whole, figure: string, unit: string, at: number) => {
    const value = Number(figure);
    const start = Math.max(reply.lastIndexOf('. ', at - 1), reply.lastIndexOf('\n', at - 1)) + 1;
    const sentence = `${reply.slice(start, at)}${reply.slice(at).split(/[.!?](?:\s|$)|\n/)[0]}`;
    const before = reply.slice(Math.max(0, at - 30), at);
    // The clause the figure is in, not the whole sentence: "a round takes 3 to 4 months, and you run out of cash
    // first" names a duration, and runway only in the next clause.
    const clause = `${reply.slice(start, at).split(/[,;]|\band\b|\bso\b|\bbut\b/).at(-1)}${whole}${reply.slice(at + whole.length).split(/[,;.!?\n]|\band\b|\bbut\b/)[0]}`;
    if (value <= most + 1e-9 || value - exact >= 1 || /\.\d{2,}/.test(figure) || BOUND.test(before) || /\d\s*(?:to|–|-)\s*$/.test(before)) return whole;
    if (!RUNWAY_WORDS.test(clause) || /\b(?:net|mrr|revenue)\b/i.test(sentence)) return whole;
    // Rounded up from the current figure, at the precision it is said in: 6 or 6.0 from 5.94, never 6.4.
    const tenths = figure.includes('.');
    if (value !== (tenths ? Math.ceil(exact * 10) / 10 : Math.ceil(exact))) return whole;
    if (SCENARIO.test(sentence) || COMPARED.test(sentence)) return whole;
    if ([...sentence.matchAll(SUM_SAID)].some((found) => ![cash, burn, mrr].includes(amount(found[0]) ?? -1))) return whole;
    // Said already: the right months beside it, or anywhere in the sentence.
    if (new RegExp(`(?:^|[^\\d.])${String(down).replace('.', '\\.')}\\s?-?\\s?months?\\b`, 'i').test(sentence)) return whole;
    return `${figure}${unit} (${down} months)`;
  });
}
