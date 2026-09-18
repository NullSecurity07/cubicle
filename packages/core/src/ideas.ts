import { z } from 'zod';
import type { Vault } from './vault.js';
import { Timestamp } from './schemas.js';
import { stringifyNote } from './frontmatter.js';
import { setSection } from './jobs.js';
import { nowIso } from './fs.js';
import { renderRubric, BoardRubric, chairAnswerText, PRESSURE_CHAIR_SECTION } from './pressure.js';
import { ownerPick, OWNER_PICK_LABEL, hasFounderBrief, FOUNDER_BRIEF } from './discovery.js';

/**
 * The idea dossier: something the company *could* do, with everything anyone needs to rule on it in one note.
 *
 * SP7 shipped the minimal card (id/title/source/status/created/evidence) so continuous intelligence had
 * somewhere to put a meaningful change. This module is the dossier that card grows into: a score with its four
 * inputs, the research behind it, the finance office's estimate, the board's verdict, and the one decision the
 * whole thing exists to produce — keep, park or scrap. Every added field has a default, so a card written by an
 * intelligence sweep before any of this existed still parses.
 */

export const IDEAS_DIR = 'Ideas';
export function ideaPath(slug: string): string { return `${IDEAS_DIR}/${slug}.md`; }

/**
 * Idea slugs are filenames and wikilink targets; keep them boring. Mirrors `STREAM_SLUG_RE`. Exported as a
 * pattern source (rather than only a compiled RegExp) so other modules can build their own regex — with their
 * own flags, or embedded in a larger pattern — from the same rule instead of duplicating it.
 */
export const IDEA_SLUG_SRC = '[a-z0-9][a-z0-9-]{0,47}';
export const IDEA_SLUG_RE = new RegExp(`^${IDEA_SLUG_SRC}$`);
export function isValidIdeaSlug(slug: string): boolean { return IDEA_SLUG_RE.test(slug); }

export function ideaSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'idea';
}

/**
 * Where an idea came from. `intelligence` carries its sweep kind after a colon (`intelligence:competitive`);
 * `discovery` is the owner's own material, `pantry` is the idle-hours chat (SP5 writes those), `owner` is a
 * card the owner typed. Anything else is read as the job id that filed it — an idea with no provenance cannot
 * be checked, which is why `source` has no default.
 *
 * `BOARD_IDEA_SOURCE` is deliberately **not** in here: `source` is a free string, and a pivot card is filed by
 * a board session rather than by one of the four things this enum names.
 */
export const IDEA_SOURCES = ['discovery', 'intelligence', 'pantry', 'owner'] as const;
export type IdeaSource = (typeof IDEA_SOURCES)[number];

export function ideaSourceKind(source: string): IdeaSource | 'job' | 'unknown' {
  const head = source.split(':')[0].trim().toLowerCase();
  if ((IDEA_SOURCES as readonly string[]).includes(head)) return head as IdeaSource;
  return /^job_/.test(source.trim()) ? 'job' : 'unknown';
}

/** What the company decided to do about an idea. `undecided` is where every card starts. */
export const IDEA_DECISIONS = ['undecided', 'keep', 'park', 'scrap'] as const;
export const IdeaDecision = z.enum(IDEA_DECISIONS);
export type IdeaDecision = z.infer<typeof IdeaDecision>;
export type IdeaBand = Exclude<IdeaDecision, 'undecided'>;

const oneToFive = z.number().int().min(1).max(5);

/**
 * The four numbers the score is made of. Two are the research office's (it read the owner's material and the
 * market), two are the finance office's (it priced the thing) — so no single agent can talk an idea up on its
 * own, and a missing half is visible as a missing number rather than as a confident guess.
 *
 * `effort` is inverted on purpose (5 = cheapest): every input reads "higher is better", so the arithmetic needs
 * no sign rules and a reader can check the total in their head.
 */
export const IdeaScoreInputs = z.object({
  value: oneToFive,
  evidence: oneToFive,
  effort: oneToFive,
  fit: oneToFive,
});
export type IdeaScoreInputs = z.infer<typeof IdeaScoreInputs>;

export const IDEA_SCORE_WEIGHTS: Record<keyof IdeaScoreInputs, number> = { value: 4, evidence: 3, effort: 3, fit: 2 };

/** One line per input, shown in the refusal and in the card's `## Score` section. */
export const IDEA_SCORE_HELP: Record<keyof IdeaScoreInputs, string> = {
  value: '1–5: what this is worth to the company if it works (the finance office answers)',
  evidence: '1–5: how well the research supports the demand — 5 is customers already paying someone for it (the research office answers)',
  effort: '1–5: how cheap it is to try, inverted so higher is better — 5 is a week, 1 is a quarter (the finance office answers)',
  fit: '1–5: how much it uses what this company already has (the research office answers)',
};

/** Who owns each input, so a card can say what it is still waiting for and from whom. */
export const IDEA_SCORE_OWNER: Record<keyof IdeaScoreInputs, 'research' | 'finance'> = {
  value: 'finance', evidence: 'research', effort: 'finance', fit: 'research',
};

/**
 * What a card is still waiting for, and from whom — the `## Score` section of an unscored card, and the tail of
 * `idea.card`'s reply. "Still waiting on value, effort" leaves the reader to work out whose desk that is; the
 * office is the only part of the answer anyone can act on.
 */
