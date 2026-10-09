import { unaskedCounts, unaskedFeedback } from '../tools/evidence.ts';
import { productTopic, unbackedProductClaims } from '../productclaim.ts';

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
  }).concat(unbackedProductClaims(sentence, sources));
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

// Journey 17: the day-3 note's three moves were all taken out ("(left out: nothing on record about 2 New leads, 11 to,
// 1 Meeting lead, 120 nurses contacted, 9 threshold, 11)") and "Three moves for today:" stood over nothing; the day-4
// risk was replaced by "Nothing on record backs the risk the note named." A move is a plan, not a claim: it is never
// taken out, and only a count or a promise inside it is checked, a count nothing gives marked "(unsourced)" and a
// promise nothing states marked after the move. A risk is the partner's view: it stays as written, marked "(view)"
// when it names a fact nothing on record backs.
export function guardMove(move: string, sources: string[], numbers = ''): string {
  // A plan may cite any figure on record ("the 120 nurses contacted"): only a count whose number is nowhere on record
  // is named, once, after the move, never inside it.
  // A count the move sets out to reach ("contact 50 new nurses", "win 4 more") is the plan itself, and a gap worked
  // in one step from two figures on record ("the 19 still needed", 30 - 11) is the record's: neither is named.
  const record = [...new Set([...sources.join('\n').replace(/(?<=\d),(?=\d{3}\b)/g, '').matchAll(/\d+(?:\.\d+)?/g)].map((hit) => Number(hit[0])))];
  const onRecord = new Set(record);
  // The gap is worked from the Company Numbers alone: from every figure the facts hold, almost any count is one step.
  const own = [...new Set([...numbers.replace(/(?<=\d),(?=\d{3}\b)/g, '').matchAll(/\d+(?:\.\d+)?/g)].map((hit) => Number(hit[0])))].filter((one) => one < 1900 || one > 2099);
  const oneStep = (value: number) => own.some((a) => own.some((b) => Math.abs(a - b - value) < 1e-9));
  const AIMED = /\b(?:contact|reach|call|email|message|ask|invite|sign(?:\s+up)?|win|get|add|acquire|recruit|book|land|convert|secure|find|target|aim(?:\s+for)?|close|send|visit|meet|onboard|interview|pitch)\b(?:\s+(?:the|our|another|at\s+least|up\s+to|a|of))*\s*$/i;
  const counts = unaskedCounts(move, sources).filter((label) => {
    const first = /\d[\d,]*(?:\.\d+)?/.exec(label);
    if (!first) return true;
    const value = Number(first[0].replace(/,/g, ''));
    const at = move.indexOf(label);
    return value !== 0 && !onRecord.has(value) && !oneStep(value) && !(at >= 0 && AIMED.test(move.slice(Math.max(0, at - 40), at)));
  });
  const promised = move.split(/(?<=[.!?])\s+/).flatMap((sentence) => unbackedPromises(sentence, sources));
  const missing = [...new Set([...counts, ...promised])];
  return missing.length ? `${move.replace(/\s+$/, '')} (not on record: ${missing.join(', ')})` : move;
}
export function guardView(view: string, sources: string[]): string {
  const said = view.trim();
  if (!said) return said;
  const unbacked = said.split(/(?<=[.!?])\s+/).some((sentence) => unbackedIn(sentence, sources).length > 0);
  return unbacked && !/\(view\)\s*$/.test(said) ? `${said} (view)` : said;
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

// ---------------------------------------------------------------- a reply built from the lead's questions

// Journey 17: Anna asked "Can you deliver on Thursday instead of Sunday? And are the meals nut-free?"; the guard took
// out both made-up yeses and what was left was "Thanks for reaching out ... Let me know if you would like to set this
// up ... Best,", an email that answers nothing. A reply to a lead is built from their questions: each one is answered
// by a line that survived the guard (so the record backs it) or gets an honest line ("I will check Thursday delivery
// and come back to you by Friday."). A reply with no line of substance left is not offered as an email at all:
// the row says the draft needs the founder and lists the questions.

export type Answered = { body: string; asks: string[]; hollow: boolean };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// The questions in what the lead wrote, as they asked them.
export const questionsIn = (said: string) => said.split(/\n|(?<=[.!?])\s+/).map((one) => one.trim()).filter((one) => /\?\s*["”']?$/.test(one))
  .map((one) => one.replace(/^(?:and|also|so|but|plus)\s+/i, '').replace(/^\p{Ll}/u, (first) => first.toUpperCase()));

// What a question is about, in a few words, and what a line answering it would name.
export function topicOf(question: string): { name: string; keys: RegExp } | null {
  const day = PROMISES[0].pattern.exec(question);
  if (day) {
    const when = day[2][0].toUpperCase() + day[2].slice(1).toLowerCase();
    return { name: `${when} ${nounOf(day[1])}`, keys: new RegExp(`\\b${day[2].replace(/s$/i, '')}`, 'i') };
  }
  const free = /\b(\p{L}{2,})-free\b/iu.exec(question);
  if (free && !SOFT.test(free[1])) {
    const what = /\b(?:are|is)\s+(?:the|your|all|all the|these|those)?\s*(\p{L}+)\s+(?:all\s+|completely\s+)?\p{L}+-free\b/iu.exec(question)?.[1];
    const named = what && !/^(?:they|it|those|these|them)$/i.test(what) ? ` ${what.toLowerCase()}` : '';
    return { name: `${free[1].toLowerCase()}-free${named}`, keys: new RegExp(`\\b${word(free[1])}[-\\s]?free\\b|\\ballerg`, 'i') };
  }
  // Journey 18: "Does it work with photos from my old Android phone?" gets "I will check whether it works with photos
  // from your old Android phone", never a yes nothing on record gives (server/productclaim.ts).
  return productTopic(question);
}

// Lines that say nothing: a greeting, thanks, a sign-off, "let me know", "hope this helps", a name on its own.
const PLEASANTRY = /^(?:hi|hello|dear|hey|good (?:morning|afternoon|evening))\b|^(?:many\s+)?(?:thanks|thank you)\b|^(?:best|regards|kind regards|warm regards|best regards|cheers|sincerely|all the best)\b[\p{L}\s,.!]*$|\blet me know\b|\breaching out\b|\bhope (?:this|you|that)\b|\blook(?:ing)? forward\b|\bgreat to hear\b|\bhappy to help\b|^\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+){0,2}[,.]?$/iu;
const SIGN_OFF = /^(?:best|regards|kind regards|warm regards|best regards|cheers|sincerely|all the best|thanks|thank you)\b[\p{L}\s]*[,.!]?$/iu;
const sentencesIn = (body: string) => body.split('\n').flatMap((line) => line.split(/(?<=[.!?])\s+/)).map((one) => one.trim()).filter(Boolean);
export const substantive = (body: string) => sentencesIn(body).filter((one) => !PLEASANTRY.test(one));

// Two working days on from today, by name: "by Friday".
function dayAfter(today: string): string {
  const at = new Date(`${today}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return '';
  let left = 2;
  while (left > 0) { at.setUTCDate(at.getUTCDate() + 1); if (at.getUTCDay() !== 0 && at.getUTCDay() !== 6) left -= 1; }
  return WEEKDAYS[at.getUTCDay()];
}

// The reply, held to the questions the lead asked. `body` is what is left after the guard.
export function answerQuestions(body: string, said: string, given: { name: string; today?: string }): Answered {
  const questions = questionsIn(said);
  // We wrote first: the lead is getting back to us, not reaching out.
  let text = body.replace(/\b(thanks|thank you)( so much)? for reaching out\b/gi, (_, thanks: string, much = '') => `${thanks}${much} for getting back to me`);
  const said_ = substantive(text);
  const by = given.today ? dayAfter(given.today) : '';
  const lines: string[] = [];
  const asks: string[] = [];
  for (const question of questions) {
    const topic = topicOf(question);
    const answered = topic ? said_.some((one) => topic.keys.test(one)) : said_.some((one) => sharedWords(one, question) >= 2);
    if (answered) continue;
    // Worded so the check comes first: the guard reads "I will check Thursday delivery" as finding out, not a promise.
    if (topic) lines.push(`I will check ${topic.name} and come back to you${by ? ` by ${by}` : ''}.`);
    else asks.push(question);
  }
  if (lines.length) {
    const rows = text.split('\n');
    let end = rows.length;
    while (end > 0 && (!rows[end - 1].trim() || SIGN_OFF.test(rows[end - 1].trim()) || /^\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+){0,2}$/u.test(rows[end - 1].trim()))) end -= 1;
    // A sign-off at the very end stays there, under the new lines.
    const tail = rows.slice(end).join('\n').trim();
    text = [rows.slice(0, end).join('\n').trim(), lines.join('\n'), tail].filter(Boolean).join('\n\n');
  }
  const hollow = !said_.length && !lines.length;
  if (hollow) {
    const first = given.name.split(' ')[0];
    return { body: [`Hi ${first},`, ...questions].join('\n\n'), asks: questions, hollow };
  }
  return { body: text, asks, hollow };
}

const CONTENT_STOP = /^(?:the|and|you|your|our|can|could|would|will|are|is|does|do|did|what|when|where|how|which|who|why|for|with|from|that|this|have|has|any|also|there|them|they|it|its|instead|of|to|on|in|a|an|us|we)$/i;
const sharedWords = (a: string, b: string) => {
  const of = (text: string) => new Set((text.toLowerCase().match(/[\p{L}][\p{L}'-]{2,}/gu) ?? []).filter((one) => !CONTENT_STOP.test(one)));
  const left = of(a);
  return [...of(b)].filter((one) => left.has(one)).length;
};
