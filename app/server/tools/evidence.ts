// What a team doc with rules may say about the world, held to what was really read. Journey 10: Meera wrote "Real
// customer conversations done: 2", "retention OK among the 2 paying" and "3+ hours per test" into the Evaluation
// doc, none of it said by anyone, and the judge built her verdict on it. The figure check before this skipped counts
// of ten or less and every claim made in words. Two checks, on the lines a write adds:
// - a count must be in something read, beside the thing it counts: the "2" of "2 paying" is no source for "2 real
//   customer conversations";
// - on a pain, conversations or traction section, a claim of evidence ("retention OK", "customers love it",
//   "validated", "we've had two conversations") needs a founder's sentence or a tool result that says it. A document
//   is no source here: a colleague's invented line in it would do. Said as a view ("I think", "likely") it stands,
//   marked "(assumption)".

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
const wordsIn = (text: string) => (text.match(/[\p{L}][\p{L}'-]*/gu) ?? []).filter((word) => word.length > 2 && !SMALL.has(word.toLowerCase())).map(stem);
const alike = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

// A source cut into sentences, each without its list number or heading number, so "## 3. Is the pain real?" is no
// source for a "3".
const sentencesOf = (sources: string[]) => sources.flatMap((source) => source.split(/\n|(?<=[.!?;])\s+/))
  .map((line) => line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*(?:[-*+]\s+)?\d+[.)]\s+/, '').trim()).filter(Boolean);
const valueOf = (digits: string) => Number(digits.replace(/,/g, ''));
// A number said in words counts as the same number: "six years" gives the "6" of "6 years".
const SPELLED = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');
const numbersIn = (sentence: string) => [
  ...[...sentence.matchAll(/(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?![\d]|[.,]\d)/g)].map((match) => valueOf(match[1])),
  ...(sentence.toLowerCase().match(/[a-z]+/g) ?? []).map((word) => SPELLED.indexOf(word)).filter((value) => value >= 0),
];

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
// A whole number, not part of a decimal, a date, a time, a fraction, money, a share or a "7-day": those are the figure
// check's, or no count at all.
const COUNT = /(?<![\d.,:/$€£#\-–—]|[$€£]\s)(\d{1,3}(?:,\d{3})+|\d+)(\+?)(?![\d]|[.,]\d|\s*(?:%|percent\b|\/|:\d|-[a-z]|[kmb]n?\b|x\b|×|\(unsourced\)))/gi;
const DATE_AFTER = new RegExp(`^\\s+(?:${MONTHS})\\b`, 'i');
const DATE_BEFORE = new RegExp(`\\b(?:${MONTHS})\\.?\\s+$`, 'i');
// A count put as a plan, a goal or advice is the writer's proposal, not a claim: "cheapest test: interview 5 hosts",
// "conduct 8 more conversations".
const AHEAD = /\b(?:next|goal|target|aim|plan|planned|should|needs?|must|will|would|could|cheapest|try|if|want|wants)\b/i;
const ORDER = /^[\s\W]*(?:conduct|interview|talk|call|run|book|ask|reach|get|find|recruit|email|survey|schedule|do|test)\b/i;

// The words that say what a count counts. A count right after a line's colon counts what the label names ("Real
// customer conversations done: 2"): the label's words, and the three after the count. Anywhere else ("Lived it:
// consulted for 6 years") it counts what is round it: three words either side, after the colon.
function countedBy(sentence: string, at: number, length: number): { label: string[]; near: string[] } {
  const colon = sentence.lastIndexOf(':', at);
  const after = wordsIn(sentence.slice(at + length)).slice(0, 3);
  if (colon >= 0 && !sentence.slice(colon + 1, at).trim()) return { label: wordsIn(sentence.slice(0, colon).replace(/\([^)]*\)/g, ' ')), near: after };
  return { label: [], near: [...wordsIn(sentence.slice(colon + 1, at)).slice(-3), ...after] };
}

// A sentence read that holds the same number, said of the same thing: half the label's words at least, and one of
// the words after the count; with no label, half the words round it.
function backed(value: number, counted: { label: string[]; near: string[] }, sources: string[]): boolean {
  return sources.some((sentence) => {
    if (!numbersIn(sentence).includes(value)) return false;
    const held = wordsIn(sentence);
    const hits = (words: string[]) => words.filter((word) => held.some((one) => alike(word, one))).length;
    if (counted.label.length) return hits(counted.label) >= Math.ceil(counted.label.length / 2) && (!counted.near.length || hits(counted.near) > 0);
    return hits(counted.near) >= Math.ceil(counted.near.length / 2);
  });
}

function unbackedCounts(line: string, sources: string[]): string[] {
  const found: string[] = [];
  // Each sentence on its own; a "?" in a template label ("survivable?") ends one too.
  for (const sentence of line.split(/(?<=[.!?;])\s+/)) {
    const body = sentence.replace(/^\s*(?:[-*+]\s+)?\d+[.)]\s+/, (lead) => ' '.repeat(lead.length));
    for (const match of body.matchAll(COUNT)) {
      const at = match.index!;
      const value = valueOf(match[1]);
      const before = body.slice(0, at);
      const rest = body.slice(at + match[0].length);
      if (value >= 1900 && value <= 2099) continue;
      if (DATE_AFTER.test(rest) || DATE_BEFORE.test(before)) continue;
      // A section named by number, "(3)" or "section 3".
      if ((/\($/.test(before) && /^\)/.test(rest)) || /\bsection\s+$/i.test(before)) continue;
      if (AHEAD.test(before) || /^\s+more\b/i.test(rest) || ORDER.test(before.slice(before.lastIndexOf(':') + 1))) continue;
      if (!backed(value, countedBy(body, at, match[0].length), sources)) found.push(`"${match[1]}${match[2]}" (in "${quote(line)}")`);
    }
  }
  return found;
}

// A claim of evidence, and the words one of the founder's sentences or a tool result has to share with it.
const CLAIMS: { said: RegExp; keys: RegExp }[] = [
  { said: /\bretention\b[^.;!?]{0,30}?\b(?:ok|okay|good|fine|strong|high|solid|great|healthy)\b/i, keys: /\b(?:retention|retain|retained|churn|renew|came back|come back|returning|stayed)\b/i },
  { said: /\b(?:customers?|users?|hosts?|clients?|designers?|people|they|everyone)\s+(?:really\s+|all\s+)?(?:love|loves|loved|like|likes|want|wants|need|needs|rave|begged|asked for)\b/i, keys: /\b(?:love|loves|loved|like|likes|liked|want|wants|wanted|need|needs|needed|rave|raved|begged|asked for)\b/i },
  { said: /\b(?:validated|confirmed|proven|verified)\b/i, keys: /\b(?:validat\w*|confirm\w*|prov\w*|verif\w*)\b/i },
  { said: /\b(?:we(?:'ve| have)|I(?:'ve| have)|the founder has|they(?:'ve| have))\s+(?:had|done|held|run|conducted|completed)\s+[\w-]+\s+(?:real\s+)?(?:customer\s+|user\s+)?(?:conversations?|interviews?|calls?)\b/i, keys: /\b(?:conversations?|interview\w*|calls?|called|talk\w*|spoke|spoken)\b/i },
];
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

// `counts` is everything read that may give a count (founder messages, readable documents, tool results that
// worked); `said` is only the founder's words and those tool results. Returns the text to save, with "(assumption)"
// put after a view the writer did not mark, or throws what is not written and why.
export function evidenceCheck(input: { before: string; after: string; counts: string[]; said: string[] }): { text: string; marked: string[] } {
  const counts = sentencesOf(input.counts);
  const said = sentencesOf(input.said);
  const lines = input.after.split('\n');
  const figures: string[] = [];
  const claims: string[] = [];
  const marked: string[] = [];
  for (const { line, heading } of added(input.before, input.after)) {
    figures.push(...unbackedCounts(lines[line], counts));
    if (!EVIDENCE.test(heading)) continue;
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
      return sentence;
    }).join(' ');
  }
  const parts: string[] = [];
  if (figures.length) {
    parts.push(`${figures.join(', ')} ${figures.length > 1 ? 'are' : 'is'} not in any founder message, document or tool result read, for what ${figures.length > 1 ? 'they count' : 'it counts'}. `
      + 'Take it out, write the figure the source gives, or write "(unsourced)" right after it.');
  }
  if (claims.length) {
    parts.push(`${claims.join(', ')}: no founder message or tool result says this. Take it out, ask the founder, or write it as your view with "${MARK}" after it.`);
  }
  if (parts.length) throw new Error(`not written: ${parts.join(' And ')}`);
  return { text: lines.join('\n'), marked };
}
