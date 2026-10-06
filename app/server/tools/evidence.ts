// What a team doc with rules may say about the world, held to what was really read. Journey 10: Meera wrote "Real
// customer conversations done: 2", "retention OK among the 2 paying" and "3+ hours per test" into the Evaluation
// doc, none of it said by anyone, and the judge built her verdict on it. The figure check before this skipped counts
// of ten or less and every claim made in words. Two checks, on the lines a write adds:
// - a count must be in something read, the same number however it was written, within a few words of the word for
//   what it counts: the "2" of "2 paying" is no source for "2 real customer conversations";
// - on a pain, conversations or traction section, a claim of evidence ("retention OK", "customers love it",
//   "validated", "we've had two conversations") needs a founder's sentence or a tool result that says it. A document
//   is no source here: a colleague's invented line in it would do. Said as a view ("I think", "likely") it stands,
//   marked "(assumption)".

import { calculate } from './calc.ts';

const EVIDENCE = /\b(?:pain|conversations?|interviews?|traction|evidence)\b/i;
const HEADING = /^\s*#{1,6}\s+(.*)$/;
const MARKER = /^\s*(?:[-*+>]\s+)?\(From chat:/;

// Words that say nothing about what is counted.
const SMALL = new Set(('the and for with from that this have has had been were was are they them their there what which when where who about into '
  + 'whom over just also very really only some among than then your our ours each more most such much many other its his her you not but all any '
  + 'per done one two out get got can our via yet now so of to in on at by as is it be we i a an or no').split(' '));
// Words that name one thing: a talk with a customer is a conversation, an interview, a call.
const SAME: [RegExp, string][] = [[/^(?:conversations?|interviews?|interviewed|calls?|called|talks?|talked|spoke|chats?|meetings?|met)$/, 'conversation']];
const stem = (word: string) => {
  const low = word.toLowerCase();
  const same = SAME.find(([pattern]) => pattern.test(low));
  return same ? same[1] : low.replace(/(?:ing|ed|es|s)$/, '');
};
const alike = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

// A source cut into sentences, each without its list number or heading number, so "## 3. Is the pain real?" is no
// source for a "3". A table row is a line, so it is one sentence too.
const sentencesOf = (sources: string[]) => sources.flatMap((source) => source.split(/\n|(?<=[.!?;])\s+/))
  .map((line) => line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*(?:[-*+]\s+)?\d+[.)]\s+/, '').trim()).filter(Boolean);
const valueOf = (digits: string) => Number(digits.replace(/,/g, ''));