export function missingScoreNote(missing: (keyof IdeaScoreInputs)[]): string {
  if (!missing.length) return '';
  const byOffice = new Map<'research' | 'finance', string[]>();
  for (const k of missing) byOffice.set(IDEA_SCORE_OWNER[k], [...(byOffice.get(IDEA_SCORE_OWNER[k]) ?? []), k]);
  return [...byOffice].map(([office, keys]) => `${keys.join(' and ')} from the ${office} office`).join(', ');
}

export const IDEA_SCORE_MIN = 12;
export const IDEA_SCORE_MAX = 60;
/** At or above this the recommendation is `keep`; at or above `PARK_AT` it is `park`; below it is `scrap`. */
export const KEEP_AT = 44;
export const PARK_AT = 26;

/**
 * `4 × value + 3 × evidence + 3 × effort + 2 × fit`, so 12 (every input at its worst) to 60 (every input at its
 * best). Weighted, not averaged: what it is worth counts double what it fits, and an idea can be cheap and
 * familiar without that outvoting the question of whether anyone wants it.
 */
export function ideaScore(i: IdeaScoreInputs): number {
  return (Object.keys(IDEA_SCORE_WEIGHTS) as (keyof IdeaScoreInputs)[]).reduce((sum, k) => sum + IDEA_SCORE_WEIGHTS[k] * i[k], 0);
}

/** Which inputs are absent or out of range, in weight order. Empty means the card can be scored. */
export function missingScoreInputs(input: unknown): (keyof IdeaScoreInputs)[] {
  const parsed = IdeaScoreInputs.safeParse(input ?? {});
  if (parsed.success) return [];
  const bad = new Set(parsed.error.issues.map((iss) => String(iss.path[0] ?? '')));
  return (Object.keys(IDEA_SCORE_WEIGHTS) as (keyof IdeaScoreInputs)[]).filter((k) => bad.has(k));
}

/**
 * The recommendation the score carries, before the owner rules on it.
 *
 * Two rules sit on top of the arithmetic. An idea nobody would pay much for (`value` 1 or 2) is parked however
 * cheap and familiar it is — cheapness is not a reason to build something. And an idea the board returned is
 * parked rather than kept: the board found a failure mode the dossier does not answer, and "not yet" is the
 * honest reading of that. Neither rule can push a card *down* to `scrap`; only the arithmetic does that, because
 * scrapping is the one decision that throws work away.
 */
export function ideaBand(score: number, opts: { value: number; board?: 'pass' | 'return' | null }): IdeaBand {
  let band: IdeaBand = score >= KEEP_AT ? 'keep' : score >= PARK_AT ? 'park' : 'scrap';
  if (band === 'keep' && opts.value <= 2) band = 'park';
  if (band === 'keep' && opts.board === 'return') band = 'park';
  return band;
}

/** Why the band came out the way it did, in one sentence a reader can check against the numbers. */
export function bandReason(score: number, opts: { value: number; board?: 'pass' | 'return' | null }): string {
  const band = ideaBand(score, opts);
  const arithmetic = score >= KEEP_AT ? 'keep' : score >= PARK_AT ? 'park' : 'scrap';
  if (band === arithmetic) return `${score}/${IDEA_SCORE_MAX} → ${band} (keep at ${KEEP_AT}, park at ${PARK_AT}).`;
  if (opts.value <= 2) return `${score}/${IDEA_SCORE_MAX} would keep, but value is ${opts.value}: nobody would pay enough for this, so it parks.`;
  return `${score}/${IDEA_SCORE_MAX} would keep, but the board returned it, so it parks until its findings are answered.`;
}

/** How the owner overrules a recommendation on an `idea_verdict` note: `chosen: 1 | 2 | 3`. */
export const CHOSEN_DECISIONS: Record<number, IdeaBand> = { 1: 'keep', 2: 'park', 3: 'scrap' };

/**
 * What the owner's flags mean for an idea. `approved: true` adopts the recommendation, `chosen:` overrules it,
 * and `approved: false` **parks** the idea rather than scrapping it: "no" from an owner usually means "not
 * this, not now", and scrapping would throw away the research behind the card. A `chosen:` the table does not
 * know falls back to the recommendation rather than failing the whole verdict.
 */
export function ideaOutcome(opts: { approved: boolean | null; chosen: number | null; band: IdeaBand }): IdeaBand | 'pending' {
  if (opts.approved === false) return 'park';
  if (opts.approved !== true) return 'pending';
  return (opts.chosen !== null ? CHOSEN_DECISIONS[opts.chosen] : undefined) ?? opts.band;
}

export const IDEA_SECTIONS = ['## What changed', '## Why it might matter', '## Evidence', '## Research', '## What it would cost', '## The board', '## Score', '## Decision'] as const;

/** The `## Score` section: the four numbers, the arithmetic spelled out, and the band it lands in. */
export function renderScoreSection(i: IdeaScoreInputs, opts: { board?: 'pass' | 'return' | null } = {}): string {
  const score = ideaScore(i);
  const terms = (Object.keys(IDEA_SCORE_WEIGHTS) as (keyof IdeaScoreInputs)[]).map((k) => `${IDEA_SCORE_WEIGHTS[k]} × ${i[k]} ${k}`);
  return [
    ...(Object.keys(IDEA_SCORE_WEIGHTS) as (keyof IdeaScoreInputs)[]).map((k) => `- **${k}:** ${i[k]}/5 — ${IDEA_SCORE_HELP[k]}`),
    '',
    `**Score:** ${terms.join(' + ')} = **${score}** of ${IDEA_SCORE_MAX}.`,
    '',
    `**Recommendation:** ${ideaBand(score, { value: i.value, board: opts.board ?? null })}. ${bandReason(score, { value: i.value, board: opts.board ?? null })}`,
  ].join('\n');
}

