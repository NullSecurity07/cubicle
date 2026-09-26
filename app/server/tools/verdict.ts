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

// The text under a heading, up to the next heading of the same or a higher level; null when there is no such heading.
export function sectionBody(text: string, heading: string): string | null {
  const all = headings(text);
  const hit = all.find((one) => headingKey(one.title) === headingKey(heading));
  if (!hit) return null;
  const next = all.find((one) => one.line > hit.line && one.level <= hit.level);
  return text.split('\n').slice(hit.line + 1, next ? next.line : undefined).join('\n').trim();
}

// The same document with the text under one heading swapped, the heading and every other line kept as they were.
function withBody(text: string, heading: string, body: string): string {
  const all = headings(text);
  const hit = all.find((one) => headingKey(one.title) === headingKey(heading));
  if (!hit) return text;
  const next = all.find((one) => one.line > hit.line && one.level <= hit.level);
  const lines = text.split('\n');
  const tail = next ? lines.slice(next.line) : [];
  return [...lines.slice(0, hit.line + 1), '', ...(body ? [body, ''] : []), ...tail].join('\n').replace(/\n*$/, '\n');
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

// The verdict word and the score a verdict gives. The template's own "(STRONG / WEAK / PIVOT REQUIRED)" is a label,
// not a verdict, so anything in brackets with a slash in it is read past. The score is read from a line that starts
// with "Score" before anything else, because the reasons carry figures too: "7 of 10 we called said it hurts".
export function verdictOf(body: string, outcomes: string[]): { word?: string; score?: number } {
  const lines = filled(body).map(bare).map((line) => line.replace(/\([^)]*\/[^)]*\)/g, ' '));
  const text = lines.join('\n');
  const found = outcomes.map((word) => ({ word, at: text.search(new RegExp(`\\b${word}\\b`)) })).filter((one) => one.at >= 0).sort((a, b) => a.at - b.at);
  const outOfTen = /(\d+(?:\.\d+)?)\s*(?:\/|out of|of)\s*10\b/i;
  const scoreLine = lines.find((line) => /^score\b/i.test(line));
  const out = (scoreLine && (outOfTen.exec(scoreLine) ?? /:\s*(\d+(?:\.\d+)?)/.exec(scoreLine))) ?? outOfTen.exec(text);
  return { word: found[0]?.word, score: out ? Number(out[1]) : undefined };
}

const SPELLED = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const NUMBER = `(\\d+|${SPELLED.join('|')})`;
const countOf = (word: string) => (/^\d+$/.test(word) ? Number(word) : SPELLED.indexOf(word.toLowerCase()));

// How many customer conversations a section records, or null when it records none at all. The template's line comes
// first, read past bold and bullets; a section written as prose is read for a number next to the conversations
// ("talked to 12 founders", "14 customer interviews"). No count anywhere is no evidence, and the cap holds.
export function conversations(section: string, label: string): number | null {
  const line = section.split('\n').map(bare).find((one) => one.toLowerCase().startsWith(label.toLowerCase()));
  if (line) {
    const value = line.slice(line.indexOf(':') + 1);
    if (/^\W*(none|no\b|nil)/i.test(value)) return 0;
    const count = new RegExp(`\\b${NUMBER}\\b`, 'i').exec(value);
    if (count) return countOf(count[1]);
  }
  const prose = bare(section.replace(/\n/g, ' '));
  const hit = new RegExp(`\\b${NUMBER}\\s+(?:[\\w-]+\\s+){0,3}?(?:conversations?|interviews?|calls?)\\b`, 'i').exec(prose)
    ?? new RegExp(`\\b(?:talked (?:to|with)|spoke (?:to|with)|interviewed|called)\\s+${NUMBER}\\b`, 'i').exec(prose);
  return hit ? countOf(hit[1]) : null;
}

export type Guarded = { text: string; note?: string; held?: boolean };

// `before` and `after` are the whole doc either side of one write by `writerId`. Returns the text to save (with a
// "not assessed" verdict or a stale mark put in) and a note for the writer, or throws the reason nothing is written.
export function guardWrite(input: { rules: DocRules; stage: Stage; docId: string; writerId: string; before: string; after: string; now: number }): Guarded {
  const { rules, stage, docId, writerId, before, now } = input;
  let after = input.after;
  const changed = (heading: string) => (sectionBody(before, heading) ?? '') !== (sectionBody(after, heading) ?? '');
  const writer = stage.rooms.find((room) => room.id === writerId);

  // Only the person placed for a section writes it. The verdict judge above all: a missing section is theirs to name.
  for (const { heading, by } of [...rules.sections, rules.verdict]) {
    const owner = ownerOf(stage, rules, by, docId);
    if (!owner || owner.id === writerId || !changed(heading)) continue;
    throw new Error(`not written: "${titleOf(before, heading)}" is ${owner.name}'s section (${owner.role}), and only they write it. `
      + `Ask ${owner.name} with ask_person, or name what is missing in your own section; never fill in their part yourself.`);
  }

  const verdictAt = rules.verdict.heading;
  const verdictBefore = sectionBody(before, verdictAt);
  if (changed(verdictAt)) {
    // A verdict written anew answers every stale mark on the old one.
    const fresh = (sectionBody(after, verdictAt) ?? '').split('\n').filter((line) => !STALE.test(line.trim())).join('\n').trim();
    after = withBody(after, verdictAt, fresh);
    if (filled(fresh).length) {
      const empty = rules.sections.filter(({ heading }) => sectionBody(after, heading) !== null && !filled(sectionBody(after, heading)).length);
      if (empty.length) {
        const names = empty.map(({ heading }) => titleOf(after, heading));
        const who = [...new Set(empty.map(({ by }) => ownerOf(stage, rules, by, docId)?.name).filter((name): name is string => !!name))];
        const body = `${names.map((name) => `Not assessed: ${name}`).join('\n')}\n\nNo verdict and no score until ${names.length > 1 ? 'these sections are' : 'this section is'} written.`;
        return {
          text: withBody(after, verdictAt, body),
          held: true,
          note: `Not written: the verdict waits for ${names.map((name) => `"${name}"`).join(', ')}, which ${names.length > 1 ? 'are' : 'is'} empty. `
            + `The verdict section now says "Not assessed". ${who.length ? `Ask ${who.join(' or ')} with ask_person, or tell the founder what is missing` : 'Tell the founder what is missing'}; never write that section yourself.`,
        };
      }
      const { word, score } = verdictOf(fresh, rules.outcomes ?? []);
      for (const cap of rules.caps ?? []) {
        if (conversations(sectionBody(after, cap.heading) ?? '', cap.line)) continue;
        const order = rules.outcomes ?? [];
        const over = (word && order.indexOf(word) > order.indexOf(cap.verdict)) || (score !== undefined && score > cap.score);
        if (over) {
          throw new Error(`not written: ${cap.why}, so the verdict is at most ${cap.verdict} and the score at most ${cap.score} of 10. `
            + `This one says ${[word, score !== undefined ? `${score} of 10` : ''].filter(Boolean).join(', ')}. Write it again within the cap, and say which section each fact comes from.`);
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
