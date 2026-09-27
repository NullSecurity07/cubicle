import type { DocRules, Room, Stage } from '../../shared/model.ts';
import { shortDay } from '../clock.ts';
import { wiredDocIds } from '../prompt.ts';
import { headingKey, headings } from './sections.ts';

// What a team's shared doc lets a person write, held in code because the briefs alone were not enough: on a live run
// the judge wrote a colleague's section herself with an invented founder fit, scored STRONG 10 of 10 on zero
// customer interviews, and the verdict stayed standing after the section under it changed. A doc whose `rules` say
// whose each section is gets four checks on every write a person makes through the doc tools:
// - a section belongs to the person placed for it, while that person is on the stage;
// - the verdict is not written while a section it waits on is empty: the verdict says "Not assessed" instead;
// - a cap the evidence sets (no customer conversations) bounds the verdict word and the score;
// - a section that changes under a standing verdict marks the verdict stale, and a new verdict clears the mark.

const STALE = /^Stale: .* changed after this verdict on .*\.$/;
const NOT_ASSESSED = /^not assessed\b/i;

// Where each copy of a heading's section starts and ends, as line numbers: the heading line, and the line after the
// section's last. A doc is meant to hold one of each, but one written before the doc tools refused a second copy may
// hold two, and every check reads them all: a verdict under the second copy is still a verdict.
function copies(text: string, heading: string): { at: number; end: number }[] {
  const all = headings(text);
  const total = text.split('\n').length;
  return all.filter((one) => headingKey(one.title) === headingKey(heading)).map((hit) => {
    const next = all.find((one) => one.line > hit.line && one.level <= hit.level);
    return { at: hit.line, end: next ? next.line : total };
  });
}

// The text under a heading, up to the next heading of the same or a higher level, every copy's in order; null when
// there is no such heading.
export function sectionBody(text: string, heading: string): string | null {
  const found = bodies(text, heading);
  return found.length ? found.filter(Boolean).join('\n\n') : null;
}

// Each copy's text on its own.
function bodies(text: string, heading: string): string[] {
  const lines = text.split('\n');
  return copies(text, heading).map(({ at, end }) => lines.slice(at + 1, end).join('\n').trim());
}

// The same document with the text under one heading swapped, the heading and every other line kept as they were.
// A second copy of the heading goes, words and all: what it said is in `body` already, read by sectionBody.
function withBody(text: string, heading: string, body: string): string {
  const found = copies(text, heading);
  if (!found.length) return text;
  let lines = text.split('\n');
  for (const { at, end } of found.slice(1).reverse()) lines = [...lines.slice(0, at), ...lines.slice(end)];
  const [{ at, end }] = found;
  return [...lines.slice(0, at + 1), '', ...(body ? [body, ''] : []), ...lines.slice(end)].join('\n').replace(/\n*$/, '\n');
}

// What a person really wrote under a heading: the template's labels ("In one sentence:"), its dashes and blank lines
// do not count, nor do a stale mark or a "not assessed" line, which say the section still waits for its work.
export function filled(body: string | null): string[] {
  return (body ?? '').split('\n').map((line) => line.trim()).filter((line) => line
    && !/:$/.test(line) && !/^[\s\p{P}\p{S}\d]*$/u.test(line) && !STALE.test(line) && !NOT_ASSESSED.test(line));
}

const titleOf = (text: string, heading: string) => headings(text).find((one) => headingKey(one.title) === headingKey(heading))?.title ?? heading;

// The person placed for a section, when they are on this stage and wired to this doc; nobody when they have been
// fired or renamed away. The wire matters: a team placed twice has two people with the same framework key, and each
// owns the sections of the doc their own team was placed with, never the other copy's.
const ownerOf = (stage: Stage, rules: DocRules, by: string, docId: string): Room | undefined =>
  stage.rooms.find((room) => room.framework?.id === rules.framework && room.framework.key === by && wiredDocIds(stage, room.id).includes(docId));