/**
 * Every `Ideas/<slug>` a plan names, by wikilink (`[[Ideas/foo]]`) or by bare path (`Ideas/foo.md`). Titles are
 * deliberately not matched: a title is prose, and a plan that happens to use the same words as a scrapped idea
 * must not be returned for it.
 *
 * The left boundary matters as much as the slug pattern does: without it `MyIdeas/foo` or `BadIdeas/foo` reads
 * as `Ideas/foo` and a plan gets returned for an idea it never named. `/` is excluded too — ideas live at the
 * top of the vault, so `Archive/Ideas/foo` and `Docs/Ideas/foo.md` are some other folder's business. `[`, `(`,
 * a space and a line start are all boundaries; a letter, digit, `_`, `-` or `/` is not.
 */
export function ideasNamedIn(plan: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(`(?<![A-Za-z0-9_/-])Ideas/(${IDEA_SLUG_SRC})(?:\\.md)?`, 'gi');
  for (const m of plan.matchAll(re)) out.add(m[1].toLowerCase());
  return [...out];
}

/** The ideas a plan names that the company has not kept — what the board returns a plan for (spec §4). */
export function unkeptIdeasNamedIn<T extends { id: string; decision: IdeaDecision }>(plan: string, ideas: T[]): T[] {
  const named = new Set(ideasNamedIn(plan));
  return ideas.filter((i) => named.has(i.id.toLowerCase()) && i.decision !== 'keep');
}

/**
 * The card. `status` is SP7's lifecycle flag and stays exactly as it was; `decision` is the new one, because a
 * card can be `triaged` and still undecided, and the two answer different questions ("has anyone looked at
 * this?" and "are we doing it?").
 */
export const IdeaFrontmatter = z.looseObject({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  status: z.enum(['new', 'triaged', 'accepted', 'rejected']).default('new'),
  created: Timestamp,
  evidence: z.array(z.string()).default([]),
  decision: IdeaDecision.default('undecided'),
  decided_by: z.string().default(''),
  decided_at: z.string().default(''),
  /** null until both offices have filled their inputs; `ideaScore` of `score_inputs` once they have. */
  score: z.number().nullable().default(null),
  score_inputs: IdeaScoreInputs.partial().default({}),
  /** `Research/<slug>/report.md` — the investigation behind the demand claim. */
  research: z.string().default(''),
  research_confidence: z.enum(['high', 'medium', 'low']).nullable().default(null),
  /** The finance office's rough order of magnitude, in words, never a ledger entry (money is SP4). */
  estimate: z.string().default(''),
  /** `Decisions/board-<idea>.md` — the board session that judged it. */
  board_verdict: z.enum(['pass', 'return']).nullable().default(null),
  board_decision: z.string().default(''),
  /**
   * SP5b. The board's pressure-test verdict word (`STRONG` | `WEAK` | `PIVOT REQUIRED`) and its 0–2 × 5
   * rubric. Both optional with defaults, so a card written before the pressure test existed still parses;
   * both re-read by `fileIdeaVerdict` when a kill strands a verdict note, which is why they live on the card
   * rather than in a session variable. Advisory only: `score`, `score_inputs` and `ideaBand` are untouched.
   */
  board_pressure: z.string().default(''),
  board_rubric: BoardRubric.nullable().default(null),
  /**
   * SP8 §3. `Meetings/<stamp>-board-<slug>.md` — the transcript of the session that judged it, and the
   * questions that session could not answer from the material. Both live on the card for the same reason the
   * rubric does: `fileIdeaVerdict` rebuilds the owner's note from the card after a kill, so the link the owner
   * follows to read the argument has to come from the card and not from a session variable. Empty on a card
   * judged by the `brief` board, which holds no dialogue and files no transcript.
   */
  board_transcript: z.string().default(''),
  board_questions: z.array(z.string()).default([]),
});
export type IdeaFrontmatter = z.infer<typeof IdeaFrontmatter>;

/** `_template.md` is the owner's copy-me note, not an idea. */
function isIdeaNote(rel: string): boolean {
  return !rel.slice(rel.lastIndexOf('/') + 1).startsWith('_');
}

export function readIdea(vault: Vault, slug: string): { data: IdeaFrontmatter; body: string } | null {
  if (!isValidIdeaSlug(slug)) return null;
  const n = vault.readNoteOrNull(ideaPath(slug));
  if (!n) return null;
  const p = IdeaFrontmatter.safeParse({ ...n.data, id: slug });
  return p.success ? { data: p.data, body: n.body } : null;
}

export function listIdeas(vault: Vault): IdeaFrontmatter[] {
  const out: IdeaFrontmatter[] = [];
  for (const rel of vault.list(IDEAS_DIR, { ext: '.md' })) {
    if (!isIdeaNote(rel)) continue;
    const n = vault.readNoteOrNull(rel);
    if (!n) continue;
    const slug = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const p = IdeaFrontmatter.safeParse({ ...n.data, id: slug });
    if (p.success) out.push(p.data);
  }
  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.id.localeCompare(b.id));
}