// A number as read, however it was written: "12", "12.0", "1,200", "1.2k", "15%", "15 percent", "€78", "twelve",
// "twenty-five", "a dozen". Each word of a sentence in order, as its value or its stem, so how far a number stands from
// a word can be told.
const SPELLED = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
function spelled(word: string): number | null {
  const [tens, one] = word.toLowerCase().split('-');
  if (word.toLowerCase() === 'dozen') return 12;
  const ten = TENS.indexOf(tens);
  if (ten >= 0) return (ten + 2) * 10 + (one ? Math.max(SPELLED.indexOf(one), 0) : 0);
  return !one && SPELLED.includes(tens) ? SPELLED.indexOf(tens) : null;
}
// `free`: a number a sum worked out from figures read, which backs a count of anything, since the sum carries no words.
type Token = { value?: number; word?: string; free?: boolean };
const TOKENS = /(?:[$€£]\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(k|m|thousand|million)\b)?(?:\s?(?:%|percent\b))?|[\p{L}][\p{L}'-]*/giu;
function tokensOf(sentence: string): Token[] {
  return [...sentence.matchAll(TOKENS)].map((match) => {
    if (match[1] !== undefined) {
      const scale = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6 }[match[3]?.toLowerCase() ?? ''] ?? 1;
      return { value: Number(`${match[1].replace(/,/g, '')}${match[2] ?? ''}`) * scale };
    }
    const value = spelled(match[0]);
    return value === null ? { word: stem(match[0]) } : { value };
  });
}

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
// A whole number, not part of a decimal, a version, a date, a time, a fraction, money, a share, an ordinal or a
// "7-day": those are the figure check's, or no count at all.
const COUNT = /(?<![\p{L}\d.,:/$€£#\-–—]|[$€£]\s)(\d{1,3}(?:,\d{3})+|\d+)(\+?)(?![\d]|[.,]\d|\s*(?:%|percent\b|\/|:\d|-[a-z]|[kmb]n?\b|x\b|×|\(unsourced\))|(?:st|nd|rd|th|am|pm)\b)/giu;
const DATE_AFTER = new RegExp(`^\\s+(?:${MONTHS})\\b`, 'i');
const DATE_BEFORE = new RegExp(`\\b(?:${MONTHS})\\.?\\s+$`, 'i');
// A number that names a step, not a count of anything: "week 2", "step 3", "top 5", "v2".
const NAMES = /\b(?:step|day|week|phase|round|version|chapter|part|item|no|page|slide|section|stage|level|tier|option|batch|sprint|line|row|column|figure|table|pass|slice|task|issue|top|rank|ranked|number|q)\s*#?$/i;
// A count put as a plan, a goal or advice is the writer's proposal, not a claim: "cheapest test: interview 5 hosts",
// "conduct 8 more conversations".
const AHEAD = /\b(?:next|goal|target|aim|plan|planned|should|needs?|must|will|would|could|cheapest|try|if|want|wants)\b/i;
const ORDER = /^[\s\W]*(?:conduct|interview|talk|call|run|book|ask|reach|get|find|recruit|email|survey|schedule|do|test)\b/i;
// Words a label or a phrase carries that say nothing about what is counted.
const WEAK = new Set('done total number count real currently overall least roughly approx approximately far'.split(' '));
const content = (text: string) => (text.match(/[\p{L}][\p{L}'-]*/gu) ?? []).filter((word) => word.length > 2 && !SMALL.has(word.toLowerCase()) && !WEAK.has(word.toLowerCase()));
// The head of a run of words: its last, unless that is a verb ("sessions logged", "users contacted").
const headOf = (words: string[]) => {
  const nouns = words.filter((word) => !/(?:ed|ing)$/i.test(word));
  const last = nouns.at(-1) ?? words.at(-1);
  return last ? stem(last) : null;
};

// The word that names what a count counts. The words right after it, up to a stop word or a mark ("12 beta users
// logged" counts users, "3+ hours per test" hours); with none, the label before the line's colon or the row's first
// cell ("Real customer conversations done: 2" counts conversations); else the word before it.
function countedBy(sentence: string, at: number, length: number): string | null {
  const rest = sentence.slice(at + length).match(/^[^,.;:()!?|"“”\[\]]*/)![0];
  const after: string[] = [];
  for (const word of rest.match(/[\p{L}][\p{L}'-]*/gu) ?? []) {
    if (after.length === 3 || SMALL.has(word.toLowerCase())) break;
    if (word.length > 2 && !WEAK.has(word.toLowerCase())) after.push(word);
  }
  if (after.length) return headOf(after);
  const before = sentence.slice(0, at);
  const colon = before.lastIndexOf(':');
  if (colon >= 0 && !before.slice(colon + 1).trim()) return headOf(content(before.slice(0, colon).replace(/\([^)]*\)/g, ' ')));
  const cell = /\|\s*$/.test(before) ? before.replace(/\|\s*$/, '').split('|').filter((one) => one.trim()).at(-1) : null;
  if (cell) return headOf(content(cell));
  return headOf(content(before.slice(colon + 1)).slice(-1));
}

// How many words apart a number read and the word for what it counts may stand: "12 beta users" and "Beta users: 12"
// both hold, "12 beta testers and 3 paying users" holds no "12 users".
const NEAR = 4;
// A sentence read that holds the same number with the word for what it counts beside it. A count with no such word is
// held to its number alone.
function backed(value: number, counted: string | null, sources: Token[][]): boolean {
  return sources.some((tokens) => tokens.some((token, index) => token.value === value
    && (token.free || !counted || tokens.slice(Math.max(0, index - NEAR), index + NEAR + 1).some((one) => one.word && alike(one.word, counted)))));
}

type Unbacked = { label: string; end: number };
// The counts on a line nothing read gives for what they count, with where each number ends on the line. `strict` holds
// plans and orders too, for a colleague's answer, where every count is a claim about what was read.
function unbackedCounts(line: string, sources: Token[][], quoted = '', strict = false): Unbacked[] {
  const found: Unbacked[] = [];
  // A quote of something read is left as it is: "the founder said “we have 12 users”" quotes, it does not claim.
  const quotes = [...line.matchAll(/["“]([^"”]{3,})["”]/g)].filter((match) => quoted.includes(flat(match[1])))
    .map((match) => [match.index!, match.index! + match[0].length]);
  // Each sentence on its own; a "?" in a template label ("survivable?") ends one too.
  // The list number goes first, or "1." would be read as a sentence of its own.
  const listed = line.replace(/^\s*(?:[-*+]\s+)?\d+[.)]\s+/, (lead) => ' '.repeat(lead.length));
  let offset = 0;
  for (const body of listed.split(/(?<=[.!?;])\s+/)) {
    const start = listed.indexOf(body, offset);
    offset = start + body.length;
    const misses: (Unbacked & { value: number })[] = [];
    const shown: number[] = [];
    for (const match of body.matchAll(COUNT)) {
      const at = match.index!;
      const value = valueOf(match[1]);
      const before = body.slice(0, at);
      const rest = body.slice(at + match[0].length);
      if (value >= 1900 && value <= 2099) continue;
      if (DATE_AFTER.test(rest) || DATE_BEFORE.test(before) || NAMES.test(before)) continue;
      // A section named by number, "(3)" or "section 3".
      if (/\($/.test(before) && /^\)/.test(rest)) continue;
      if (quotes.some(([from, to]) => start + at >= from && start + at < to)) continue;
      // Marked by the writer or the figure check a few words on: "200 users (unsourced)".
      if (/^\s*(?:[\p{L}'-]+\s+){0,3}\(unsourced\)/u.test(rest)) continue;
      if (!strict && (AHEAD.test(before) || /^\s+more\b/i.test(rest) || ORDER.test(before.slice(before.lastIndexOf(':') + 1)))) continue;
      if (backed(value, countedBy(body, at, match[0].length), sources)) { shown.push(value); continue; }
      misses.push({ label: `${match[1]}${match[2]}`, end: start + at + match[1].length + match[2].length, value });
    }
    // A total the line works out in front of the reader from counts read: "14 in all (12 beta + 2 paying)".
    const worked = (value: number) => shown.some((a, i) => shown.some((b, j) => i !== j && (a + b === value || a - b === value || a * b === value)))
      || (shown.length > 1 && shown.reduce((sum, one) => sum + one, 0) === value);
    found.push(...misses.filter((miss) => !worked(miss.value)).map(({ label, end }) => ({ label, end })));
  }
  return found;
}
const flat = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();

// A sum as the calc tool gives it back, "7200 / 900 = 8" or "900 / 29 = 31.03448276 (exact: 31.034482758620690)", worked
// again here so only true arithmetic counts. Journey 12: a person worked out a runway of 8 months and 32 paying studios
// to break even with calc from the brief's figures, and the doc marked both "(unsourced)", since the sum names no
// months and no studios. Its result, its rounding up or down ("31.03 studios" means 32 to break even) and every number
// in its working are read, when each number in the working is: one nothing gives makes the whole sum unsourced.
const SUM = /^\s*(.+?)\s=\s(-?\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?)(?:\s\(exact:\s[^)]+\))?\s*$/i;
const FUNCTIONS = /\b(?:min|max|sum|avg|round|floor|ceil|abs|sqrt)\b/g;
// What a sum may use without a source: nothing, one, a pair, a year's months, a hundred for a share.
const CONSTANTS = new Set([0, 1, 2, 12, 100]);
function sumOf(line: string): { inputs: number[]; results: number[] } | null {
  const match = SUM.exec(line);
  if (!match) return null;
  const working = match[1];
  if (!/\d/.test(working) || !/^[\d\s.+\-*/%^(),e]*$/i.test(working.replace(FUNCTIONS, ''))) return null;
  let value: number;
  try { value = calculate(working).value; } catch { return null; }
  const shown = Number(match[2].replace(/,/g, ''));
  if (Math.abs(value - shown) > Math.abs(value) * 1e-8 + 1e-9) return null;
  const inputs = [...working.replace(FUNCTIONS, '').matchAll(/\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)].map((one) => Number(one[0]));
  return { inputs, results: [...new Set([shown, value, Math.ceil(value), Math.floor(value)])] };
}

// A count the doc tools or the writer marked "(unsourced)" is no source for itself said again, nor is the sum it went into;
// nor is a doc tool's report of the marks it put in, whose label sits beside the words of its line.
const unmarked = (source: string) => source.split('\n').filter((line) => !/\bMarked as unsourced\b/.test(line)).join('\n')
  .replace(/\S+\s*\(unsourced\)/gi, '');

// The sources with every sum taken out, and the sums whose working rests on what was read, in turn: a sum may build on
// an earlier sum's result.
function sortSums(sources: string[]): { plain: string[]; sums: string[]; free: number[] } {
  const plain: string[] = [];
  const pending: { line: string; inputs: number[]; results: number[] }[] = [];
  for (const source of sources.map(unmarked)) {
    const kept: string[] = [];
    for (const line of source.split('\n')) {
      const sum = sumOf(line);
      if (sum) pending.push({ line, ...sum });
      else kept.push(line);
    }
    plain.push(kept.join('\n'));
  }
  const known = new Set(sentencesOf(plain).flatMap(tokensOf).flatMap((token) => (token.value === undefined ? [] : [token.value])));
  const read = (value: number) => CONSTANTS.has(value) || known.has(value) || known.has(Number((value * 100).toPrecision(12)));
  const sums: string[] = [];
  const free: number[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const sum of [...pending]) {
      if (!sum.inputs.every(read)) continue;
      pending.splice(pending.indexOf(sum), 1);
      sums.push(sum.line);
      for (const value of [...sum.inputs, ...sum.results]) { free.push(value); known.add(value); }
      grew = true;
    }
  }
  return { plain, sums, free };
}

// The sources a figure check may take as read: a sum whose working rests on a figure nothing gives is left out, so its
// result is unsourced like its input.
export function readableSources(sources: string[]): string[] {
  const { plain, sums } = sortSums(sources);
  return [...plain, ...sums];
}

const sourceTokens = (sources: string[]): Token[][] => {
  const { plain, free } = sortSums(sources);
  return [...sentencesOf(plain).map(tokensOf), ...free.map((value) => [{ value, free: true }])];
};

// The sentences of a colleague's answer whose every count is in what that colleague read, said of the same thing: the
// part of it that may back a count in the asker's write. What they said from their own head backs nothing.
export function heardFrom(answer: string, read: string[]): string[] {
  const sources = sourceTokens(read);
  // A count said in words is a count too: "twelve beta users" is held as "12 beta users".
  const digits = (sentence: string) => sentence.replace(/[\p{L}][\p{L}'-]*/gu, (word) => {
    const value = /^(?:zero|one)$/i.test(word) ? null : spelled(word);
    return value === null ? word : String(value);
  });
  return sentencesOf([answer]).filter((sentence) => !unbackedCounts(digits(sentence), sources, '', true).length);
}

// Where in one line the counts nothing read backs end: for telling a true "(unsourced)" from a stray one.
export function unbackedEnds(line: string, read: string[]): number[] {
  return unbackedCounts(line, sourceTokens(read), flat(read.join('\n'))).map((miss) => miss.end);
}

// The counts a write adds to a document with no rules that nothing read gives for what they count, each marked
// "(unsourced)" right after it, once: the doc keeps the writer's words and says which figures are theirs alone.
// Each mark comes back with its line as the doc now has it, mark and all: quoted without it, the report was itself
// read as a source for the bare count, and the next write in the same turn took the mark out again (journey 12).
export type CountMark = { label: string; line: string };
export function markUnbacked(input: { before: string; after: string; read: string[] }): { text: string; marked: CountMark[] } {
  const sources = sourceTokens(input.read);
  const quoted = flat(input.read.join('\n'));
  const lines = input.after.split('\n');
  const marked: CountMark[] = [];
  for (const { line } of added(input.before, input.after)) {
    if (/^\s*(?:>|```)/.test(lines[line])) continue;
    const misses = unbackedCounts(lines[line], sources, quoted);
    for (const miss of [...misses].reverse()) lines[line] = `${lines[line].slice(0, miss.end)} (unsourced)${lines[line].slice(miss.end)}`;
    marked.push(...misses.map((miss) => ({ label: miss.label, line: lines[line] })));
  }
  return { text: lines.join('\n'), marked };
}
export const markSaid = (mark: CountMark) => `"${mark.label}" (in "${quote(mark.line)}")`;

// A figure worked out from others, written with no working behind it. Journey 13: Tom wrote "Net burn at current MRR
// (€720): €1,380 per month" and "Runway at net burn: 8.7 months" in his head from the brief's figures, forgot the
// €534 a month the boxes cost, and both stood unmarked, since the figure check takes one step of arithmetic on two
// figures read as sourced. On a line that names what a sum gives (burn, runway, margin, profit, break-even, CAC, LTV,
// a total, a monthly figure), a number stands only when something read gives it as written or a calc this turn
// worked it out from figures read; else it is marked "(unsourced)", even when its inputs were read.
const DERIVED = /\b(?:burn|runway|margins?|profits?|loss(?:es)?|break[- ]?even|CAC|LTV|payback|totals?|per[- ]month|monthly|a month|net)\b|\/\s?mo(?:nth)?\b/i;
const FIGURE = /(?<![\p{L}\d.,:/#-])([$€£]\s?)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(k|m)\b)?(\s?%)?(?![\d]|[.,]\d|\s*\(unsourced\)|(?:st|nd|rd|th|am|pm)\b|\s?[-:/]\d)/giu;
// A figure put as a goal or a suggestion is the writer's proposal, not a sum: "I suggest a target of $49 next".
const PROPOSED = /\b(?:suggest\w*|propos\w*|recommend\w*|aim|goal|target|plan|should|could|would|want)\b/i;
function unworkedFigures(line: string, known: Set<number>, worked: number[]): Unbacked[] {
  const found: Unbacked[] = [];
  let offset = 0;
  for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
    const start = line.indexOf(sentence, offset);
    offset = start + sentence.length;
    if (!DERIVED.test(sentence)) continue;
    found.push(...unworkedIn(sentence, known, worked).map((miss) => ({ ...miss, end: start + miss.end })));
  }
  return found;
}
function unworkedIn(line: string, known: Set<number>, worked: number[]): Unbacked[] {
  const found: Unbacked[] = [];
  for (const match of line.matchAll(FIGURE)) {
    const [, money, digits, decimals = '', scaleWord, share] = match;
    const scale = { k: 1e3, m: 1e6 }[scaleWord?.toLowerCase() ?? ''] ?? 1;
    const value = Number(`${digits.replace(/,/g, '')}${decimals}`) * scale;
    const before = line.slice(0, match.index);
    const rest = line.slice(match.index + match[0].length);
    if (PROPOSED.test(before)) continue;
    if (!money && !share && !decimals && (CONSTANTS.has(value) || (value >= 1900 && value <= 2099))) continue;
    if (DATE_AFTER.test(rest) || DATE_BEFORE.test(before) || NAMES.test(before)) continue;
    if (/^\s*(?:[\p{L}'-]+\s+){0,3}\(unsourced\)/u.test(rest)) continue;
    // As exact as it is written: "8.7" is any sum from 8.65 to 8.75, "€1,380" one from 1,379.5 to 1,380.5.
    const half = 0.5 * 10 ** -(decimals.length ? decimals.length - 1 : 0) * scale;
    const near = (one: number) => Math.abs(one - value) <= half + 1e-9 || (!!share && Math.abs(one * 100 - value) <= half + 1e-9);
    if (known.has(value) || worked.some(near)) continue;
    found.push({ label: match[0].trim(), end: match.index + match[0].trimEnd().length });
  }
  return found;
}

// The derived figures a write adds that nothing read gives and no calc worked out, each marked "(unsourced)" after it.
export function markUnworked(input: { before: string; after: string; read: string[] }): { text: string; marked: CountMark[] } {
  const { plain, free } = sortSums(input.read);
  const known = new Set(sentencesOf(plain).flatMap(tokensOf).flatMap((token) => (token.value === undefined ? [] : [token.value])));
  const lines = input.after.split('\n');
  const marked: CountMark[] = [];
  for (const { line } of added(input.before, input.after)) {
    if (/^\s*(?:>|```)/.test(lines[line])) continue;
    const misses = unworkedFigures(lines[line], known, free);
    for (const miss of [...misses].reverse()) lines[line] = `${lines[line].slice(0, miss.end)} (unsourced)${lines[line].slice(miss.end)}`;
    marked.push(...misses.map((miss) => ({ label: miss.label, line: lines[line] })));
  }
  return { text: lines.join('\n'), marked };
}

// A claim of evidence, and the words one of the founder's sentences or a tool result has to share with it.
const CLAIMS: { said: RegExp; keys: RegExp }[] = [
  { said: /\bretention\b[^.;!?]{0,30}?\b(?:ok|okay|good|fine|strong|high|solid|great|healthy)\b/i, keys: /\b(?:retention|retain|retained|churn|renew|came back|come back|returning|stayed)\b/i },
  { said: /\b(?:customers?|users?|hosts?|clients?|designers?|people|they|everyone)\s+(?:really\s+|all\s+)?(?:love|loves|loved|like|likes|want|wants|need|needs|rave|begged|asked for)\b/i, keys: /\b(?:love|loves|loved|like|likes|liked|want|wants|wanted|need|needs|needed|rave|raved|begged|asked for)\b/i },
  { said: /\b(?:validated|confirmed|proven|verified)\b/i, keys: /\b(?:validat\w*|confirm\w*|prov\w*|verif\w*)\b/i },
  // Journey 12: "The product itself works" stood in the partner's verdict with nothing behind it.
  { said: /\b(?:(?:the\s+)?(?:product|app|tool|platform|prototype|mvp|beta|it)\s+(?:itself\s+|really\s+|clearly\s+)?(?:works|is working|does work)|proven to work|validated the (?:product|idea|market|demand))\b/i, keys: /\b(?:works?|working|worked|validat\w*|proven|bugs?|crash\w*|broken|uptime)\b/i },
  { said: /\b(?:we(?:'ve| have)|I(?:'ve| have)|the founder has|they(?:'ve| have))\s+(?:had|done|held|run|conducted|completed)\s+[\w-]+\s+(?:real\s+)?(?:customer\s+|user\s+)?(?:conversations?|interviews?|calls?)\b/i, keys: /\b(?:conversations?|interview\w*|calls?|called|talk\w*|spoke|spoken)\b/i },
];
// A sentence that puts words, feedback or behaviour in the mouths of customers: "office managers report it is a popular
// perk", "strong initial pickup on Tuesday evenings", "staff appreciate the freshness". Journey 13: Lena's customer
// notes said both with nothing on record, in a plain doc, unmarked. Each claim is a pattern; it is backed only by a
// sentence read this turn that says what someone said or did (a founder message, interview notes, a survey, a page)
// and shares a word of substance with it, so the brief's "evening pickup" is no source for "strong pickup".
const SUBJECTS = 'customers?|users?|clients?|hosts?|buyers?|managers?|offices?|staff|employees|teams?|people|HR|members?|pilots?|everyone|tenants?|guests?|they';
const FEEDBACK: RegExp[] = [
  new RegExp(`\\b(?:${SUBJECTS})\\b(?:\\s+(?!and\\b|but\\b)[\\w/'-]+){0,2}?\\s+(?:really\\s+|often\\s+|all\\s+|keep\\s+)?(?:report(?:s|ed)?|say|says|said|told us|tell us|love[sd]?|appreciat(?:e|es|ed)|enjoy(?:s|ed)?|asks? for|asked for|asking for|request(?:s|ed)?|prais(?:e|es|ed)|rave[sd]?|complain(?:s|ed)?|prefer(?:s|red)?|describe[sd]?|call(?:s|ed)? it)\\b`, 'i'),
  /\b(?:strong|high|good|great|solid|growing|huge|clear|positive|steady|encouraging|enthusiastic)\s+(?:[\w-]+\s+)?(?:pickup|pick-up|uptake|adoption|engagement|demand|interest|feedback|response|reception)\b/i,
  /\b(?:popular|well[- ]received|went down well|a hit with|in high demand|sought[- ]after)\b/i,
  /\b(?:feedback|response|reception|pickup|uptake|engagement|demand)\s+(?:is|was|has been|have been|so far)\s+(?:\w+\s+)?(?:positive|strong|great|good|high|excellent|encouraging)\b/i,
];
// What a source has to be to back one: itself a claim of feedback, or a record of what someone said.
const RECORD = /\b(?:said|says|told|feedback|interview\w*|survey\w*|quoted?|replied|wrote|answered|complain\w*|asked|reported)\b/i;
// Words that say nothing about what the feedback was about.
const GENERIC = new Set(`${SUBJECTS.replace(/\?/g, '').split('|').join(' ')} customer user client manager office member pilot tenant guest staff team report reported reports say said told love loved appreciate appreciated enjoy enjoyed ask asked request requested praise rave complain prefer describe call strong high good great solid growing huge clear positive steady encouraging enthusiastic pickup pick-up uptake adoption engagement demand interest feedback response reception popular initial early really often keep`.split(' '));
const substance = (sentence: string) => content(sentence).filter((word) => word.length > 3 && !GENERIC.has(word.toLowerCase())).map(stem);
// The sentences read that hold a record of feedback, each as its words of substance.
type Record = { words: string[]; feedback: boolean };
const records = (read: string[]): Record[] => sentencesOf(read.map((one) => one.split('\n').filter((line) => !line.includes(MARK)).join('\n')))
  .flatMap((sentence) => {
    const feedback = FEEDBACK.some((claim) => claim.test(sentence));
    return feedback || RECORD.test(sentence) ? [{ words: substance(sentence), feedback }] : [];
  });
// The claims of feedback in one sentence that nothing read backs, each as written. A question, a doubt or a thing to
// find out is no claim: "find out whether staff appreciate it", "no feedback on record".
function unbackedFeedback(sentence: string, read: Record[]): string[] {
  if (/\?\s*$/.test(sentence) || /\bno feedback\b/i.test(sentence)) return [];
  const words = substance(sentence);
  return FEEDBACK.flatMap((claim) => {
    const hit = claim.exec(sentence);
    if (!hit || DENIED.test(sentence.slice(0, hit.index)) || LEARNING.test(sentence.slice(0, hit.index))) return [];
    // "Customers love it" has no word of substance: only a sentence read that is itself such a claim backs it.
    const backs = (source: Record) => (words.length ? source.words.some((one) => words.some((word) => alike(word, one))) : source.feedback);
    return read.some(backs) ? [] : [hit[0]];
  });
}
const LEARNING = /\b(?:find out|learn|ask|check|test|need to know|confirm|verify|explore|understand|question|open|unknown|hypothes\w*)\b[^.;!?]*$/i;

// A doc with no rules keeps a claim of feedback nothing read backs, marked "(assumption)" after its sentence, the
// way its counts are marked "(unsourced)". Gives the sentences marked.
export function markFeedback(input: { before: string; after: string; read: string[] }): { text: string; marked: string[] } {
  const read = records(input.read);
  const lines = input.after.split('\n');
  const marked: string[] = [];
  for (const { line } of added(input.before, input.after)) {
    if (/^\s*(?:>|```)/.test(lines[line])) continue;
    lines[line] = lines[line].split(/(?<=[.!?])\s+/).map((sentence) => {
      if (sentence.includes(MARK) || !unbackedFeedback(sentence, read).length) return sentence;
      marked.push(sentence.trim());
      return sentence.replace(/([.!?]*)(\s*)$/, ` ${MARK}$1$2`);
    }).join(' ');
  }
  return { text: lines.join('\n'), marked };
}

// Denied, doubted or still to come: "not validated yet", "unproven", "needs to be confirmed".
const DENIED = /\b(?:no|not|never|none|nobody|without|yet to|to be|un\w+|if|whether)\b[^.;!?]*$/i;
// A view, not a fact: kept, and marked so a reader can tell.
const VIEW = /\b(?:I think|I believe|I guess|I suspect|I assume|assum\w*|likely|probably|possibly|maybe|perhaps|may|might|seems?|appears?|guess)\b/i;
const MARK = '(assumption)';

const quote = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 70 ? `${flat.slice(0, 69)}…` : flat;
};

// The added lines of a write to a doc with rules, each with the section it stands in.
function added(before: string, after: string): { line: number; heading: string }[] {
  const had = new Set(before.split('\n').map((line) => line.trim()));
  let heading = '';
  return after.split('\n').flatMap((line, index) => {
    const title = HEADING.exec(line);
    if (title) { heading = title[1].trim(); return []; }
    return !line.trim() || had.has(line.trim()) || MARKER.test(line) ? [] : [{ line: index, heading }];
  });
}

// The claims of evidence in a text that no sentence of `said` backs, each as written: for a verdict's reason, where an
// unbacked one is kept and marked "(assumption)" rather than refused.
export function unbackedClaims(text: string, said: string[]): string[] {
  const heard = sentencesOf(said);
  return text.split(/(?<=[.!?])\s+/).flatMap((sentence) => {
    if (sentence.includes(MARK) || VIEW.test(sentence)) return [];
    const claimed = CLAIMS.flatMap(({ said: claim, keys }) => {
      const hit = claim.exec(sentence);
      return !hit || DENIED.test(sentence.slice(0, hit.index)) || heard.some((one) => keys.test(one)) ? [] : [hit[0]];
    });
    return [...claimed, ...unbackedFeedback(sentence, records(said)).filter((hit) => !claimed.includes(hit))];
  });
}

// A text with "(assumption)" put after each sentence that makes a claim of evidence nothing in `said` backs.
export function markClaims(text: string, said: string[]): string {
  return text.split(/(?<=[.!?])\s+/).map((sentence) => (unbackedClaims(sentence, said).length ? sentence.replace(/([.!?]*)(\s*)$/, ` ${MARK}$1$2`) : sentence)).join(' ');
}

// `counts` is everything read that may give a count (founder messages, readable documents, tool results that
// worked); `said` is only the founder's words and those tool results. Returns the text to save, with "(assumption)"
// put after a view the writer did not mark, or throws what is not written and why.
export function evidenceCheck(input: { before: string; after: string; counts: string[]; said: string[] }): { text: string; marked: string[] } {
  const counts = sourceTokens(input.counts);
  const quoted = flat(input.counts.join('\n'));
  const said = sentencesOf(input.said);
  const lines = input.after.split('\n');
  const figures: string[] = [];
  const claims: string[] = [];
  const marked: string[] = [];
  const heardOf = records(input.counts);
  let feedback = false;
  for (const { line, heading } of added(input.before, input.after)) {
    figures.push(...unbackedCounts(lines[line], counts, quoted).map((miss) => `"${miss.label}" (in "${quote(lines[line])}")`));
    // Feedback put in customers' mouths is a claim of evidence under any heading.
    if (!EVIDENCE.test(heading)) {
      if (/^\s*(?:>|```)/.test(lines[line])) continue;
      lines[line] = lines[line].split(/(?<=[.!?])\s+/).map((sentence) => {
        if (sentence.includes(MARK)) return sentence;
        const hits = unbackedFeedback(sentence, heardOf);
        if (!hits.length) return sentence;
        if (VIEW.test(sentence)) {
          marked.push(sentence.trim());
          return sentence.replace(/([.!?]*)(\s*)$/, ` ${MARK}$1$2`);
        }
        feedback = true;
        claims.push(...hits.map((hit) => `"${hit}" in "${heading || 'the document'}"`));
        return sentence;
      }).join(' ');
      continue;
    }
    lines[line] = lines[line].split(/(?<=[.!?])\s+/).map((sentence) => {
      if (sentence.includes(MARK)) return sentence;
      if (VIEW.test(sentence)) {
        marked.push(sentence.trim());
        return sentence.replace(/([.!?]*)(\s*)$/, ` ${MARK}$1$2`);
      }
      for (const { said: claim, keys } of CLAIMS) {
        const hit = claim.exec(sentence);
        if (!hit || DENIED.test(sentence.slice(0, hit.index))) continue;
        if (!said.some((one) => keys.test(one))) claims.push(`"${hit[0]}" in "${heading}"`);
      }
      const heard = unbackedFeedback(sentence, heardOf).filter((hit) => !claims.some((one) => one.startsWith(`"${hit}"`)));
      if (heard.length) feedback = true;
      claims.push(...heard.map((hit) => `"${hit}" in "${heading}"`));
      return sentence;
    }).join(' ');
  }
  const parts: string[] = [];
  if (figures.length) {
    parts.push(`${figures.join(', ')} ${figures.length > 1 ? 'are' : 'is'} not in any founder message, document or tool result read, for what ${figures.length > 1 ? 'they count' : 'it counts'}. `
      + 'Take it out, write the figure the source gives, or write "(unsourced)" right after it.');
  }
  if (claims.length) {
    parts.push(`${[...new Set(claims)].join(', ')}: no founder message or tool result says this. Take it out, ask the founder, or write it as your view with "${MARK}" after it.`
      + (feedback ? ' Customer feedback comes only from notes you read; with none, write "no feedback on record".' : ''));
  }
  if (parts.length) throw new Error(`not written: ${parts.join(' And ')}`);
  return { text: lines.join('\n'), marked };
}
