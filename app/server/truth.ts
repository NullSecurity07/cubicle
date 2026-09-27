// The truth net: what a finished reply says, checked in code against what this turn really did and really read.
// Prompt lines ask a person to claim no save no tool made and to invent no figure; the models still do both now and
// then, so the reply is read afterwards and the founder is told, in a line under it, what nothing backs. The model's
// words are never taken away.

import { PARTNER_STANCE, STANCE } from '../shared/model.ts';

export type Receipt = { name: string; ok?: boolean; effect?: unknown; result?: string };

// Each kind of claimed action, and the tools whose working receipt confirms it.
const WRITES = /write|create|append|replace|remember|retain|note_|add_|log_|close_|edit_|make_|move_|score_|propose_|generate_|save|delegate|code_task|run_code/;
const KINDS: { verbs: RegExp; tools: RegExp }[] = [
  { verbs: /^(saved|wrote|written|updated|created|stored|recorded)$/i, tools: WRITES },
  { verbs: /^(sent|emailed|mailed|messaged)$/i, tools: /send|mail|reach|telegram|ask_person|note_founder/ },
  { verbs: /^(posted|published)$/i, tools: /post|publish|send|reach|browse|edit_site|make_site/ },
  { verbs: /^(scheduled|booked)$/i, tools: /watch|automation|schedule|repeat|propose_|remind|nudge|delegate/ },
  { verbs: /^proposed$/i, tools: /propose_/ },
];
const VERBS = 'saved|wrote|written|updated|created|stored|recorded|sent|emailed|mailed|messaged|posted|published|scheduled|booked';
// "I saved", "I've just sent", "we have posted"; "it has been saved", "the draft was saved"; a sentence that opens with
// the verb, "Saved it to plan.md". A bare "we sent" is the company's own history, not this turn, and a bare "is
// updated" or "was created" says how things are or were ("updated weekly", "created in 2010"), so the passive counts
// only when it says just now, or when its subject is a thing a person here makes: a file, a doc, an email, a post.
const FIRST = new RegExp(`\\b(?:I(?:'ve| have| had)?(?:\\s+(?:just|now|already|also|then))?|we(?:'ve| have)(?:\\s+(?:just|now|already|also))?|we\\s+(?:just|now))\\s+(${VERBS})\\b`, 'gi');
// A bare "we" counts when what follows is a thing done to something in hand ("we sent the deck", "we posted it"),
// not a count of the company's history ("we sent 50 cold emails").
const WE_DID = new RegExp(`\\bwe\\s+(${VERBS})(?=\\s+(?:it|this|that|them|the|your)\\b)`, 'gi');
const PASSIVE = new RegExp(`\\b(?:has been|have been|is now|are now|was just|were just)(?:\\s+(?:just|now|already|also))?\\s+(${VERBS})\\b`, 'gi');
const MADE = new RegExp(`\\b(?:file|doc|document|email|e-mail|mail|post|update|draft|note|message|deck|invite)s?\\s+(?:was|were|is|are)(?:\\s+(?:just|now|already|also))?\\s+(${VERBS})\\b`, 'gi');
// "I have proposed a bet": a proposal put on record this turn, which only a propose_ tool that worked can back. The
// plain past ("the price I proposed") is a suggestion made in words or some earlier day, so only the perfect counts.
const PROPOSED = /\b(?:I(?:'ve| have)|we(?:'ve| have))(?:\s+(?:just|now|already|also))?\s+(proposed)\b/gi;
const PROPOSED_PASSIVE = /\b(?:has been|have been|is now|are now|was just|were just)(?:\s+(?:just|now|already|also))?\s+(proposed)\b/gi;
const OPENING = new RegExp(`(?:^|[.!?]\\s+|\\n\\s*)(${VERBS})\\s+(?:it|the|this|to|your|a|an|them|\`|")`, 'gi');
// A claim that is not one: under a condition, denied, asked, or about words that sit in this very reply ("below",
// or a sentence ending in a colon with the words after it).
const CONDITION = /\b(?:once|after|when|if|before|until|unless|nothing|no one|nobody|none|not|never)\s*$/i;
const HERE = /\b(?:below|above|here|in this (?:reply|message|chat))\b/i;
// A sentence about some other time, or what the founder said happened, is not a claim about this turn; nor is "I sent
// you nothing", or a change of mind ("I updated my view").
const ELSEWHEN = /\b(?:yesterday|last (?:week|month|year|quarter|time)|ago|in (?:19|20)\d\d|you (?:said|told|mentioned|wrote))\b/i;
// "In March", "last June": a month named as the time of it puts the sentence in the past (case kept, so "in may" is not one).
const IN_MONTH = /\b(?:[Ii]n|[Dd]uring|[Ss]ince|[Ll]ast|[Bb]ack in|[Ee]arly|[Ll]ate)\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b/;
const NOT_A_THING = /^\w+\s+(?:(?:you|them|him|her|us)\s+)?nothing\b|^\w+\s+my\s+(?:view|mind|thinking|take|estimate|opinion|read|understanding|guess)\b/i;