/** The only ideas a plan may draw on (spec §4). */
export function keptIdeas(vault: Vault): IdeaFrontmatter[] {
  return listIdeas(vault).filter((i) => i.decision === 'keep');
}

/**
 * The sources whose cards the owner has necessarily seen: their own material (`discovery`), a card they typed
 * (`owner`), the idle-hours chat they read (`pantry`), and the pivot a board session proposed to them
 * (`board`, ruling W3-2). Compared on the head segment, so `intelligence:competitive` is read as
 * `intelligence` — and nothing else in the enum has one.
 *
 * `board` is deliberately matched here by name rather than added to `IDEA_SOURCES`: `source` is a free string
 * (an unrecognised value is read as the job that filed it), so this list can say what the owner has seen
 * without the schema having to grow a value first.
 */
export const OWNER_SEEN_IDEA_SOURCES = ['discovery', 'owner', 'pantry', 'board'] as const;

/** True for a card nobody asked for: a sweep noticed it and filed it (`source: intelligence:*`). */
function sweepSourced(source: string): boolean {
  return !(OWNER_SEEN_IDEA_SOURCES as readonly string[]).includes(source.split(':')[0].trim().toLowerCase());
}

/**
 * Whether the owner has laid eyes on this idea (ruling W3-5): it came from their own material, their own
 * typing, the pantry, or a board pivot they were asked about — or they promoted a sweep card by marking it
 * `keep`.
 */
export function ownerHasSeenIdea(idea: { source: string; decision: string }): boolean {
  return !sweepSourced(idea.source) || idea.decision === 'keep';
}

/**
 * Whether the company may spend the board's time — and the two offices' scoring calls — on this card.
 *
 * Ruling W3-5, out of the third live run: an intelligence sweep filed *Persistent Agent Memory Integration*, it
 * was scored, it reached the board, sixteen model calls were spent arguing it and the owner was asked about
 * engineering hours for something nobody had ever mentioned to them. A card the owner has never seen is not a
 * candidate; it is a note. So an **undecided** card is a candidate only when it came from somewhere the owner
 * has seen, and a **sweep** card becomes one only once they mark it `decision: keep` — which on such a card
 * reads "have the board look at this", not "we are doing it", and is why a promoted card stays a candidate
 * until the board has actually sat on it (`board_verdict`, checked by the callers that have it).
 */
export function ideaOpenToBoard(idea: { source: string; decision: string }): boolean {
  return idea.decision === 'undecided' ? !sweepSourced(idea.source) : idea.decision === 'keep' && sweepSourced(idea.source);
}

/**
 * The highest-scoring idea the board has not sat on yet: scored (both offices have answered), no verdict, and
 * open to the board at all (`ideaOpenToBoard` — the owner has seen it). One per cycle is what the board session
 * costs — up to seventeen model calls — so the cycle spends them on the best candidate rather than the oldest.
 */
export function nextIdeaForBoard(vault: Vault): IdeaFrontmatter | null {
  return listIdeas(vault).find((i) => i.score !== null && i.board_verdict === null && ideaOpenToBoard(i)) ?? null;
}

/**
 * The cards nobody asked for and the owner has not promoted — what the brief lists under "Ideas the sweep
 * found" so they are visible without being expensive. A card the owner has already parked or scrapped is
 * finished business and is not listed again.
 *
 * "The sweep" is the common case and the heading's word, but the rule is provenance, not the sweep: a card some
 * *other* job filed on its own initiative carries that job's id as its `source`, which `OWNER_SEEN_IDEA_SOURCES`
 * does not name — so it is equally unrequested, and belongs on the same list for the same reason.
 */
export function sweepIdeas(vault: Vault): IdeaFrontmatter[] {
  return listIdeas(vault).filter((i) => i.decision === 'undecided' && !ownerHasSeenIdea(i));
}

/**
 * The first real line of a card's `## Why it might matter` — the one line the brief has room for. The
 * placeholder a fresh card carries (`_Not stated._`) is italics-only and is not a reason, so it is dropped
 * rather than quoted as one.
 */