// A line with its markdown taken off: list marks, quote marks, emphasis. "- **Score:** 4/10" reads as "Score: 4/10".
const bare = (line: string) => line.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '').replace(/[*_`]/g, '').trim();

// A colleague's answer from chat is written with a marker line quoting the question it answered. The question is the
// asker's words, not evidence: "after your 12 interviews?" in it once passed the pain cap on no interviews at all.
// Since the readers pass over such a line, only ask_person writes one: see guardWrite.
const MARKER = /^\(From chat:/;
export const unmarked = (text: string) => text.split('\n').filter((line) => !MARKER.test(bare(line))).join('\n');

// The verdict word and the score a verdict gives. The template's own "(STRONG / WEAK / PIVOT REQUIRED)" is a label,
// not a verdict, so anything in brackets with a slash in it is read past. The score is read from a line that starts
// with "Score" before anything else, because the reasons carry figures too: "7 of 10 we called said it hurts".
export function verdictOf(written: string, outcomes: string[], outOf = 10): { word?: string; score?: number } {
  const body = unmarked(written);
  // A template label that lists the words ("Vitamin — painkiller — hair on fire: painkiller") is read past as well.
  const listed = (label: string) => outcomes.filter((word) => wordAt(label, word) >= 0).length > 1;
  const lines = filled(body).map(bare).map((line) => line.replace(/\([^)]*\/[^)]*\)/g, ' '))
    .map((line) => (line.includes(':') && listed(line.slice(0, line.indexOf(':'))) ? line.slice(line.indexOf(':') + 1).trim() : line));
  const text = lines.join('\n');
  const found = outcomes.map((word) => ({ word, at: wordAt(text, word) })).filter((one) => one.at >= 0).sort((a, b) => a.at - b.at);
  const outOfTotal = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:\\/|out of|of)\\s*${outOf}\\b`, 'i');
  const scoreLine = lines.find((line) => /^score\b/i.test(line));
  // On the Score line, the last "N/10" is the total, since a breakdown comes before it; then a number after "=" ("2, 2, 2, 1, 1 = 8"), then the first number after the colon.
  const onLine = scoreLine && ([...scoreLine.matchAll(new RegExp(outOfTotal.source, 'gi'))].at(-1)
    ?? /=\s*(\d+(?:\.\d+)?)\s*$/.exec(scoreLine) ?? /:\s*(\d+(?:\.\d+)?)/.exec(scoreLine));
  const out = onLine ?? outOfTotal.exec(text);
  return { word: found[0]?.word, score: out ? Number(out[1]) : undefined };
}

// Where a rating word stands in a text, or -1. Verdict words are capitals and matched as written, so "a strong signal"
// is no STRONG; lower-case words ("hair on fire") match any case, and a hyphen for a space.
function wordAt(text: string, word: string): number {
  const pattern = word.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]+');
  return text.search(new RegExp(`\\b${pattern}\\b`, word === word.toUpperCase() ? '' : 'i'));
}

const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
// A count as people write one: 12, "25+", twelve, "a dozen", "half a dozen", "two dozen". Ends where a word would
// go on, since a "+" has no word boundary after it.
const NUMBER = `((?:half\\s+a|a|\\d+|${SPELLED.join('|')})\\s+dozen|\\d+\\+?|${SPELLED.join('|')})(?![\\w+])`;
function countOf(said: string): number {
  const words = said.toLowerCase().replace(/\+$/, '').split(/\s+/);
  const one = (word: string) => (/^\d+$/.test(word) ? Number(word) : SPELLED.indexOf(word));
  if (words.at(-1) !== 'dozen') return one(words[0]);
  if (words[0] === 'half') return 6;
  return (words[0] === 'a' ? 1 : one(words[0])) * 12;
}

// How many customer conversations a section records, or null when it records none at all. The template's line comes
// first, read past bold and bullets; a section written as prose is read for a number next to the conversations
// ("talked to 12 founders", "14 customer interviews"). No count anywhere is no evidence, and the cap holds.
export function conversations(text: string, label: string): number | null {
  // A struck-out count is a count taken back: "~~12~~ 0" is none.
  const section = unmarked(text).replace(/~~[^~]*~~/g, ' ');
  const line = section.split('\n').map(bare).find((one) => one.toLowerCase().startsWith(label.toLowerCase()));
  if (line) {
    // What follows the label, past the template's own "(of ten to twenty)" and whatever separates the two.
    const value = line.slice(label.length).replace(/^\s*\([^)]*\)/, '').replace(/^[\s:=\-–—]+/, '');
    if (/^\W*(none|no\b|nil)/i.test(value)) return 0;
    // "12 (planned)", "12 booked for next week": talks still to come are none held yet.
    if (/\b(planned|plan|booked|scheduled|will|next)\b/i.test(value)) return null;
    const count = new RegExp(`\\b${NUMBER}`, 'i').exec(value);
    if (count) return countOf(count[1]);
  }
  // Clause by clause, and never one that denies or only plans them: "none of the 12 interviews happened", "10 calls
  // planned" are no conversations at all.
  for (const clause of bare(section.replace(/\n/g, ' ')).split(/[.;,!?]+/)) {
    if (/\b(none|no|not|never|planned|plan|booked|scheduled|will|next)\b/i.test(clause)) continue;
    const hit = new RegExp(`\\b${NUMBER}\\s+(?:[\\w-]+\\s+){0,3}?(?:conversations?|interviews?|calls?)\\b`, 'i').exec(clause)
      ?? new RegExp(`\\b(?:talked (?:to|with)|spoke (?:to|with)|interviewed|called)\\s+${NUMBER}`, 'i').exec(clause);
    if (hit) return countOf(hit[1]);
  }
  return null;
}

