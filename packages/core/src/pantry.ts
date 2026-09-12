import type { Vault } from './vault.js';
import { stringifyNote } from './frontmatter.js';
import { listIdeas, sameIdeaTitle, writeIdeaCard } from './ideas.js';

/**
 * The pantry: when two people have nothing to do, they have a coffee and talk shop for six turns on the cheap
 * tier. The conversation is written down, the office shows it, and at most once a day a genuinely new idea out
 * of it becomes an `Ideas/` card tagged `pantry`.
 *
 * The rule that makes this safe to have at all is that **the idea filter is arithmetic, not a judgement**. A
 * model asked "was that a good idea?" answers yes. The four conditions below are checkable by anyone reading the
 * note, the note says which one failed, and no second model call is ever made.
 */

export const PANTRY_DIR = 'Pantry';
/** Six turns of at most two sentences. The cap is the point: a coffee break is not a meeting. */
export const PANTRY_MAX_TURNS = 6;
/** Fewer words than this is a fragment, not an idea. */
export const PANTRY_IDEA_MIN_WORDS = 4;
/** An idea sharing this much of its content words with a card already on the board is the same idea in new words. */
export const PANTRY_OVERLAP_MAX = 0.5;
/** What `writeIdeaCard` records as the card's provenance (`IDEA_SOURCES` already knows the word). */
export const PANTRY_SOURCE = 'pantry';
/** A title longer than this is a paragraph; the board reads titles. */
export const PANTRY_IDEA_CHARS = 160;

/** `clo-and-cmo`, from the pair, so a day's notes sort by who was in the room. */
export function pantrySlug(participants: string[]): string {
  const s = participants.map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).filter(Boolean).join('-and-');
  return (s || 'pantry').slice(0, 60).replace(/-+$/, '');
}

/** `Pantry/<YYYY-MM-DD>-<slug>.md`, suffixed rather than overwritten when the same pair meet twice in a day. */
export function pantryNotePath(vault: Vault, now: Date, participants: string[]): string {
  const base = `${PANTRY_DIR}/${now.toISOString().slice(0, 10)}-${pantrySlug(participants)}`;
  if (!vault.exists(`${base}.md`)) return `${base}.md`;
  let n = 2;
  while (vault.exists(`${base}-${n}.md`)) n++;
  return `${base}-${n}.md`;
}

/**
 * The idea a chat produced, or null.
 *
 * **Give it the closing turn, not the whole transcript.** Only the closing turn is asked for an `IDEA:` line, and
 * over a whole transcript a speaker who writes "Idea: we should call the nurseries" at turn three would supply
 * the card whenever the closing turn omits its own (review minor 8). Within what it is given, the **last** such
 * line wins, because a turn may mention the word before it gets to the line the prompt asked for.
 *
 * `none`, an empty line and anything under four words are all null: a coffee break that produced nothing is the
 * normal outcome.
 */
export function pantryIdea(closingTurn: string): string | null {
  let found: string | null = null;
  for (const line of closingTurn.split('\n')) {
    const m = /IDEA:\s*(.*)$/i.exec(line);
    if (m) found = m[1];
  }
  if (found === null) return null;
  const idea = found.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().replace(/^["']|["'.]+$/g, '').trim();
  if (!idea || /^none$/i.test(idea)) return null;
  if (idea.split(' ').filter(Boolean).length < PANTRY_IDEA_MIN_WORDS) return null;
  return idea.slice(0, PANTRY_IDEA_CHARS);
}

/**
 * Words that carry no meaning for "is this the same idea". Kept short and dull on purpose: a long stop list
 * starts making judgements about which words matter, which is what this rule exists not to do.
 */
export const PANTRY_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'our', 'ours', 'their', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'you', 'your', 'its', 'can', 'could', 'would', 'should', 'about', 'than',
  'then', 'they', 'them', 'what', 'when', 'where', 'which', 'who', 'why', 'how', 'all', 'any', 'one', 'out',
  'more', 'most', 'very', 'just', 'also', 'there', 'been', 'being', 'will', 'each', 'every', 'some', 'such',
  'only', 'over', 'under', 'after', 'before', 'while', 'because', 'however', 'though', 'let', 'get', 'use',
]);

/** A title's content words: lower-cased, three letters or more, stop-words dropped, deduplicated. */
export function ideaWords(title: string): string[] {
  return [...new Set(title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !PANTRY_STOP_WORDS.has(w)))];
}