export function ideaWhyLine(body: string): string {
  const section = (body.split(/^## Why it might matter[ \t]*$/m)[1] ?? '').split(/^## /m)[0];
  const line = section.split('\n').map((l) => l.trim()).find((l) => l && !/^_.*_$/.test(l)) ?? '';
  return line.replace(/^[-*+]\s+/, '').slice(0, 200);
}

/** The heading the brief lists unpromoted sweep cards under (ruling W3-5). */
export const SWEEP_IDEAS_SECTION = '## Ideas the sweep found';

/** How the owner promotes one, with `<slug>` still to be filled in. One sentence, said the same way everywhere. */
export const IDEA_PROMOTE_HINT = 'to have the board look at it, set `decision: keep` on Ideas/<slug>.md or say so to the CEO';

/** Title, one-line why, and the promote instruction, for each sweep card the brief lists. */
export function sweepIdeaRows(vault: Vault): { id: string; title: string; why: string }[] {
  return sweepIdeas(vault).map((i) => ({ id: i.id, title: i.title, why: ideaWhyLine(readIdea(vault, i.id)?.body ?? '') }));
}

/** The brief's `## Ideas the sweep found` section: what it noticed, and what to do if the owner wants it judged. */
export function renderSweepIdeasSection(rows: { id: string; title: string; why: string }[]): string {
  return [
    'Nobody asked for these: the company noticed them while it was doing something else, and the board does not sit on one until you say so.',
    '',
    ...rows.map((r) => `- **${r.title}** — ${r.why || 'the card gives no reason yet'} ([[${ideaPath(r.id).replace(/\.md$/, '')}]]) — ${IDEA_PROMOTE_HINT.replace('<slug>', r.id)}`),
  ].join('\n');
}

export interface NewIdea {
  slug?: string;
  title: string;
  source: string;
  evidence?: string[];
  what_changed?: string;
  why_it_matters?: string;
  /**
   * The clock the filer is working to, as an ISO stamp. Defaults to now. A rule that reads `created` back —
   * the pantry's one card a day — must see the same clock it decided by, or it agrees with itself only until
   * the real date rolls over underneath a caller that was given a different one.
   */
  created?: string;
}

/**
 * Two titles that name the same idea. Compared on the same terms `ideaSlug` uses — case, punctuation and runs
 * of whitespace all collapse — because a trailing full stop is not a second idea: "Meal kits for nurseries" and
 * "Meal kits for nurseries." slugify identically, and comparing the raw strings gave them two dossiers, each
 * scored, judged and decided on its own.
 */
export function sameIdeaTitle(a: string, b: string): boolean {
  const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return norm(a) === norm(b);
}

/** The `## Evidence` body of a card, from whatever evidence it now carries. */
export function renderEvidenceSection(evidence: string[]): string {
  return evidence.length ? evidence.map((e) => `- ${e}`).join('\n') : '_None yet. An idea with no evidence is a hunch; say so rather than dressing it up._';
}

/**
 * Create `Ideas/<slug>.md` with the eight sections every dossier carries, or return the slug of the card that
 * already covers it. Written through one function rather than by each agent with `vault.write`, for the reason
 * `writeDecision` exists: a note whose shape the daemon reads is not something to leave to a prompt.
 */
export function writeIdeaCard(vault: Vault, idea: NewIdea, by: string): string {
  let slug = idea.slug ? ideaSlug(idea.slug) : ideaSlug(idea.title);
  if (vault.exists(ideaPath(slug))) {
    const existing = readIdea(vault, slug);
    if (existing && sameIdeaTitle(existing.data.title, idea.title)) return slug;
    const base = slug.slice(0, 44).replace(/-+$/, '') || 'idea';
    let n = 2;
    while (vault.exists(ideaPath(`${base}-${n}`))) n++;
    slug = `${base}-${n}`;
  }
  const data = IdeaFrontmatter.parse({ id: slug, title: idea.title, source: idea.source, created: idea.created ?? nowIso(), evidence: idea.evidence ?? [] });
  const body = [
    `# ${idea.title}`, '',
    '## What changed', '', (idea.what_changed ?? '').trim() || '_Not stated._', '',
    '## Why it might matter', '', (idea.why_it_matters ?? '').trim() || '_Not stated._', '',
    '## Evidence', '', renderEvidenceSection(idea.evidence ?? []), '',
    '## Research', '', '_Waiting on the research office._', '',
    '## What it would cost', '', '_Waiting on the finance office._', '',
    '## The board', '', '_The board has not sat on this yet._', '',
    '## Score', '', `_Not scored: still waiting on ${missingScoreNote(Object.keys(IDEA_SCORE_WEIGHTS) as (keyof IdeaScoreInputs)[])}._`, '',
    '## Decision', '', '_Undecided._', '',
  ].join('\n');
  vault.writeText(ideaPath(slug), stringifyNote(data as Record<string, unknown>, body), by);
  return slug;
}

/**
 * What a pivot card records as its provenance — one constant, because nothing else may spell it. Deliberately
 * not a member of `IDEA_SOURCES` (see there); `OWNER_SEEN_IDEA_SOURCES` matches it by name, so a pivot the owner
 * was shown reaches the board like a card they typed.
 */
export const BOARD_IDEA_SOURCE = 'board';

/** How much of one pivot becomes a card title. Long enough to read as an idea, short enough to be a filename. */
export const PIVOT_TITLE_CHARS = 70;

/** The line the chair is asked to write on a pivot, so the card's title is the chair's own naming of it. */
export const PIVOT_TITLE_LABEL = 'PIVOT TITLE:';
const PIVOT_TITLE_LINE_RE = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]*)?(?:[-*+][ \t]+)?[*_`]*[ \t]*pivot[ \t]+title[*_`]*[ \t]*[:\-–—][ \t]*(.+)$/im;

/**
 * Verbs a board writes a chore with. A title that opens on one of these is an action item, not an opening: the
 * owner was asked "Keep, park or scrap: Secure at least one anchor customer who has documented a ≥$500 monthly
 * bill spike", which is a task somebody could be given and not a business anybody could rule on.
 */
const PIVOT_VERB_RE = /^(?:secure|build|ship|launch|create|develop|define|target|focus|pivot|shift|move|switch|transition|acquire|find|get|win|sell|offer|deliver|validate|test|explore|pursue|establish|position|reposition|start|stop|add|remove|automate|implement|improve|increase|reduce|expand|narrow|refocus|prioritis|prioriz|convert|onboard|reach|attack|serve)\w*\s+/i;

