import { z } from 'zod';
import type { Vault } from './vault.js';
import { Timestamp } from './schemas.js';
import { stringifyNote } from './frontmatter.js';
import { setSection } from './jobs.js';
import { nowIso } from './fs.js';
import { renderRubric, BoardRubric, chairAnswerText, PRESSURE_CHAIR_SECTION } from './pressure.js';

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
 * The highest-scoring idea the board has not sat on yet: scored (both offices have answered), no verdict, not
 * already decided. One per cycle is what the board session costs — four model calls — so the cycle spends them
 * on the best candidate rather than the oldest.
 */
export function nextIdeaForBoard(vault: Vault): IdeaFrontmatter | null {
  return listIdeas(vault).find((i) => i.score !== null && i.board_verdict === null && i.decision === 'undecided') ?? null;
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