// A section's words, without its layout: each line bare of list marks and emphasis, spaces run together, blank lines gone.
const words = (body: string | null) => (body ?? '').split('\n').map((line) => bare(line).replace(/\s+/g, ' ')).filter(Boolean).join('\n');

// The count a cap rests on, quoted as it was read, so a writer refused by it sees why rather than guessing.
function countRead(section: string, label: string): string {
  const line = section.split('\n').map(bare).find((one) => one.toLowerCase().startsWith(label.toLowerCase()));
  return line ? `The count line reads "${line}".` : `There is no "${label}" line, and no count of conversations in the section.`;
}

export type Guarded = { text: string; note?: string; held?: boolean };

// `before` and `after` are the whole doc either side of one write by `writerId`. Returns the text to save (with a
// "not assessed" verdict or a stale mark put in) and a note for the writer, or throws the reason nothing is written.
export function guardWrite(input: { rules: DocRules; stage: Stage; docId: string; writerId: string; before: string; after: string; now: number; fromChat?: boolean }): Guarded {
  const { rules, stage, docId, writerId, before, now } = input;
  // A marker line is read past by the caps and the verdict reader, so one written by hand hid "STRONG, Score: 9/10"
  // from them. Only a colleague's answer put in by ask_person carries one.
  // Each with the section it stands in, so a real one copied under another heading counts as new.
  const chatLines = (text: string) => {
    let under = '';
    return text.split('\n').flatMap((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
      if (heading) under = headingKey(heading[1]);
      return MARKER.test(bare(line)) ? [`${under}\n${bare(line)}`] : [];
    });
  };
  const had = new Set(chatLines(before));
  if (!input.fromChat && chatLines(input.after).some((line) => !had.has(line))) {
    throw new Error('not written: a "(From chat:" line is written only by ask_person, when a colleague\'s answer goes into their section. Write your own words without it.');
  }
  let after = input.after;
  // A section has changed when its words have: a whole rewrite that only re-spaced or re-bulleted a colleague's
  // section, as models do when they copy a doc back, was refused whole, the writer's own section with it.
  const changed = (heading: string) => words(sectionBody(before, heading)) !== words(sectionBody(after, heading));
  const writer = stage.rooms.find((room) => room.id === writerId);

  // Only the person placed for a section writes it. The verdict judge above all: a missing section is theirs to name.
  for (const { heading, by } of [...rules.sections, rules.verdict]) {
    const owner = ownerOf(stage, rules, by, docId);
    if (!owner || owner.id === writerId || !changed(heading)) continue;
    const title = titleOf(before, heading);
    // An empty section is said to be empty, by whom: a judge told only "only they write it" has told the founder the
    // heading was missing "as required by the parser", a cause of her own.
    const unwritten = filled(sectionBody(before, heading)).length ? '' : `${owner.name} has not written "${title}" yet. `;
    throw new Error(`not written: "${title}" is ${owner.name}'s section (${owner.role}), and only they write it. ${unwritten}`
      + `Ask ${owner.name} with ask_person, or name what is missing in your own section; never fill in their part yourself.`
      + (unwritten ? ` If you tell the founder why, say exactly that ${owner.name} has not written "${title}"; nothing else in the document is wrong.` : ''));
  }

  // A section's own claim held to the evidence beside it: with no conversations, the pain can be no more than a guess.
  for (const cap of (rules.caps ?? []).filter((one) => one.on && changed(one.on))) {
    const body = sectionBody(after, cap.on!) ?? '';
    if (!filled(body).length || conversations(sectionBody(after, cap.heading) ?? '', cap.line)) continue;
    const order = cap.outcomes ?? [];
    const outOf = cap.outOf ?? 10;
    const { word, score } = verdictOf(body, order, outOf);
    if ((word && order.indexOf(word) > order.indexOf(cap.verdict)) || (score !== undefined && score > cap.score)) {
      throw new Error(`not written: ${cap.why}, so ${cap.name ?? 'this section'} is at most ${cap.verdict} and ${cap.score} of ${outOf}. `
        + `This one says ${[word, score !== undefined ? `${score} of ${outOf}` : ''].filter(Boolean).join(', ')}. ${countRead(sectionBody(after, cap.heading) ?? '', cap.line)} `
        + 'Write it again within the cap, and mark what is unproven.');
    }
  }

  const verdictAt = rules.verdict.heading;
  const verdictBefore = sectionBody(before, verdictAt);
  if (changed(verdictAt)) {
    // A verdict written anew answers every stale mark on the old one.
    // Where a doc holds two copies, the verdict is the copy that was written just now: an old copy's words left
    // standing beside it would say STRONG 10/10 under a new WEAK.
    const was = new Set(bodies(before, verdictAt));
    const written = bodies(after, verdictAt).filter((one) => !was.has(one));
    const fresh = (written.length ? written.join('\n\n') : sectionBody(after, verdictAt) ?? '').split('\n').filter((line) => !STALE.test(line.trim())).join('\n').trim();
    after = withBody(after, verdictAt, fresh);
    if (filled(fresh).length) {
      const empty = rules.sections.filter(({ heading }) => sectionBody(after, heading) !== null && !filled(sectionBody(after, heading)).length);
      if (empty.length) {
        const names = empty.map(({ heading }) => titleOf(after, heading));
        const owners = empty.map(({ by }) => ownerOf(stage, rules, by, docId)?.name);
        const who = [...new Set(owners.filter((name): name is string => !!name))];
        // Each empty section with the person who has not written it: the truth, said so the judge repeats it.
        const missing = names.map((name, at) => (owners[at] ? `${owners[at]} has not written "${name}" yet` : `"${name}" is empty and nobody on the stage is placed to write it`));
        const body = `${names.map((name, at) => `Not assessed: ${name}${owners[at] ? ` (${owners[at]} has not written it yet)` : ''}`).join('\n')}\n\nNo verdict and no score until ${names.length > 1 ? 'these sections are' : 'this section is'} written.`;
        return {
          text: withBody(after, verdictAt, body),
          held: true,
          note: `Not written: the verdict waits because ${missing.join(', and ')}. The verdict section now says "Not assessed". `
            + `${who.length ? `Ask ${who.join(' or ')} with ask_person, or tell the founder exactly that` : 'Tell the founder exactly that'}: nothing else in the document is wrong. Never write that section yourself.`,
        };
      }
      const { word, score } = verdictOf(fresh, rules.outcomes ?? []);
      for (const cap of (rules.caps ?? []).filter((one) => !one.on)) {
        if (conversations(sectionBody(after, cap.heading) ?? '', cap.line)) continue;
        const order = rules.outcomes ?? [];
        const over = (word && order.indexOf(word) > order.indexOf(cap.verdict)) || (score !== undefined && score > cap.score);
        if (over) {
          throw new Error(`not written: ${cap.why}, so the verdict is at most ${cap.verdict} and the score at most ${cap.score} of 10. `
            + `This one says ${[word, score !== undefined ? `${score} of 10` : ''].filter(Boolean).join(', ')}. ${countRead(sectionBody(after, cap.heading) ?? '', cap.line)} `
            + 'Write it again within the cap, and say which section each fact comes from.');
        }
      }
    }
    return { text: after };
  }

  // A section the verdict rests on changed under a verdict that stands: the verdict says so, once per section.
  if (!verdictBefore || !filled(verdictBefore).length) return { text: after };
  const moved = rules.sections.filter(({ heading }) => changed(heading)).map(({ heading }) => titleOf(after, heading));
  if (!moved.length) return { text: after };
  const kept = (sectionBody(after, verdictAt) ?? '').split('\n').filter((line) => !moved.some((name) => line.trim().startsWith(`Stale: ${name} changed`)));
  const marks = moved.map((name) => `Stale: ${name} changed after this verdict on ${shortDay(now)}.`);
  const judge = ownerOf(stage, rules, rules.verdict.by, docId);
  return {
    text: withBody(after, verdictAt, [...marks, ...kept].join('\n').trim()),
    note: `The verdict was written before this change, so it is now marked stale${judge && judge.id !== writer?.id ? `; ${judge.name} judges it again` : ''}.`,
  };
}