/** The little words a clause may open on once its verb is gone: "at least one anchor customer" → the customer. */
const PIVOT_LEAD_RE = /^(?:at\s+least\s+|at\s+most\s+)?(?:a|an|the|one|to|for|towards?|on|into|onto|our|its|their)\s+/i;

/** How a wedge separates who it is for from what they are sold: "<customer>, targeted via <product>". */
const WEDGE_SPLIT_RE = /,?\s+(?:targeted\s+via|targeted\s+with|reached\s+via|reached\s+through|served\s+(?:by|with)|sold\s+(?:via|through)|via|using|through|with)\s+/i;

/** How a fix names its customer: "<product> for <customer>", "<product> to <customer>". */
const PIVOT_FOR_RE = /^([\s\S]{4,120}?)\s+(?:for|to|aimed\s+at|targeting)\s+([\s\S]{4,160})$/i;

/**
 * A machine label a clause may still carry when it is read straight off the chair's answer rather than through
 * `pressurePivot`. Stripped here so both routes give the same title.
 */
const PIVOT_LABEL_RE = /^(?:wedge|pivot\s+title|verdict|finding)[ \t]*[:\-–—][ \t]*/i;

/** One clause, trimmed of its label, leading verb and article, with its first letter left as the author wrote it. */
function nounPhrase(clause: string): string {
  return clause.replace(/\s+/g, ' ').trim()
    .replace(PIVOT_LABEL_RE, '')
    .replace(/^[-–—:,*_`]+\s*/, '')
    .replace(PIVOT_VERB_RE, '')
    .replace(PIVOT_LEAD_RE, '')
    .replace(/[.,;:*_`]+$/, '')
    .trim();
}

/** A title cut to a filename's worth of words, with its first letter raised. */
function asTitle(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const cut = one.length > PIVOT_TITLE_CHARS ? `${one.slice(0, PIVOT_TITLE_CHARS).replace(/\s+\S*$/, '')}…` : one;
  return cut.replace(/^./, (c) => c.toUpperCase());
}

/**
 * A title for the pivot the chair proposed: **a product and a customer**, never a verb phrase (ruling W4-7).
 *
 * The second dry-run filed two good cards under two bad names — `Ideas/secure-at-least-one-anchor-customer-who-has-docu.md`
 * and `Ideas/automated-stripe-webhook-replay-protection.md` — and then asked the owner "Keep, park or scrap:
 * Secure at least one anchor customer who has documented a ≥$500 monthly bill spike". Filing the card was
 * right; the title was a chore off a to-do list, and an opening is what the owner is being asked to rule on.
 *
 * Three readings, in order. The chair's own `PIVOT TITLE:` line wins, because it is the one asked for and the
 * chair is the only party that knows what it meant. Otherwise the clause is split into who it is for and what
 * they are sold — a wedge writes the customer first ("…founders whose checkout exceeds 4 seconds, targeted via
 * a 60-second Loom audit"), a fix writes the product first ("a remediation retainer for teams with a bill
 * spike") — and comes back as "<product> for <customer>". Failing that, the leading verb comes off so what is
 * left is at least a thing and not an instruction.
 */
export function pivotTitle(pivot: string, subject: string): string {
  const said = (pivot ?? '').replace(/\r/g, '');
  const asked = said.match(PIVOT_TITLE_LINE_RE)?.[1]?.trim();
  if (asked && nounPhrase(asked).length >= 8) return asTitle(nounPhrase(asked));

  const to = said.match(/\bpivot(?:ing|ed)?\s+(?:away\s+)?(?:from\s+[\s\S]{1,160}?\s+)?to\s+([^.;\n]{4,160})/i)?.[1];
  const clause = (to ?? said.split(/[.;\n]/).map((l) => l.trim()).find((l) => l.length > 8) ?? '').trim();
  if (!clause) return `Board pivot on ${subject}`;

  // A wedge: the customer is named first and the thing they are sold comes after the connector.
  const wedge = clause.split(WEDGE_SPLIT_RE);
  if (wedge.length > 1) {
    const customer = nounPhrase(wedge[0]);
    const product = nounPhrase(wedge.slice(1).join(' '));
    if (customer.length >= 4 && product.length >= 4) return asTitle(`${product} for ${customer}`);
  }
  // A fix: the product is named first, its customer after "for".
  const phrase = nounPhrase(clause);
  const split = phrase.match(PIVOT_FOR_RE);
  if (split) return asTitle(`${split[1].trim()} for ${split[2].trim()}`);
  return phrase.length >= 8 ? asTitle(phrase) : `Board pivot on ${subject}`;
}

/**
 * File the chair's proposed pivot as a candidate idea card (ruling W3-2), or return `null` when there is nothing
 * to file and the slug of the card that already covers it when there is.
 *
 * This is what the company does with "PIVOT REQUIRED" instead of acting on it: the pivot becomes a card like any
 * other, sourced `board`, with the transcript as its evidence, and it waits for the owner to keep it. The plan
 * goes on serving the ideas the owner already kept until then.
 *
 * **Idempotent on the transcript path**, not on the title: one session proposes one pivot, and the chair's words
 * for it change between two readings of the same meeting (a resumed cycle, a re-filed verdict). The transcript
 * is the one thing that identifies the session, so a card already carrying it as evidence *is* this pivot.
 */
