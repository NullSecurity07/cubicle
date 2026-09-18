import type { Vault } from './vault.js';

/**
 * What the board is allowed to call evidence (ruling W4-1).
 *
 * The second dry-run's board invented a three-month outbound test to 1,200 SaaS founders, a named former
 * Shopify performance lead, a $1.2 M revenue figure and a 5-of-80 pilot, and the chair promoted the numbers to
 * a FINDING that reached the owner as "The pilot data shows only 1-2 paid conversions per 100 contacts". None
 * of it happened. Nothing in the room checked, because nothing in the room could: a turn is prose, and prose
 * cannot be told from a citation by reading it hard enough.
 *
 * So the rule is a *shape*: a board turn may state evidence only as a link to a note that exists in this vault.
 * A claim carrying a number, a named person or a named company with no such link is opinion, and has to say so.
 * That is checkable in code, which is the whole reason it is the rule — and every piece of the check lives
 * here, beside the constants the prompts quote, so what the board is told and what the board is held to cannot
 * drift apart.
 */

/** What an unresolved reference is annotated with, in the transcript, where the turn made it. */
export const NO_SUCH_NOTE = '(no such note)';

/** The two phrasings an advisor is told to use for a claim it cannot back. Quoted verbatim in the prompts. */
export const OPINION_PHRASES = ['in my opinion', 'unverified'] as const;

/** The suffix a chair finding carries to the owner when it cites no note that exists. */
export const BOARD_OPINION = "(the board's opinion)";

/** The rule itself, said once, so the advisor prompt, the chair prompt and this module all quote one sentence. */
export const EVIDENCE_RULE = [
  `Evidence is a link to a note in this vault — \`[[Research/<slug>/report]]\`, \`[[Ideas/<slug>]]\`, \`[[Meetings/<note>]]\` — and nothing else.`,
  `A claim that carries a number, a named person or a named company with no such link is opinion, not evidence: write "${OPINION_PHRASES[0]}" or "${OPINION_PHRASES[1]}" in the sentence that makes it.`,
  `Never invent a study, a pilot, a customer, a testimonial or a person. A link this vault does not hold is marked ${NO_SUCH_NOTE} in the transcript for the owner to see, and a turn that invents evidence is withheld from the board.`,
].join(' ');

/** What replaces a turn the constitution's `banned_tactics` classifier refused. */
export function withheldTurn(role: string): string {
  return `${role}'s turn was withheld: it invented evidence`;
}

/** What the chair is told about the turns that were withheld from it, or '' when none were. */
export function withheldNote(roles: readonly string[]): string {
  if (!roles.length) return '';
  return `${roles.join(' and ')} ${roles.length === 1 ? 'had its turn' : 'had their turns'} withheld for inventing evidence. You have not seen ${roles.length === 1 ? 'it' : 'them'}, and you may not rule on ${roles.length === 1 ? 'it' : 'them'}.`;
}

/**
 * The top-level folders a bare path may name. A reference is only checkable when it points somewhere the vault
 * actually keeps notes: `Research/…` is a claim about a report, `their/own/words` is prose with slashes in it.
 */
const VAULT_DIRS = [
  'Research', 'Ideas', 'Meetings', 'Decisions', 'Plans', 'Runs', 'Docs', 'Memory', 'Streams', 'Jobs',
  'Discovery', 'Metrics', 'Brand', 'Roles', 'Teams', 'Processes', 'Customers', 'Experiments', 'Workspace',
] as const;

/**
 * What a path may be made of. Every dash Unicode offers is in here on purpose: the live run's investor turn
 * cited `Research/speedaudit‑discovery/report` with U+2011 non-breaking hyphens, and a character class that
 * stopped at the ASCII `-` would have read that as `Research/speedaudit`, annotated *that*, and left the rest
 * of the fabricated path sitting in the sentence as if it were fine.
 */
const PATH_CHARS = "[A-Za-z0-9_.\\u2010-\\u2015/'()-]";

