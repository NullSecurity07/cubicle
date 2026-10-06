import { unaskedCounts, unaskedFeedback } from '../tools/evidence.ts';

// What the partner writes when nobody asked: a watch proposal and its ready email to a lead, the morning note, a
// review line. Journey 16: a lead asked "Can you deliver on Thursday instead of Sunday? And are the meals nut-free?"
// and the ready reply said "Yes, we can definitely deliver on Thursday ... all our meals are completely nut-free, so
// you can eat safely", an allergen promise to a customer from nothing; the watch proposed calling "the three nurses
// who cancelled" when no cancellation was on record. A doc a colleague writes is held to what was read and marks what
// is not; an unasked output has nobody reading it before it goes out, so here a sentence that promises what no
// source says, counts what no source gives, or puts words in customers' mouths is taken out, and the row says what
// was left out. The sources are the brief, what the turn read and the lead's own words; a question is no source
// (the lead asking "nut-free?" says nothing about our meals), nor is a line that says no.

export type Guarded = { text: string; left: string[] };

const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekends?|weekdays?|tomorrow|tonight';
// Doubted, refused or still to find out: "we cannot promise nut-free", "I will check whether Thursday works".
const DENIED = /\b(?:no|not|never|cannot|can't|can’t|won't|won’t|don't|don’t|isn't|aren't|unable|without)\b[^.!?]*$/i;
const LEARNING = /\b(?:check|find out|ask|confirm|look into|see (?:if|whether)|whether|if|let you know|come back to you|get back to you)\b[^.!?]*$/i;

type Promised = { pattern: RegExp; backs: (hit: RegExpExecArray) => RegExp; about: (hit: RegExpExecArray) => string };
const nounOf = (verb: string) => {
  const low = verb.toLowerCase();
  return /^deliver/.test(low) ? 'delivery' : /^ship/.test(low) ? 'shipping' : /^drop/.test(low) ? 'drop-off' : /^start/.test(low) ? 'a start'
    : /^switch|^mov/.test(low) ? 'a switch' : /^launch/.test(low) ? 'a launch' : /^open/.test(low) ? 'opening' : 'delivery';
};
const word = (text: string) => text.replace(/[-\s]+/g, '[-\\s]?');
// Words a "-free" ends that promise nothing: "hassle-free", "stress-free".
const SOFT = /^(?:hassle|stress|worry|care|hands|toll|duty|tax|interest)$/i;
const PROMISES: Promised[] = [
  // A day something happens: "we can deliver on Thursday", "it will be ready by Friday".
  {
    pattern: new RegExp(`\\b(deliver\\w*|ship\\w*|bring\\w*|drop\\w*\\s+off|arriv\\w*|start\\w*|switch\\w*|mov(?:e|es|ed|ing)|send\\w*|launch\\w*|open\\w*|come|coming|available|ready|serv(?:e|es|ed|ing))\\b[^.!?\\n]{0,40}?\\b(?:on|by|every|from|this|next|each|for)\\s+(${DAYS})\\b`, 'i'),
    backs: (hit) => new RegExp(`\\b${hit[2].replace(/s$/i, '')}`, 'i'),
    about: (hit) => `${nounOf(hit[1])} on ${hit[2][0].toUpperCase()}${hit[2].slice(1).toLowerCase()}`,
  },
  // A property of what is sold: "nut-free", "gluten-free".
  {
    pattern: /\b(\p{L}{2,})-free\b/iu,
    backs: (hit) => new RegExp(`\\b${word(hit[1])}[-\\s]?free\\b|\\bno ${word(hit[1])}s?\\b|\\bwithout ${word(hit[1])}s?\\b`, 'i'),
    about: (hit) => `${hit[1].toLowerCase()}-free`,
  },
  // Safety, guarantees, certificates, money back, a price cut.
  {
    pattern: /\b(?:allerg(?:en|y)[- ]safe|safe\s+(?:to eat|for (?:you|everyone|anyone|people|allerg\w*|kids|children))|eat\s+(?:it\s+|them\s+)?safely|(?:completely|totally|perfectly|entirely|100%)\s+safe|hypoallergenic|guarantee[sd]?|certified|money[- ]back|refund(?:s|ed)?|free\s+(?:of charge|delivery|trial|week|month|meal|sample)s?|discount(?:s|ed)?|\d+%\s+off)\b/i,
    backs: (hit) => {
      const low = hit[0].toLowerCase();
      return /safe|allerg/.test(low) ? /\bsafe|\ballerg/i : /guarant/.test(low) ? /\bguarant/i : /certif/.test(low) ? /\bcertif/i
        : /refund|money/.test(low) ? /\brefund|\bmoney[- ]back/i : /discount|off$/.test(low) ? /\bdiscount|%\s+off\b/i : new RegExp(`\\b${word(low)}`, 'i');
    },
    about: (hit) => (/eat\s+(?:it\s+|them\s+)?safely|safe/i.test(hit[0]) ? 'allergen safety' : hit[0].toLowerCase()),
  },
];

// A source's sentences that state something: a question states nothing, and neither does a line that says no to it.
const sentencesOf = (text: string) => text.split(/\n|(?<=[.!?])\s+/).map((one) => one.trim()).filter(Boolean);
const stated = (sources: string[]) => sources.flatMap(sentencesOf).filter((one) => !/\?\s*["”']?\s*$/.test(one));
const backedBy = (pattern: RegExp, said: string[]) => said.some((sentence) => {
  const hit = pattern.exec(sentence);
  return !!hit && !DENIED.test(sentence.slice(0, hit.index));
});

// What one sentence promises that no source states, in a few words each.
export function unbackedPromises(sentence: string, sources: string[]): string[] {
  if (/\?\s*["”']?\s*$/.test(sentence.trim())) return [];
  const said = stated(sources);
  return PROMISES.flatMap(({ pattern, backs, about }) => {
    const hit = pattern.exec(sentence);
    if (!hit || (pattern === PROMISES[1].pattern && SOFT.test(hit[1]))) return [];
    const before = sentence.slice(0, hit.index);
    if (DENIED.test(before) || LEARNING.test(before)) return [];
    return backedBy(backs(hit), said) ? [] : [about(hit)];
  });
}

// What one sentence says that nothing on record backs: a promise, a count, a customer's words.
export function unbackedIn(sentence: string, sources: string[]): string[] {
  // A count with no source is taken out too, not marked: "call the three nurses who cancelled" with no cancellation
  // on record. A plan's count stands ("contact 30 more nurses"); one said of people already there does not.
  return [...unbackedPromises(sentence, sources), ...unaskedCounts(sentence, sources), ...unaskedFeedback(sentence, sources)];
}

// The text with every sentence that says what nothing on record backs taken out, and what each was about. A line
// left empty goes; so does a gap of more than one blank line.
export function guardUnasked(text: string, sources: string[]): Guarded {
  const left: string[] = [];
  const lines = text.split('\n').flatMap((line) => {
    if (!line.trim()) return [line];
    const kept = line.split(/(?<=[.!?])\s+/).filter((sentence) => {
      const missing = unbackedIn(sentence, sources);
      left.push(...missing);
      return !missing.length;
    });
    return kept.length ? [kept.join(' ')] : [];
  });
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), left: [...new Set(left)] };
}

// The line a row or a note carries for what was taken out.
export const leftOutLine = (left: string[]) => (left.length ? `(left out: nothing on record about ${left.join(', ')})` : '');

// A draft signed "[Founder Name]" (journey 16) goes out with the placeholder in it. A name placeholder is filled from
// the brief's founder line when it has one; any line still holding a bracketed placeholder ("[Company]", "[Date]") is
// dropped, so what the founder opens in Gmail has nothing left to fill in.
const NAME_SLOT = /\[(?:(?:your|the|founder'?s?|my|sender'?s?)\s+)?(?:full\s+)?(?:name|founder)\]/gi;
const SLOT = /\[[\p{L}][\p{L}' ]{0,30}\]/u;
export function founderOf(brief: string): string | null {
  const hit = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:founder(?:'s name)?|founded by|founders?)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+){0,2})/imu.exec(brief);
  return hit ? hit[1] : null;
}
export function filledIn(body: string, brief: string): string {
  const name = founderOf(brief);
  const named = name ? body.replace(NAME_SLOT, name) : body;
  return named.split('\n').filter((line) => !SLOT.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