export function fileBoardPivot(
  vault: Vault,
  o: { pivot: string; subject: string; transcript: string; by: string; created?: string },
): string | null {
  const pivot = (o.pivot ?? '').replace(/\s+/g, ' ').trim();
  if (!pivot || !o.transcript) return null;
  const already = listIdeas(vault).find((c) => c.source === BOARD_IDEA_SOURCE && c.evidence.includes(o.transcript));
  if (already) return already.id;
  return writeIdeaCard(vault, {
    title: pivotTitle(pivot, o.subject),
    source: BOARD_IDEA_SOURCE,
    evidence: [o.transcript],
    created: o.created,
    // Ruling W4-7: the chair's own sentence is the first line of the card, above the explanation of what a
    // pivot card is — the owner reads what the board is proposing before they read why they are being asked.
    what_changed: `${pivot}\n\nThe board pressure-tested ${o.subject} and proposed this rather than the business as it stands. Nothing is planned against it until you keep it.`,
    why_it_matters: `The chair's own words: ${pivot}`,
  }, o.by);
}

/**
 * Patch a card's frontmatter and one of its sections in one write, re-deriving `score` from whatever inputs the
 * card now carries. The score is never stored by a caller: it is the arithmetic of `score_inputs`, and letting
 * an agent write a number that disagrees with its own inputs is how a dossier stops being checkable.
 */
export function updateIdea(
  vault: Vault,
  slug: string,
  patch: Partial<IdeaFrontmatter>,
  by: string,
  section?: { heading: string; content: string },
): IdeaFrontmatter | null {
  const cur = readIdea(vault, slug);
  if (!cur) return null;
  const merged = { ...cur.data, ...patch, score_inputs: { ...cur.data.score_inputs, ...(patch.score_inputs ?? {}) } };
  const complete = IdeaScoreInputs.safeParse(merged.score_inputs);
  merged.score = complete.success ? ideaScore(complete.data) : null;
  const body = section ? setSection(cur.body, section.heading, section.content) : cur.body;
  const data = IdeaFrontmatter.parse({ ...merged, id: slug });
  vault.writeText(ideaPath(slug), stringifyNote(data as Record<string, unknown>, body), by);
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// The idea the owner picked is the idea the owner kept (ruling W4-5)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a picked line names: the company, before the CEO's dash and without the CEO's numbering.
 * `2. SpeedAudit — Free website speed fixes` is a decision about SpeedAudit.
 */
export function pickedIdeaName(line: string): string {
  return (line ?? '').replace(/^\s*\d+[.)]\s*/, '').split(/\s+[—–-]\s+|:\s+/)[0].trim();
}

/** A picked name shorter than this is not enough to find a card by without matching half the vault. */
const PICK_NAME_MIN = 4;

/**
 * Mark the idea the owner picked as **kept, by them** — and return its slug, or null (ruling W4-5).
 *
 * Every one of the five cards in the second dry-run read `decision: undecided`, including SpeedAudit, which
 * the owner had chosen by name on the first morning. So `keptIdeas` was empty, `checkPlan` passed every plan
 * vacuously, and the company spent four days planning against nothing anybody had agreed to. The owner's pick
 * *is* a decision; it was simply never written onto the card, because the pick is made before the card exists
 * (the `brand_change` resolved at 06:25 and the discovery job filed `Ideas/speedaudit.md` at 06:27).
 *
 * So it is applied where both are on disk rather than at the moment of the click, and it is idempotent: only
 * an **undecided** card the owner has seen is touched, so a later park or scrap of theirs is never undone by a
 * cycle that ran afterwards.
 */
export function keepOwnerPick(vault: Vault, by = 'daemon', now = new Date()): string | null {
  const chose = pickedCard(vault);
  const card = chose ?? briefCard(vault);
  if (!card || card.idea.decision !== 'undecided') return null;
  const at = now.toISOString();
  updateIdea(vault, card.idea.id, { decision: 'keep', decided_by: 'owner', decided_at: at, status: 'accepted' }, by, {
    heading: '## Decision',
    content: `**keep** — the owner, ${at.slice(0, 10)}. ${card.why}`,
  });
  return card.idea.id;
}

/**
 * A card the owner's own decision could be about: their material, their typing, the idle-hours chat — never a
 * pivot the board proposed. Ruling W3-2 exists so that a `PIVOT REQUIRED` becomes a card the owner *keeps*, and
 * a keep applied on their behalf here would be the company taking that decision for them after all.
 */
function theirsToKeep(idea: IdeaFrontmatter): boolean {
  return ownerHasSeenIdea(idea) && idea.source.split(':')[0].trim().toLowerCase() !== BOARD_IDEA_SOURCE;
}

/** The card the owner's `chosen:` line names, if the CEO offered them three and they took one. */
function pickedCard(vault: Vault): { idea: IdeaFrontmatter; why: string } | null {
  const pick = ownerPick(vault);
  if (!pick) return null;
  const name = pickedIdeaName(pick.line);
  if (name.length < PICK_NAME_MIN) return null;
  const want = ideaSlug(name);
  const idea = listIdeas(vault).find((i) => theirsToKeep(i)
    && (i.id === want || sameIdeaTitle(i.title, name) || ideaSlug(i.title).startsWith(want)));
  return idea ? { idea, why: `${OWNER_PICK_LABEL} ${pick.line.replace(/^\s*\d+[.)]\s*/, '')}` } : null;
}