const WIKILINK_RE = /\[\[([^\]|\n]+?)(\|[^\]\n]*)?\]\]/g;
const BARE_PATH_RE = new RegExp(`(?<![A-Za-z0-9_/-])(?:${VAULT_DIRS.join('|')})/${PATH_CHARS}+`, 'g');

/** One reference a turn made, and where in the text it ends — so an annotation lands where the claim was made. */
export interface NoteRef {
  /** The reference as written, `[[…]]` brackets and all. */
  raw: string;
  /** What it points at, brackets and alias stripped. */
  target: string;
  /** Index just past the reference in the text it was read from. */
  end: number;
}

/** Every note this text refers to: wikilinks, and bare paths under a folder the vault keeps notes in. */
export function noteRefs(text: string): NoteRef[] {
  const out: NoteRef[] = [];
  const t = text ?? '';
  for (const m of t.matchAll(WIKILINK_RE)) {
    out.push({ raw: m[0], target: m[1].trim(), end: (m.index ?? 0) + m[0].length });
  }
  for (const m of t.matchAll(BARE_PATH_RE)) {
    const at = m.index ?? 0;
    // A bare path inside a wikilink is the same reference twice; the link already carries it.
    if (out.some((r) => at >= t.indexOf(r.raw) && at < r.end)) continue;
    const raw = m[0].replace(/[.,;:'()]+$/, '');
    out.push({ raw, target: raw, end: at + raw.length });
  }
  return out.sort((a, b) => a.end - b.end);
}

/**
 * Whether the vault holds the note a reference names. Exact: a heading anchor and a block id are dropped
 * (they are positions inside a note, not other notes), and nothing else is normalised. A typographic hyphen is
 * not the path — that is the whole of the live run's fabricated citation — and a reference that has to be
 * repaired before it resolves has not been made.
 */
export function refExists(vault: Vault, target: string): boolean {
  const clean = (target ?? '').split('#')[0].split('^')[0].trim();
  if (!clean) return false;
  return vault.exists(clean) || vault.exists(`${clean}.md`);
}

/** Every reference in this text the vault does not hold, in the order they were written. */
export function unresolvedRefs(vault: Vault, text: string): string[] {
  return noteRefs(text).filter((r) => !refExists(vault, r.target)).map((r) => r.target);
}

/**
 * The turn with `(no such note)` written in after every reference the vault does not hold.
 *
 * Annotated in place rather than listed at the bottom: the owner reads the sentence that made the claim, and
 * "see Research/speedaudit-discovery/report (no such note)" is the correction exactly where it is needed. A
 * reference that is already annotated is left alone, so re-rendering a transcript cannot stack the marks up.
 */
export function annotateUnresolvedRefs(vault: Vault, text: string): string {
  const refs = noteRefs(text ?? '').filter((r) => !refExists(vault, r.target));
  if (!refs.length) return text ?? '';
  let out = '';
  let at = 0;
  for (const r of refs) {
    out += (text ?? '').slice(at, r.end);
    if (!(text ?? '').slice(r.end, r.end + NO_SUCH_NOTE.length + 1).trimStart().startsWith(NO_SUCH_NOTE)) out += ` ${NO_SUCH_NOTE}`;
    at = r.end;
  }
  return out + (text ?? '').slice(at);
}

/** Whether this text cites at least one note the vault actually holds. */
export function citesExistingNote(vault: Vault, text: string): boolean {
  return noteRefs(text ?? '').some((r) => refExists(vault, r.target));
}

/**
 * Words that start a sentence, or that a board writes in capitals as a machine line, and are never a name.
 * Kept short: the cost of a false name is one sentence marked as opinion, and the cost of a missed one is the
 * `John Doe, former Shopify performance lead` the owner read as fact.
 */
const NOT_A_NAME = new Set([
  'I', 'A', 'An', 'The', 'This', 'That', 'These', 'Those', 'It', 'We', 'You', 'They', 'He', 'She', 'If', 'But',
  'And', 'Or', 'So', 'Then', 'Now', 'No', 'Yes', 'Not', 'At', 'In', 'On', 'For', 'To', 'Of', 'By', 'With',
  'Without', 'From', 'As', 'Is', 'Are', 'Was', 'Were', 'Be', 'Do', 'Does', 'Did', 'Can', 'Cannot', 'Will',
  'Would', 'Should', 'Could', 'May', 'Might', 'Must', 'What', 'Who', 'Why', 'How', 'When', 'Where', 'Which',
  'There', 'Here', 'Their', 'Its', 'Our', 'My', 'Your', 'His', 'Her', 'One', 'Two', 'Three', 'Four', 'Five',
  'FINDING', 'NEXT', 'VERDICT', 'RUBRIC', 'WEDGE', 'QUESTION', 'OWNER', 'STRONG', 'WEAK', 'PIVOT', 'REQUIRED',
  'Round', 'Fix', 'Pivot', 'Verdict', 'Finding', 'Founders', 'Founder', 'Owner', 'Board', 'Chair',
]);

/** A sentence break, for finding the word that opens a sentence — which is capitalised for grammar, not for being a name. */
const SENTENCE_BREAK_RE = /(?:^|[.!?:;\n]\s*|["“(\[]\s*|[-–—*_#>]\s*)([A-Za-z])/g;

/** What is stripped before a turn is read for claims: its own references, inline code, and list markers. */
function claimText(text: string): string {
  return (text ?? '')
    .replace(WIKILINK_RE, ' ')
    .replace(BARE_PATH_RE, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '');
}

/**
 * Whether this text makes the kind of claim that owes a citation: it carries a number, a named person or a
 * named company.
 *
 * **A number is any digit.** Not a threshold, not a unit list: "22% open rate", "1,200 SaaS founders",
 * "5 of 80 leads", "$1.2 M incremental revenue" and "a 35% cut" are one failure written five ways, and every
 * rule narrower than "a digit" let one of them through on the live transcript. The turn's own references and
 * its list numbering come out first, so `[[Research/c-006]]` and `1.` are not claims.
 *
 * **A name is a capitalised word that does not open its sentence** and is not in the short list of words a
 * board writes in capitals anyway. "John Doe, former Shopify performance lead, cut Allbirds' checkout latency"
 * gives Doe, Shopify and Allbirds; "Speed optimization is a vitamin, not a painkiller" gives nothing.
 */
export function hasEvidenceClaim(text: string): boolean {
  const t = claimText(text);
  if (/\d/.test(t)) return true;
  const opensSentence = new Set<number>();
  for (const m of t.matchAll(SENTENCE_BREAK_RE)) opensSentence.add((m.index ?? 0) + m[0].length - 1);
  for (const m of t.matchAll(/[A-Z][A-Za-z0-9&.'’-]*/g)) {
    const at = m.index ?? 0;
    if (opensSentence.has(at)) continue;
    if (NOT_A_NAME.has(m[0])) continue;
    if (m[0].length < 2) continue;
    return true;
  }
  return false;
}

/**
 * Whether this text is opinion: it makes a claim and cites no note the vault holds. The definition ruling W4-1
 * gives, in one predicate, so the prompt's sentence and the code's behaviour say the same thing.
 */
export function isOpinion(vault: Vault, text: string): boolean {
  return hasEvidenceClaim(text) && !citesExistingNote(vault, text);
}

/**
 * A chair's finding as it reaches the owner: suffixed `(the board's opinion)` when it cites no note that
 * exists (ruling W4-1c).
 *
 * The owner read "The pilot data shows only 1-2 paid conversions per 100 contacts" in their inbox as a
 * statement of fact about a pilot the company never ran. It is the board's reading of an argument it had with
 * itself, and four words say so. A question the board put *to* the owner is not a finding and is left alone,
 * and a finding already marked is not marked twice.
 */
export function asBoardOpinion(vault: Vault, finding: string): string {
  const t = (finding ?? '').trim();
  if (!t) return finding ?? '';
  if (t.includes(BOARD_OPINION)) return finding ?? '';
  if (/^QUESTION FOR THE OWNER\b/i.test(t)) return finding ?? '';
  if (citesExistingNote(vault, t)) return finding ?? '';
  return `${t} ${BOARD_OPINION}`;
}