/**
 * `|A ∩ B| / min(|A|, |B|)` — the overlap coefficient, not Jaccard (Decision 15). "Meal kits for nurseries" and
 * "Meal kits for nursery managers" share two of three content words and score 0.67 here but only 0.40 on
 * Jaccard, because the longer title dilutes the union — and a card that says the same thing with two extra words
 * is precisely what this rule is for.
 */
export function overlapCoefficient(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  return a.filter((w) => sb.has(w)).length / Math.min(a.length, b.length);
}

export interface PantryIdeaCheck { ok: boolean; why: string }

/**
 * The four conditions of §7, in order, so the reason the note records is the first one that failed:
 * it survived `pantryIdea`; no card is the same idea by title; no card overlaps it by half or more; and no
 * `pantry` card was filed today. One card a day, company-wide — the point is one good card, not a queue of
 * near-duplicates for the board to wade through.
 */
export function pantryIdeaIsNew(vault: Vault, idea: string | null, now: Date): PantryIdeaCheck {
  if (!idea) return { ok: false, why: 'nothing new came out of the chat' };
  const cards = listIdeas(vault);
  const same = cards.find((c) => sameIdeaTitle(c.title, idea));
  if (same) return { ok: false, why: `already on the board as Ideas/${same.id}.md` };
  const words = ideaWords(idea);
  const near = cards.find((c) => overlapCoefficient(words, ideaWords(c.title)) >= PANTRY_OVERLAP_MAX);
  if (near) return { ok: false, why: `too close to Ideas/${near.id}.md ("${near.title}")` };
  const today = now.toISOString().slice(0, 10);
  const already = cards.find((c) => c.source === PANTRY_SOURCE && String(c.created).slice(0, 10) === today);
  if (already) return { ok: false, why: `a pantry idea was already filed today (Ideas/${already.id}.md)` };
  return { ok: true, why: 'new' };
}

export interface FiledPantryIdea { slug: string | null; why: string }

/**
 * File the card, or say why not. Written through `writeIdeaCard` — the same path discovery and intelligence use —
 * so the card gets the same eight sections, the same scoring and the same route to the board.
 */
export function filePantryIdea(vault: Vault, o: { idea: string | null; note: string; now: Date; by?: string }): FiledPantryIdea {
  const check = pantryIdeaIsNew(vault, o.idea, o.now);
  if (!check.ok || !o.idea) return { slug: null, why: check.why };
  const slug = writeIdeaCard(vault, {
    title: o.idea,
    source: PANTRY_SOURCE,
    evidence: [o.note],
    what_changed: 'Two people with nothing on talked it over in the pantry.',
    why_it_matters: o.idea,
  }, o.by ?? 'daemon');
  return { slug, why: 'new' };
}

export interface PantryTurn { role: string; name: string; text: string }

export interface PantryNoteInputs {
  date: string;
  cycle: number;
  participants: string[];
  turns: PantryTurn[];
  idea: string | null;
  filed: string | null;
  why: string;
}

/** How much of one turn the note keeps. The same budget the office puts in a speech bubble, twice over. */
export const PANTRY_NOTE_TURN_CHARS = 280;

/** `Pantry/<date>-<slug>.md`: the transcript, one speaker per line, and what became of the idea. */
export function pantryNote(o: PantryNoteInputs): string {
  const chat = o.turns.length
    ? o.turns.map((t) => `**${t.name}:** ${t.text.replace(/\s*\r?\n\s*/g, ' ').slice(0, PANTRY_NOTE_TURN_CHARS)}`).join('\n\n')
    : '_Nobody said anything: no model was available._';
  // An idea with no `why` is one the note was written *before* the card was filed — the order that keeps an
  // `Ideas/` card from ever citing a `Pantry/` note that does not exist. The second write fills the line in; a
  // kill in between leaves the idea on the record without a verdict beside it, which is the truth of that moment.
  const idea = o.filed
    ? `${o.idea}\n\nFiled as [[${o.filed}]].`
    : o.idea
      ? (o.why ? `${o.idea}\n\nNot filed: ${o.why}.` : String(o.idea))
      : '_Nothing new._';
  return stringifyNote({
    date: o.date,
    cycle: o.cycle,
    participants: o.participants,
    turns: o.turns.length,
    idea: o.filed ?? '',
  }, [
    `# Pantry: ${o.participants.join(' and ')}`,
    '',
    '_Written by the daemon. Two people with nothing on, six turns at most, on the cheapest model there is, charged to the house._',
    '',
    '## Chat',
    '',
    chat,
    '',
    '## Idea',
    '',
    idea,
    '',
  ].join('\n'));
}