/**
 * The card the founder brief the owner adopted names — the other half of the same decision.
 *
 * The pick is how an owner who said "surprise me" chooses; an owner who typed their own idea into
 * `Discovery/inbox/` never sees three lines to choose from, and the document they *do* sign is the brief. Its
 * `## Candidate ideas` names the card discovery filed off their material, and adopting it is them saying this
 * is what the company is for. Without this the commonest first run has no kept idea at all and — under the
 * same ruling's gate — would never plan anything.
 *
 * Only an owner-seen card, and only the one the brief actually names: a sweep's card is not made theirs by
 * being filed the same week.
 */
function briefCard(vault: Vault): { idea: IdeaFrontmatter; why: string } | null {
  if (!hasFounderBrief(vault)) return null;
  // The first morning only. Once anything is kept the brief has done this job, and a card filed afterwards is
  // a later idea the owner rules on themselves — not something adopting the brief a week ago agreed to.
  if (keptIdeas(vault).length) return null;
  const brief = vault.readTextOrNull(FOUNDER_BRIEF) ?? '';
  const section = (brief.split(/^## Candidate ideas[ \t]*$/m)[1] ?? '').split(/^## /m)[0];
  const why = `The owner adopted [[${FOUNDER_BRIEF.replace(/\.md$/, '')}]], which is written against this idea.`;
  // The section is read in every spelling the template has ever asked for: a wikilink, a path, and the bare
  // slug `Processes/discovery.md` asks for by name. An `_underscored_` word is emphasis, not a slug.
  const named = new Set([...ideasNamedIn(section), ...[...section.matchAll(new RegExp(`(?<![A-Za-z0-9_/-])(${IDEA_SLUG_SRC})(?![A-Za-z0-9_/-])`, 'gi'))].map((m) => m[1].toLowerCase())]);
  const seen = listIdeas(vault).filter((i) => theirsToKeep(i) && i.decision === 'undecided');
  const idea = seen.find((i) => named.has(i.id.toLowerCase()))
    // …and failing that, the one card the owner's own material produced. Only when there is exactly one: with
    // two, which of them the brief is written against is a question only the owner can answer.
    ?? (seen.length === 1 ? seen[0] : undefined);
  return idea ? { idea, why } : null;
}

/** What an idea verdict tells the owner about a card they kept themselves and the board would now park. */
export function ownerKeptNote(band: IdeaBand): string {
  return `You kept this; the board would ${band} it. Your decision stands unless you change it here.`;
}

/** True for a card the **owner** kept: the one decision no later board session may write over (ruling W4-5). */
export function ownerKept(idea: { decision: IdeaDecision; decided_by: string }): boolean {
  return idea.decision === 'keep' && idea.decided_by === 'owner';
}

/** One line per idea for a plan goal: what it is, what it scored, and where to read it. */
export function keptIdeaLines(ideas: IdeaFrontmatter[]): string[] {
  return ideas.map((i) => `[[${ideaPath(i.id).replace(/\.md$/, '')}]] — ${i.title} (score ${i.score ?? '—'}/${IDEA_SCORE_MAX}${i.research ? `, research ${i.research_confidence ?? 'unstated'} confidence` : ''})`);
}

export interface BoardSectionFacts {
  verdict: 'pass' | 'return';
  /** How many advisors sat. */
  advisors: number;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `Decisions/board-<slug>.md`, or '' when the note could not be written. */
  decision: string;
  findings: string[];
  pressure?: string | null;
  rubric?: BoardRubric | null;
  /** The chair's merged five-part answer, kept whole under its own sub-heading (ruling H3). */
  chair?: string;
}

/**
 * The `## The board` section of a card. Written here rather than inline in the heartbeat's `ideas_board` step
 * so the sentence on the card, the one in the owner's verdict note and the one on the whiteboard all come from
 * one place — and so the placeholder `cardBoardFindings` has to drop is defined beside the code that writes it.
 *
 * With no pressure test to report it is byte-identical to what the step wrote before SP5b, but for a trailing
 * space after the date when no decision note was written.
 *
 * The chair's own answer goes last, under `PRESSURE_CHAIR_SECTION`, so the findings above it stay the bullets
 * the card is read back for and the five parts stay whole underneath (ruling H3).
 */
export function renderBoardSection(f: BoardSectionFacts): string {
  const head = `**${f.verdict === 'pass' ? 'Passed' : 'Returned'}** — ${f.advisors} advisors, ${f.date}.${f.decision ? ` See [[${f.decision.replace(/\.md$/, '')}]].` : ''}`;
  const test = f.pressure ? `**Pressure test:** ${f.pressure}.${f.rubric ? ` Rubric ${renderRubric(f.rubric)}.` : ''}` : '';
  const findings = f.findings.map((x) => `- ${x}`).join('\n') || '- Nothing they thought would sink it.';
  const chair = f.chair?.trim() ? `${PRESSURE_CHAIR_SECTION}\n\n${chairAnswerText(f.chair)}` : '';
  return [head, test, findings, chair].filter(Boolean).join('\n\n');
}
