import { findInboxById, boardStillSitting, BOARD_STILL_SITTING } from './proposals.js';
import { CHOSEN_DECISIONS } from './ideas.js';
import { PRESSURE_TEST_SECTION } from './discovery.js';
import { readPressureVerdict } from './pressure.js';
import type { Vault } from './vault.js';

/** Who a decision made inside CUBICLE is written as. The dispatcher's owner guard reads exactly this name. */
export const OWNER = 'owner';

/**
 * One numbered option on a proposal. `n` is the number as written on the line — not the index — because that
 * is the number `chosen:` is matched against, and a trio that arrived as 1, 3, 4 must not silently renumber
 * here into something the dispatcher would apply differently.
 */
export interface ProposalOption { n: number; label: string; line: string }

/** What the owner is being asked for: `approve`/reject, a numbered `choose`, or `adopt`/send back (the brief). */
export type Decidable = 'approve' | 'choose' | 'adopt';

/**
 * The `## Proposed content` fence. One reader for the whole decide path — the dispatcher's `fenced()` delegates
 * here — so "does this note carry a block to apply" cannot mean one thing to the snapshot and another to the
 * thing that applies it.
 */
export function proposedContentBlock(body: string): string | null {
  const m = body.match(/## Proposed content\s*\n+(`{3,})[a-z]*\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/);
  return m ? m[2] + (m[2].endsWith('\n') ? '' : '\n') : null;
}

/**
 * The numbered lines the dispatcher matches `chosen:` against (`brand_change`'s three company ideas). **One
 * parser**: the snapshot shows the owner a chip per option and the dispatcher applies the line the number
 * names, and two readers with two ideas of what counts as a numbered line is how a chip comes to apply the
 * wrong name.
 */
export function numberedOptions(body: string): ProposalOption[] {
  const out: ProposalOption[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s*(\d+)\.\s(.*)$/.exec(line);
    // `label` is a chip, so it loses its markdown — the same characters the dispatcher strips when it turns the
    // chosen line into a company name, so the chip the owner clicks reads as what the note will end up saying.
    // `line` keeps the bytes, because that is what the dispatcher parses.
    if (m) out.push({ n: Number(m[1]), label: m[2].replace(/[*_`]/g, '').trim(), line });
  }
  return out;
}

/**
 * What this note offers the owner to choose between, or `[]`.
 *
 * Two kinds have options and no others do (spec §1). `brand_change` carries them as numbered lines — but only
 * while it has no `## Proposed content` block, because with one the dispatcher writes the block and never looks
 * at a number. `idea_verdict` has no numbered lines at all: its `chosen: 1|2|3` is the fixed keep/park/scrap
 * table the dispatcher rules by, so the options come from that table rather than from prose.
 */
export function proposalOptions(kind: string, body: string): ProposalOption[] {
  if (kind === 'idea_verdict') {
    return Object.entries(CHOSEN_DECISIONS)
      .map(([n, band]) => ({ n: Number(n), label: band, line: `${n}. ${band}` }))
      .sort((a, b) => a.n - b.n);
  }
  if (kind !== 'brand_change') return [];
  if (proposedContentBlock(body)) return [];
  return numberedOptions(body);
}

/** `founder_brief` → adopt or send back; a note with options → choose; everything else → approve or reject. */
export function decidableFor(kind: string, options: ProposalOption[]): Decidable {
  if (kind === 'founder_brief') return 'adopt';
  return options.length ? 'choose' : 'approve';
}

/**
 * The `## Pressure test` block, so the owner reads the board's argument on the same screen as the button.
 *
 * It stops at the next heading **or at a closing fence**: on a `founder_brief` the section is the last one
 * inside the `## Proposed content` block, and a reader that only knew about headings would hand the owner the
 * backticks and the CEO's closing instructions as part of the board's verdict.
 */
export function pressureBlock(body: string): string {
  const heading = new RegExp(`^${PRESSURE_TEST_SECTION}[ \\t]*$`, 'm').exec(body);
  if (!heading) return '';
  const rest = body.slice(heading.index + heading[0].length);
  const end = rest.search(/\n(?:#{1,6}\s|`{3,})/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/**
 * The board's pressure-test verdict on what a note proposes — `STRONG`, `WEAK`, `PIVOT REQUIRED` — or `''`.
 *
 * Read off the `## Pressure test` block with the one parser the board, the card and the handbook already share,
 * rather than off a frontmatter field: the brief's verdict word lives inside the document the owner is adopting
 * (`briefBoardBlock` prints it in prose above the fence, and the section itself ends on the verdict line), and a
 * second copy in the frontmatter would be a second thing to keep true.
 */
export function noteVerdict(body: string): string {
  const block = pressureBlock(body ?? '');
  if (!block) return '';
  const read = readPressureVerdict(block);
  return read.ok ? read.verdict : '';
}

/**
 * The verdicts an adoption has to be confirmed over (ruling W3-3). `STRONG` is the board saying yes; the other
 * two are it saying this company does not work as written, and adopting anyway is a thing the owner should have
 * to mean.
 */
export const CONFIRM_VERDICTS = ['WEAK', 'PIVOT REQUIRED'] as const;

/**
 * Does adopting this note need `confirm: true`?
 *
 * The third live run's R3-4: the board ruled `PIVOT REQUIRED` on the founder brief, asked the owner five
 * questions nobody answered, and the brief was adopted with one click that looked exactly like adopting a brief
 * the board had passed. It is not a block — the owner rules, the board advises — it is the difference between a
 * click and a decision.
 *
 * Only the founder brief: it is the one document every later plan is written against, and the only kind whose
 * `decidable` is `adopt`. A reader with no verdict on the note needs nothing.
 */
export function needsConfirm(kind: string, body: string): boolean {
  return kind === 'founder_brief' && (CONFIRM_VERDICTS as readonly string[]).includes(noteVerdict(body));
}

/** Why the vault would not adopt it without `confirm`. Names the verdict, because that is what is being overruled. */
export function confirmMessage(verdict: string): string {
  return `the board ruled ${verdict} on this founder brief: adopting it anyway is a decision, so send \`confirm: true\` with it (the office button reads "Adopt anyway")`;
}

/**
 * The dispatcher's `_Resolved …_` footer, in the owner's words rather than the file's: what actually happened
 * when the approval was applied. The **last** footer wins — a note can carry a refusal and then a resolution —
 * and the stamp is skipped as one unbroken token, because an ISO timestamp is full of colons.
 */
export function resolvedOutcome(body: string): string {
  const marker = '\n---\n_Resolved ';
  const i = body.lastIndexOf(marker);
  if (i < 0) return '';
  const m = /^_Resolved \S+:\s*([\s\S]*)_$/.exec(body.slice(i + '\n---\n'.length).trimEnd());
  return m ? m[1].trim() : '';
}

/** A decision the owner made inside CUBICLE: the note's last recorded write is under the owner's own name. */
export function decidedByOwner(vault: Vault, rel: string): boolean {
  return vault.writtenBy(rel) === OWNER;
}

export interface OwnerDecision {
  approved: boolean;
  /** The option's `n`, for a note that has options. `null`/absent takes the recommendation. */
  chosen?: number | null;
  /** What the owner typed. Appended as a trailing paragraph — the shape the rejection path already reads. */
  comment?: string;
  /**
   * "Yes, over the board's verdict" (ruling W3-3). Required to adopt a founder brief the board ruled `WEAK` or
   * `PIVOT REQUIRED` on, and meaningless everywhere else. Not stored on the note: what it guards is the click,
   * and once the flag is set the adoption is the owner's like any other.
   */
  confirm?: boolean;
}

export interface OwnerDecided { id: string; path: string; kind: string; approved: boolean; chosen: number | null; comment: string }

/** A decision the vault will not take: no such note, already closed, or a `chosen` that names nothing. */
export class OwnerDecideError extends Error {
  constructor(message: string) { super(message); this.name = 'OwnerDecideError'; }
}

/** How much of one comment is kept. A sentence or two is the ask; a novel is a note the owner should write. */
export const OWNER_COMMENT_MAX = 4000;

/*
 * Ruling R-T3-3: a founder brief whose board session has not finished is not the owner's to adopt yet — the
 * pressure test is half of what they would be deciding on, and §4 is that the brief takes it once. The predicate
 * and the message are core's own (`boardStillSitting`, `BOARD_STILL_SITTING`), shared with the dispatcher and
 * the snapshot so the three surfaces cannot drift.
 */

/**
 * Decide a proposal from inside CUBICLE, exactly as an Obsidian edit would.
 *
 * Ruling P8-1: the note is written **as the owner** (`by: 'owner'`), and the dispatcher's owner guard has one
 * explicit path for that name. It cannot instead be written as the daemon and left to `isOwnerChanged`: that
 * guard compares the file against the last system write, so a system write is precisely what it reads as "not
 * the owner" — the approval would be refused with `guardrail.blocked` on the owner's own click.
 *
 * The comment is a trailing owner paragraph and nothing else, because that is the shape `splitRejectedBrief`
 * already reads back. A second `comment:` field in the frontmatter would be a second place to say the same
 * thing that the rejection path would never look at.
 */
export function ownerDecide(vault: Vault, id: string, d: OwnerDecision): OwnerDecided {
  const note = findInboxById(vault, id);
  if (!note) throw new OwnerDecideError(`no proposal ${id} in the inbox`);
  const kind = note.data.kind;
  if (kind === 'message') throw new OwnerDecideError(`${id} is a message, not a decision`);
  if (note.data.resolved_at) throw new OwnerDecideError(`${id} was already decided (resolved ${note.data.resolved_at})`);
  if (boardStillSitting({ kind, ...(note.data as Record<string, unknown>) })) throw new OwnerDecideError(BOARD_STILL_SITTING);
  // Ruling W3-3, and only on the way *in*: adopting a brief the board would not stand behind takes a second,
  // deliberate word. Sending it back needs no confirmation — agreeing with the board is not overruling it — and
  // an approval set in Obsidian is applied as it always was, because Obsidian is the owner's own hand and there
  // is no button there to relabel.
  if (d.approved && needsConfirm(kind, note.body) && !d.confirm) throw new OwnerDecideError(confirmMessage(noteVerdict(note.body)));
  const options = proposalOptions(kind, note.body);
  const chosen = d.chosen === undefined || d.chosen === null ? null : Number(d.chosen);
  if (chosen !== null) {
    if (!Number.isInteger(chosen)) throw new OwnerDecideError(`chosen must be a whole number (got ${JSON.stringify(d.chosen)})`);
    if (!options.length) throw new OwnerDecideError(`a ${kind} has nothing to choose between`);
    if (!options.some((o) => o.n === chosen)) throw new OwnerDecideError(`chosen: ${chosen} matches no option; pick one of ${options.map((o) => o.n).join(', ')}`);
  }
  const comment = String(d.comment ?? '').replace(/\r/g, '').trim().slice(0, OWNER_COMMENT_MAX);
  // `updateNote`, not a fresh `stringifyNote` of the listing's frontmatter: the listing fills in defaults for a
  // note the owner typed by hand (`to`, `id`, `created`), and writing those back would put the daemon's idea of
  // the note into a file the owner owns. This changes the flags that were decided and nothing else.
  vault.updateNote(note.path, (n) => ({
    data: { ...n.data, approved: d.approved, chosen, approved_by: OWNER },
    body: comment ? `${n.body.trimEnd()}\n\n${comment}\n` : n.body,
  }), OWNER, { job: note.data.job ?? null });
  return { id, path: note.path, kind, approved: d.approved, chosen, comment };
}