function sentenceAround(text: string, at: number): { before: string; rest: string } {
  const start = Math.max(text.lastIndexOf('.', at - 1), text.lastIndexOf('!', at - 1), text.lastIndexOf('?', at - 1), text.lastIndexOf('\n', at - 1)) + 1;
  const ends = /[.!?\n]/g;
  ends.lastIndex = at;
  const end = ends.exec(text);
  return { before: text.slice(start, at), rest: text.slice(at, end ? end.index + 1 : text.length) };
}

// The action verbs this reply claims as done that no working receipt of the same kind stands behind, in the order said.
export function unreceiptedClaims(reply: string, receipts: Receipt[]): string[] {
  const found: { at: number; verb: string }[] = [];
  for (const pattern of [FIRST, WE_DID, PASSIVE, MADE, OPENING, PROPOSED, PROPOSED_PASSIVE]) {
    for (const match of reply.matchAll(pattern)) {
      const verb = match[1];
      const at = match.index + match[0].length - verb.length;
      // Where the subject starts ("I", "it was"): whatever came before it in the sentence says if this is a claim.
      const start = match.index + match[0].length - match[0].trimStart().length;
      const { before } = sentenceAround(reply, start);
      const { rest } = sentenceAround(reply, at);
      if (CONDITION.test(before) || HERE.test(rest) || /[?:]$/.test(rest.trimEnd())) continue;
      if (ELSEWHEN.test(before + rest) || IN_MONTH.test(before + rest) || NOT_A_THING.test(rest)) continue;
      found.push({ at, verb: verb.toLowerCase() });
    }
  }
  // A write the doc guard held back comes back ok with "Not written: ...": nothing was written, so it backs no claim.
  const worked = receipts.filter((receipt) => receipt.ok && !/^Not written\b/.test(receipt.result ?? ''));
  const claims = found.sort((a, b) => a.at - b.at).map((one) => one.verb)
    .filter((verb) => !worked.some((receipt) => KINDS.find((kind) => kind.verbs.test(verb))!.tools.test(receipt.name)));
  return [...new Set(claims)];
}

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?`;
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
// Months stay (runway is counted in them); days, weeks and hours are nearly always advice ("run it 30 days").
const UNITS = 'users|customers|clients|signups|sign-ups|subscribers|downloads|visitors|leads|employees|hires|seats|months';
// A figure worth checking: money, a percentage, or a count with a unit. Bare numbers (dates, section numbers, steps)
// are not figures here.
const FIGURE = new RegExp(String.raw`[$€£]\s?${AMOUNT}\s?(k|mm|m|bn|b|thousand|million|billion)?\b|${AMOUNT}\s?(%|percent\b)|${AMOUNT}\s?(k|m|x|×)?\s?(${UNITS})\b|${AMOUNT}(x|×)(?![\w])`, 'gi');
// Hours, days and weeks are nearly always advice ("reply within 24 hours"), so they count only as a range ("20–40
// hours") or a rate ("12 hours per week", "12 hours/week"; not "a", which is as often "within 24 hours a customer"), which is a claim about the world that has to come from somewhere.
const SPAN = new RegExp(String.raw`${AMOUNT}(?:\s?(?:–|—|-|to)\s?${AMOUNT})?\s?(hours|days|weeks)\b(?=(\s*\/\s*\w|\s+per\b)?)`, 'gi');

const valueOf = (whole: string, fraction: string | undefined, scale?: string) => Number(`${whole.replace(/,/g, '')}${fraction ?? ''}`) * (scale ? SCALE[scale.toLowerCase()] ?? 1 : 1);
// How exact a figure is: its significant digits, so $8k is one and $8,005 is four.
const exactness = (value: number) => String(Number(Math.abs(value).toPrecision(12))).replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length || 1;
// Half of the figure's last significant digit: how far off a worked-out value may be and still round to it.
const halfUnit = (value: number) => (value === 0 ? 0.5 : 0.5 * 10 ** (Math.floor(Math.log10(Math.abs(value))) - exactness(value) + 1));

// A past reply's own flags, taken out of it before it counts as a source: the flag line itself, and every figure it
// named as unsourced, so an invented figure does not become "sourced" by having been said once already. Anything that
// squeezes a past message into one line (the morning note's talk, a colleague's excerpt) runs it through here first,
// while the flag line still starts a line of its own.
const FLAG_LINE = /^(?:Unconfirmed: this reply claims|Unsourced figures: ).*$/gm;
export function stripFlagged(source: string): string {
  const named = [...source.matchAll(/^Unsourced figures: (.+?) \(not found/gm)].flatMap((match) => match[1].split(', '));
  // Taken out whole only: a flagged "2%" must not eat the end of a real "32%".
  const whole = (label: string) => new RegExp(`(?<![\\d.,])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d])`, 'g');
  return named.reduce((kept, label) => kept.replace(whole(label), ''), source.replace(FLAG_LINE, ''));
}

// What kind of thing a figure in the inputs is. Money and a share never stand for each other: "$2k" is two thousand
// dollars, never a source for "2%" or "2x".
type Kind = 'money' | 'share' | 'other';
// `stamp`: a piece of a date or a time ("2026-09-26", "09:00"), which may match a figure but is never worked with.
type Known = { value: number; digits: number; kind: Kind; stamp?: boolean };
// A figure in an input, taken whole: its currency, its number, its scale and whether a % or an x closes it.
const TOKEN = new RegExp(String.raw`([$€£]\s?)?${AMOUNT}(?:\s?(k|mm|m|bn|b|thousand|million|billion)\b)?(\s?(?:%|percent\b)|(?:x|×)(?![\w]))?`, 'gi');
const MONTHS = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
// "26 Sep", "Sep 26": a day of a month, which is a date and not a figure.
const MONTH_AFTER = new RegExp(`^\\s(?:${MONTHS})\\b`);
const MONTH_BEFORE = new RegExp(`\\b(?:${MONTHS})\\s$`);
const clash = (one: Kind, other: Kind) => (one === 'money' && other === 'share') || (one === 'share' && other === 'money');
// Months in a year: "a year" is the one step a founder's monthly figures are always taken.
const CONSTANTS = [12];
const MAX_OPERANDS = 80;

// A figure introduced as a goal, a proposal or a what-if is the person's suggestion, not a claim about the world. The
// proposing words have to govern the figure: said by the person or as an imperative ("try $79", "I suggest a target
// of 60", "we should charge $29", "what if you charged $99"), at most three words before it in its own clause. "Your
// target market has 30,000 customers", "consider that 70% fail" and "companies that try it see 3x" are claims.
const LEAD = String.raw`(?:^[\s*\-\d.)]*|\b(?:i|we|you|let'?s|i'?d|we'?d|could|should|would|might)\s+(?:\w+\s+)?)`;
const VERB = String.raw`(?:try(?:ing)?|aim(?:ing)?\s+(?:for|at)|shoot\s+for|propos(?:e|ing)|suggest(?:ing)?)`;
// A milestone as an order, at the start of its clause only: "get to 150 customers first". "You will reach 1,200
// users" is a forecast, and a claim.
const MILESTONE = String.raw`^[\s*\-\d.)]*(?:get\s+to|reach|hit)`;
// A threshold a plan waits on is the partner's condition, not a claim: "raise when MRR reaches $10k", "hold off until
// you hit 150 customers".
const THRESHOLD = String.raw`(?:when|until|once|before|after)\s+(?:[\w'-]+\s+){0,4}?(?:reach(?:es)?|hits?|gets?\s+to|is\s+(?:over|above|at\s+least)|passes|crosses|tops)`;
const PHRASE = String.raw`(?:targets?\s+of|goal\s+(?:of|is)|what\s+if|(?:could|should|would|might)\s+charge|price\s+(?:it|them|this)\s+at|${THRESHOLD})`;
const PROPOSING = new RegExp(String.raw`(?:${LEAD}${VERB}|${MILESTONE}|\b${PHRASE})(?:\s+\S+){0,3}\s*$`, 'i');
// A line that names a precondition, or an item of a list that a line naming preconditions opens: a figure in the
// first clause of it is a condition the partner sets ("- Churn under 3%", "Precondition: 18 months of runway"), where
// the same words alone would be a claim. What follows a ":", "(", "," or ";" in the item is the partner saying how
// things stand ("- $10k MRR: not met, you are at $6,300"), and so is a first clause with status words before the
// figure ("yours is 7%", "investors expect 3x"): those stay claims.
const PRECONDITION = /\bpre-?conditions?\b/i;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const STATUS = /\b(?:is|are|was|were|yours|you(?:'re| are| have)|we(?:'re| are| have)|currently|now|met|expects?|sees?|shows?)\b/i;
function inPreconditions(reply: string, at: number): boolean {
  const lines = reply.slice(0, at).split('\n');
  const line = lines.at(-1)!;
  let clause: string;
  if (ITEM.test(line)) {
    let heading = false;
    for (let index = lines.length - 2; index >= 0; index -= 1) {
      if (ITEM.test(lines[index])) continue;
      heading = PRECONDITION.test(lines[index]);
      break;
    }
    if (!heading && !PRECONDITION.test(line)) return false;
    clause = line.replace(ITEM, '');
    // "- Precondition: 18 months": the label is not the clause.
    if (/^\s*pre-?conditions?\s*:/i.test(clause)) clause = clause.slice(clause.indexOf(':') + 1);
  } else {
    if (!PRECONDITION.test(line)) return false;
    // The line after the label: "Precondition: 18 months of runway".
    const colon = line.search(/pre-?conditions?[^:]*:/i);
    if (colon < 0) return false;
    clause = line.slice(line.indexOf(':', colon) + 1);
  }
  return !/[:(,;]/.test(clause) && !STATUS.test(clause);
}

function proposed(reply: string, at: number): boolean {
  if (inPreconditions(reply, at)) return true;
  const before = reply.slice(0, at);
  const start = Math.max(...['. ', '! ', '? ', '\n', ': ', ', ', '; '].map((end) => before.lastIndexOf(end))) + 1;
  return PROPOSING.test(before.slice(start));
}

// The reply's own text around a figure: its sentence and the two before it. One step of arithmetic counts only when
// a figure it starts from is written here, where the founder can follow it.
function nearby(reply: string, at: number, length: number): string {
  const ends = [...reply.slice(0, at).matchAll(/[.!?](?=\s)|\n/g)].map((match) => match.index + 1);
  const start = ends.length >= 3 ? ends[ends.length - 3] : 0;
  const next = /[.!?](?=\s|$)|\n/.exec(reply.slice(at + length));
  return `${reply.slice(start, at)} ${reply.slice(at + length, next ? at + length + next.index + 1 : reply.length)}`;
}

// Every figure in the reply whose value appears in none of the inputs of this turn: what the founder said, the history
// and docs the prompt carried, and what the tools gave back. A figure written another way ($22k for $22,000, $36.9k
// for $36,850) counts as found when it is within 1% and no more exact than the input: $8,005 does not come from "$8k".
// A figure that is one step of arithmetic on two known ones (40 × $49 = $1,960; $8,000 / $300 = 26.67 months; 3 of 40
// = 7.5%) counts as found too, and so does a later figure worked out from it. Figures brought in as a goal or a
// proposal ("aim for 100 customers", "try $79") are proposals, not unsourced. Counts of ten or less with a unit ("3
// weeks", "5 customers") are never flagged.
const isMoney = (one: Known) => one.kind === 'money';
// The money one step of arithmetic on two figures can give.
function moneyFrom(a: Known, b: Known): number[] {
  if (isMoney(a) && isMoney(b)) return [a.value + b.value, Math.abs(a.value - b.value)];
  if (!isMoney(a) && !isMoney(b)) return [];
  const [money, other] = isMoney(a) ? [a, b] : [b, a];
  return [money.value * other.value, money.value / other.value, ...(other.kind === 'share' ? [(money.value * other.value) / 100] : [])];
}
// The count, the months or the bare number one step on two figures can give.
function otherFrom(a: Known, b: Known): number[] {
  const ratios = [a.value / b.value, b.value / a.value];
  if (isMoney(a) && isMoney(b)) return ratios;
  if (isMoney(a) || isMoney(b)) return [];
  return [a.value + b.value, Math.abs(a.value - b.value), a.value * b.value, ...ratios, (a.value * b.value) / 100];
}

export function figureCheck(reply: string, sources: string[]): { unsourced: string[]; proposals: string[] } {
  const known: Known[] = [];
  for (const source of sources) {
    for (const match of stripFlagged(source).matchAll(TOKEN)) {
      const raw = valueOf(match[2], match[3]);
      const closer = match[5]?.trim().toLowerCase();
      const kind: Kind = match[1] ? 'money' : closer ? 'share' : 'other';
      const text = match.input ?? '';
      const end = match.index + match[0].length;
      const stamp = !match[1] && !closer && (/\d[-/:.]$/.test(text.slice(Math.max(0, match.index - 2), match.index)) || /^[-/:]\d/.test(text.slice(end, end + 2))
        || /^(?:19|20)\d\d$/.test(match[0].trim()) || MONTH_AFTER.test(text.slice(end, end + 12)) || MONTH_BEFORE.test(text.slice(Math.max(0, match.index - 12), match.index)));
      known.push({ value: match[4] ? valueOf(match[2], match[3], match[4]) : raw, digits: exactness(raw), kind, ...(stamp ? { stamp } : {}) });
    }
  }
  const close = (value: number, target: number) => Math.abs(value - target) <= Math.abs(target) * 0.01 + 1e-9;
  // A worked-out figure has to agree to the last digit the reply gives, and never by more than 1%: 26.67 is $8,000 /
  // $300, but $8,005 is not $8k plus anything.
  const agrees = (result: number, target: number) => Math.abs(result - target) <= Math.min(Math.abs(target) * 0.01, halfUnit(target)) + 1e-9;
  const found = (value: number, kind: Kind) => known.some((one) => !one.stamp && close(one.value, value) && exactness(value) <= one.digits && !clash(one.kind, kind));
  // One step of arithmetic on any two figures this turn read, or on one of them and a month count, that gives the
  // same kind of figure. Money comes from money plus or minus money, money times a count or a share, or money over a
  // count ($2k / 40 = $50 each); a count or a number of months from counts, or from one amount over another ($8,000 /
  // $300 = 26.67 months); a share or a multiple from a ratio of two figures that are not money against a count. So 30
  // emails less 1 reply never makes a price of $29. Dates and times are never worked with.
  // At least one of the two has to be written near the figure in the reply, and be known: a figure alone in its
  // sentence is never taken as worked out, because any two of a doc's figures make almost any number.
  const derived = (value: number, kind: Kind, around: string) => {
    const operands = [...new Map(known.filter((one) => !one.stamp).map((one) => [`${one.value}:${one.kind}`, one])).values()].slice(0, MAX_OPERANDS)
      .concat(CONSTANTS.map((constant) => ({ value: constant, digits: 12, kind: 'other' as Kind })));
    const shown = [...around.matchAll(TOKEN)].map((match) => valueOf(match[2], match[3], match[4]));
    const starts = operands.filter((one) => shown.some((near) => close(near, one.value)));
    for (const a of starts) {
      for (const b of operands) {
        if (a === b) continue;
        const ratios = [a.value / b.value, b.value / a.value];
        if (kind === 'share') {
          if ((a.kind === 'money') !== (b.kind === 'money')) continue;
          if (ratios.some((ratio) => agrees(ratio, value) || agrees(ratio * 100, value))) return true;
          continue;
        }
        const results = kind === 'money' ? moneyFrom(a, b) : otherFrom(a, b);
        if (results.some((result) => Number.isFinite(result) && agrees(result, value))) return true;
      }
    }
    return false;
  };
  const unsourced: string[] = [];
  const proposals: string[] = [];
  const note = (list: string[], label: string) => { if (!unsourced.includes(label) && !proposals.includes(label)) list.push(label); };
  for (const match of reply.matchAll(FIGURE)) {
    const label = match[0].trim();
    let value: number;
    let kind: Kind = 'other';
    if (match[1] !== undefined) { value = valueOf(match[1], match[2], match[3]); kind = 'money'; }
    else if (match[4] !== undefined) { value = valueOf(match[4], match[5]); kind = 'share'; }
    else if (match[7] !== undefined) {
      const times = !!match[9] && /x|×/i.test(match[9]);
      value = valueOf(match[7], match[8], match[9] && !times ? match[9] : undefined);
      if (value <= 10) continue;
    } else {
      // A multiple is a claim at any size: "they pay 2x the median" is the classic invented benchmark.
      value = valueOf(match[11], match[12]);
      kind = 'share';
      if (value <= 1) continue;
    }
    // A figure may be quoted in its bare form too ("18" for "18 months"), so the unscaled number also counts.
    const bare = match[1] === undefined && match[4] === undefined ? valueOf(match[7] ?? match[11], match[8] ?? match[12]) : undefined;
    if (found(value, kind) || (bare !== undefined && found(bare, kind)) || derived(value, kind, nearby(reply, match.index, match[0].length))) {
      // Worked out once, it is known for the next figure in the reply ($1,960 a month, so $23,520 a year).
      known.push({ value, digits: 12, kind });
      continue;
    }
    note(proposed(reply, match.index) ? proposals : unsourced, label);
  }
  for (const match of reply.matchAll(SPAN)) {
    const ends = [valueOf(match[1], match[2]), ...(match[3] === undefined ? [] : [valueOf(match[3], match[4])])];
    if ((match[3] === undefined && match[6] === undefined) || Math.max(...ends) <= 10 || ends.every((end) => found(end, 'other'))) continue;
    note(proposed(reply, match.index) ? proposals : unsourced, match[0].trim());
  }
  return { unsourced, proposals };
}

export const unsourcedFigures = (reply: string, sources: string[]): string[] => figureCheck(reply, sources).unsourced;

// Which parts of a person's system prompt are instructions to the model rather than facts about the company: who
// the person is (the first part), the stance, the rules and tools, the day, the playbook. Each such part is dropped on
// its own and everything else is kept: documents, the founder's words, notes, pages, decisions, memory, colleagues,
// and the card lines the slices add at the end (Runway, Metrics, interviews and the rest). Only the playbook runs over
// several parts, and is dropped up to its closing line or the next fact heading. The rules are matched on the exact
// words the prompt writes, so a document's paragraph that starts "Today is" stays.
const FACT_STARTS = /^(?:## Doc: |## Page: |About the founder\.|Company documents every person reads:|The founder has connected these documents|Sticky notes the founder connected|Web pages the founder connected|What the founder has decided|Your memory \(|Colleagues connected to your room|From the founder's notes \(|- A )/;
const RULE_STARTS = /^(?:Reply in short markdown: |You can act with these tools: |Not connected to your room, so you cannot yet: |Only the recent part of this conversation is in front of you\.|Decisions are the founder's, and they are kept on record\.|Websites the founder trusts\. |No documents are connected to your room, so |Today is [^\n]*, in the founder's time zone)/;
const PLAYBOOK_HEAD = /^Your company playbook: /;
const PLAYBOOK_END = /^When the founder asks you to learn how something was done/;
function factsOf(system: string, stances: string[]): string {
  let text = system;
  for (const stance of stances) text = text.split(stance).join('\n\n');
  const parts = text.split(/\n{2,}/);
  let playbook = false;
  const kept: string[] = [];
  parts.forEach((part, index) => {
    if (playbook) {
      if (PLAYBOOK_END.test(part)) { playbook = false; return; }
      if (!FACT_STARTS.test(part)) return;
      playbook = false;
    }
    if (index === 0 && /^You are [^\n]{1,80}?, /.test(part)) return;
    if (PLAYBOOK_HEAD.test(part)) { playbook = true; return; }
    if (RULE_STARTS.test(part) || !part.trim()) return;
    kept.push(part);
  });
  return kept.join('\n\n');
}

// What a turn counts as read, for the truth net: the founder's words, the documents and notes the prompt carried,
// the history, and every tool result. The person's own brief, the stance and the rules around them are instructions
// to the model, not facts about the company: a "$2k" or a "2%" there sources nothing the model then says.
export function turnSources(messages: { role: string; content: unknown }[], stances: string[] = [STANCE, PARTNER_STANCE]): string[] {
  return messages.map((message) => {
    const content = typeof message.content === 'string' ? message.content : '';
    return message.role === 'system' ? factsOf(content, stances) : content;
  }).filter(Boolean);
}

// A tool call the model wrote out as words instead of making it: the XML shapes of Qwen and Hermes, a raw JSON call,
// or a tool's name with its JSON arguments right after it ("**ask_founder**{...}").
export function proseToolCall(reply: string, names: string[] = []): boolean {
  if (/<\/?tool_call>|<function=|<\|(?:tool_call|function_call)/i.test(reply)) return true;
  if (/\{\s*"(?:name|tool)"\s*:\s*"[\w.-]+"\s*,\s*"(?:arguments|parameters|args)"\s*:/.test(reply)) return true;
  return [...new Set([...names, 'ask_founder', 'ask_person'])].some((name) =>
    new RegExp(String.raw`(?:^|[^\w])${name}\**\`*\s*\(?\s*\{\s*"`).test(reply));
}

// Said to a model that wrote its tool call out as text: once, before the founder is shown a clean line instead.
export const CALL_THE_TOOL = 'You wrote a tool call as text. Call the tool, do not write it as text. If you meant to answer, answer in plain words.';
export const ANSWER_IN_WORDS = 'You wrote a tool call as text, but no tool can be called here. Answer in plain words.';
export const HELD_BACK = 'This reply wrote a tool call out as text twice instead of making it, so it was held back. Ask again, or ask for a plain answer.';

// A reply with the truth net's lines taken off again, for a reader that grades only the person's own words.
export function withoutFlags(text: string, flags: string[] = []): string {
  return flags.reduce((kept, flag) => kept.replace(`\n\n${flag}`, '').replace(flag, ''), text).trimEnd();
}

// The lines the founder sees under a reply that says more than this turn can back.
export function checkReply(input: { reply: string; receipts: Receipt[]; sources: string[] }): string[] {
  const lines: string[] = [];
  const claims = unreceiptedClaims(input.reply, input.receipts);
  if (claims.length) lines.push(`Unconfirmed: this reply claims an action no tool confirmed (${claims.join(', ')}).`);
  const figures = unsourcedFigures(input.reply, input.sources);
  if (figures.length) lines.push(`Unsourced figures: ${figures.slice(0, 8).join(', ')} (not found in anything this turn read).`);
  return lines;
}
