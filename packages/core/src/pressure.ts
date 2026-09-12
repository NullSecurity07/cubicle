import { z } from 'zod';

/**
 * The pressure test: how the board reads an idea.
 *
 * `Docs/pressure-test-handbook.md` is the owner-facing half — the failure catalogue, the five pain tests, the
 * founder-market fit matrix. This module is the half the daemon can check: the five parts an answer owes, the
 * three verdicts it may end in, the 0–2 × 5 rubric, and a parse strict enough that a chair which hedges is
 * asked again rather than believed.
 *
 * Nothing here makes a model call and nothing here reads the vault. It imports zod and nothing else, so
 * `ideas.ts` and the daemon may both depend on it and it depends on neither.
 */

/** The five parts of an answer, in the order the owner asks for them. Order is the point: fit before verdict. */
export const PRESSURE_PARTS = [
  'Core Assumption',
  'Three Fatal Flaws',
  'Problem Validation',
  'Founder-Market Fit',
  'Brutal Verdict',
] as const;
export type PressurePart = (typeof PRESSURE_PARTS)[number];

/** The three allowed outcomes — no fourth (the owner's notes §5). */
export const PRESSURE_VERDICTS = ['STRONG', 'WEAK', 'PIVOT REQUIRED'] as const;
export type PressureVerdict = (typeof PRESSURE_VERDICTS)[number];

/** The phrase the owner banned, because it lets the chair avoid deciding. The canonical wording. */
export const BANNED_HEDGE = 'it has potential but';

/**
 * How the banned phrase is actually found. The owner's notes, `Docs/pressure-test-handbook.md` and the ideas
 * handbook all write it with a comma — "it has potential, but" — and the chair will write it either way, so
 * the comma is optional, the spacing is free (a line break between the words counts) and the case is ignored.
 * Only the exported constant is canonical; this is the net. `\b` after `but` so a chair who says the idea
 * "has potential buttons" is not refused for a word it did not use.
 */
const BANNED_HEDGE_RE = /it\s+has\s+potential\s*,?\s*but\b/i;

/** The owner-facing half of the test, in the vault. Task 3's prompts point the chair at it. */
export const PRESSURE_HANDBOOK_PATH = 'Docs/pressure-test-handbook.md';

/** The five dimensions of the triage rubric, each scored 0–2, total out of 10. */
export const RUBRIC_DIMENSIONS = ['core_assumption', 'fatal_flaws', 'pain', 'founder_fit', 'why_now'] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];
export const RUBRIC_MAX = 10;

/** What each dimension is called in prose — in the chair's prompt, on the card, and on the whiteboard. */
export const RUBRIC_LABEL: Record<RubricDimension, string> = {
  core_assumption: 'core assumption',
  fatal_flaws: 'fatal flaws',
  pain: 'pain',
  founder_fit: 'founder fit',
  why_now: 'why now',
};

/**
 * How each dimension is named on a `RUBRIC:` line. Written once so the prompt and the parse cannot drift.
 * Labels only — the score is read separately, because *how many* digits a dimension carries is the thing that
 * separates a score from a placeholder.
 */
const RUBRIC_CUE: Record<RubricDimension, RegExp> = {
  core_assumption: /core\s*assumption/i,
  fatal_flaws: /(?:fatal\s*)?flaws?/i,
  pain: /pain(?:\s*level)?/i,
  founder_fit: /founder[\s-]*(?:market[\s-]*)?fit/i,
  why_now: /why\s*now/i,
};

/**
 * What separates `VERDICT`, `RUBRIC` and `WEDGE` from their value. Colon, hyphen, en dash — and the em dash
 * this codebase writes everywhere, `renderRubric`'s own output included, so `VERDICT — STRONG` is an answer
 * rather than a re-ask spent on punctuation.
 */
const DELIM = '[:\\-–—]';

/**
 * What a chair may put in front of a label without changing what the line says: a blockquote, a heading's
 * hashes, a list marker, a number from a list it is imitating, and emphasis. All of it is stripped before
 * anything is read, because `- **VERDICT:** WEAK`, `5. VERDICT: WEAK`, `> VERDICT: WEAK` and
 * `## Brutal Verdict: WEAK` are one sentence written four ways, and a re-ask spent on any of them is a call the
 * budget does not have.
 */
const LINE_LEAD = '[ \\t]*(?:>[ \\t]*)*(?:#{1,6}[ \\t]*)?(?:[-*+][ \\t]+)?(?:\\d+[.)][ \\t]*)?[*_`]*[ \\t]*';

/** The labels the chair was told to write, as one alternation. `Brutal Verdict:` is the owner's own heading. */
const VERDICT_LABEL = 'brutal[ \\t]+verdict|verdict';

/** `<lead><label><emphasis><delimiter> <value>`. The value is group 1. */
function labelLine(label: string, tail: string, flags: string): RegExp {
  return new RegExp(`^${LINE_LEAD}(?:${label})[*_\`]*[ \\t]*${DELIM}[ \\t]*(${tail})$`, flags);
}

const VERDICT_LINE_RE = labelLine(VERDICT_LABEL, '.*', 'gim');
const RUBRIC_LINE_RE = labelLine('rubric', '.*', 'im');
const WEDGE_LINE_RE = labelLine('wedge', '.+', 'im');

/** A machine line the chair was asked to write. Never a flaw, wherever it appears. */
const MACHINE_LINE_RE = new RegExp(`^${LINE_LEAD}(?:rubric|wedge|${VERDICT_LABEL})[*_\`]*[ \\t]*${DELIM}`, 'i');

/** A blockquote marker, stripped per line so a chair that quotes its own answer back is still read. */
const QUOTE_RE = /^[ \t]*(?:>[ \t]?)+/;

/**
 * A value with the emphasis the chair wrapped it in taken off, and a bracket pair that wraps the whole of it —
 * `[STRONG | WEAK | PIVOT REQUIRED]`, `(STRONG)` — unwrapped, so what is read is what the chair meant to say.
 */
function cleanValue(value: string): string {
  let v = value.replace(/\r/g, '').trim().replace(/^[*_`\s]+/, '').replace(/[*_`\s]+$/, '');
  if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('(') && v.endsWith(')'))) v = v.slice(1, -1).trim();
  return v;
}

const zeroToTwo = z.number().int().min(0).max(2);

/**
 * The board's rubric on one idea. Additive and optional on a card: every dossier written before the pressure
 * test existed carries none, and a board that answered without one still rules.
 */
export const BoardRubric = z.object({
  core_assumption: zeroToTwo,
  fatal_flaws: zeroToTwo,
  pain: zeroToTwo,
  founder_fit: zeroToTwo,
  why_now: zeroToTwo,
});
export type BoardRubric = z.infer<typeof BoardRubric>;

export function rubricTotal(r: BoardRubric): number {
  return RUBRIC_DIMENSIONS.reduce((sum, d) => sum + r[d], 0);
}

/** `7/10 — core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1`. One line, everywhere it is shown. */
export function renderRubric(r: BoardRubric): string {
  return `${rubricTotal(r)}/${RUBRIC_MAX} — ${RUBRIC_DIMENSIONS.map((d) => `${RUBRIC_LABEL[d]} ${r[d]}`).join(', ')}`;
}

/**
 * A dimension's score, read from the text that follows its label. One digit, optionally written as a fraction
 * of two (`2/2`), reached across nothing but whitespace, emphasis and one delimiter.
 *
 * What it refuses is as load-bearing as what it reads. The prompt's own template writes `core assumption <0-2>`
 * and a chair that reprints it has scored nothing — the `<` is not a delimiter, so nothing matches. A range
 * (`1-2`) is not a score either, and neither is a second number of any kind, so the digit must not be followed
 * by another digit or by a dash or slash and a digit. What it deliberately *does* ignore is the total: the
 * chair is told the rubric is "out of 10" and shown `7/10 — core assumption 2, …`, so `— total 7/10`,
 * `(7/10)` and `= 7 out of 10` are all compliance, not noise (ruling H2).
 */
const SCORE_AFTER_LABEL = /^[ \t]*[*_`]*[ \t]*(?:[:=\-–—][ \t]*)?[*_`]*[ \t]*(\d)(?:[ \t]*\/[ \t]*2\b)?(?!\d)(?![ \t]*[-–—/][ \t]*\d)/;

/** Every place a dimension is named, in order; the first one that carries a score is the one that counts. */
function scoreFor(block: string, cue: RegExp): number | null {
  for (const m of block.matchAll(new RegExp(cue.source, cue.flags.includes('g') ? cue.flags : `${cue.flags}g`))) {
    const hit = block.slice((m.index ?? 0) + m[0].length).match(SCORE_AFTER_LABEL);
    if (hit) return Number(hit[1]);
  }
  return null;
}

/**
 * The rubric block: what follows `RUBRIC:` on its own line, plus every line under it that goes on naming
 * dimensions. One line is what the prompt asks for; a chair that answers `RUBRIC:` and then lists the five
 * labels beneath it has written the same thing, and the block stops at the first line that names none of them
 * so the scan never wanders into the flaws.
 */
function rubricBlock(text: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => RUBRIC_LINE_RE.test(l));
  if (at < 0) return null;
  const block = [lines[at].match(RUBRIC_LINE_RE)?.[1] ?? ''];
  for (let i = at + 1; i < lines.length; i++) {
    if (!RUBRIC_DIMENSIONS.some((d) => RUBRIC_CUE[d].test(lines[i]))) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

/**
 * The rubric out of a chair's answer, or null. All five or nothing: four scores and a guess is not a rubric,
 * and a partial one on a card would read as a board that scored the idea 6/10 when it scored four dimensions.
 *
 * Label-then-score pairs, read anywhere in the block (ruling H2). The earlier rule — split on commas, refuse a
 * segment carrying two digits — defeated the placeholder but also threw away every shape that states its own
 * total, including `renderRubric`'s own output and the worked example the handbook prints.
 */
export function parseRubric(text: string): BoardRubric | null {
  const block = rubricBlock(text);
  if (block === null) return null;
  const out: Record<string, number> = {};
  for (const d of RUBRIC_DIMENSIONS) {
    const score = scoreFor(block, RUBRIC_CUE[d]);
    if (score === null) return null;
    out[d] = score;
  }
  const parsed = BoardRubric.safeParse(out);
  return parsed.success ? parsed.data : null;
}

/** Why a chair's answer was not believed. Each is shown to the chair on the one re-ask it gets. */
export const PRESSURE_REFUSAL_HEDGE = `the verdict used the banned phrase "${BANNED_HEDGE}", which is a way of not deciding`;
export const PRESSURE_REFUSAL_MISSING = 'the answer carried no VERDICT line at all';
export function pressureRefusalUnknown(said: string): string {
  return `the verdict was "${said.slice(0, 40)}", which is not one of ${PRESSURE_VERDICTS.join(', ')}`;
}

/**
 * What a verdict carries when `## Three Fatal Flaws` is missing or empty — itself a finding, not a silence.
 * A board that ruled on an idea without naming one thing that could sink it has told the owner something.
 */
export const PRESSURE_NO_FLAWS = 'the chair named no flaws';

/** What a PIVOT REQUIRED says when the chair named no wedge — itself a finding, not a silence. */
export const PRESSURE_NO_WEDGE = 'the board says pivot but named no wedge: the narrowest slice, and the most desperate users to aim it at, are unstated';

/** What the board records when the chair would not answer in the required form twice running. */
export const PRESSURE_UNANSWERED = 'the board chair would not answer in the required form twice running, so the idea is returned unjudged rather than passed by default';

export type PressureRead =
  | { ok: true; verdict: PressureVerdict; flaws: string[]; wedge: string; rubric: BoardRubric | null }
  | { ok: false; reason: string };

/** How many flaws a verdict carries. Four, the cap `mergeBoardVerdict` has always used. */
export const PRESSURE_MAX_FLAWS = 4;

function bulletsIn(text: string): string[] {
  return text.split('\n')
    .map((l) => l.replace(QUOTE_RE, '').trim().match(/^[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((f): f is string => !!f && f.length > 3)
    .filter((f) => !MACHINE_LINE_RE.test(f));
}

/** The same lines when the chair wrote its three flaws as prose rather than as a list. */
function linesIn(text: string): string[] {
  return text.split('\n')
    .map((l) => l.replace(QUOTE_RE, '').trim())
    .filter((l) => l.length > 3)
    .filter((l) => !MACHINE_LINE_RE.test(l));
}

/**
 * The flaws, read **only** out of `## Three Fatal Flaws`: its bullets, or its own lines when the chair wrote a
 * paragraph there instead. No section means no flaws (`PRESSURE_NO_FLAWS` says so), because the alternative —
 * falling back to every bullet in the answer — is exactly what Decision 9 forbids: it files "they use a
 * spreadsheet today" from under `## Problem Validation` as a reason the idea dies. An empty list is honest, and
 * the chair still gets its verdict.
 *
 * The heading is matched however the chair wrote it — `## Three Fatal Flaws`, `**Three Fatal Flaws**`,
 * `2. Three Fatal Flaws`, or the bare line — because bolding a heading it was shown hashed is one of the
 * commonest things a model does, and this is the only heading the parse depends on (I2). Decision 9's scoping
 * is untouched by that: the section still ends at the next part, so a bullet under `## Problem Validation` is
 * never filed as a reason the idea dies.
 */
function flawBullets(text: string): string[] {
  const head = text.match(FLAWS_HEAD_RE);
  if (head?.index === undefined) return [];
  const rest = text.slice(head.index + head[0].length).split('\n');
  const section: string[] = [];
  for (const line of rest) {
    if (FLAWS_END_RE.test(line.replace(QUOTE_RE, ''))) break;
    section.push(line);
  }
  const bullets = bulletsIn(section.join('\n'));
  return (bullets.length ? bullets : linesIn(section.join('\n'))).slice(0, PRESSURE_MAX_FLAWS);
}

/** The one heading the parse depends on, in `##`, bold, numbered and bare forms (ruling H1). */
const FLAWS_HEAD_RE = new RegExp(`^${LINE_LEAD}Three Fatal Flaws.*$`, 'im');

/** The other four parts, as the chair may head them — the flaws section ends at whichever comes first. */
const OTHER_PARTS = PRESSURE_PARTS.filter((p) => p !== 'Three Fatal Flaws').map((p) => p.replace(/-/g, '[- ]')).join('|');

/**
 * Where the flaws stop: the next heading of any depth, any line that is nothing but one bolded phrase, or a
 * line that opens with one of the other four part names however it is decorated. A bullet whose *first words*
 * are bolded — `- **Allergen liability** sits with the nursery` — is a flaw and not a heading, which is why the
 * bold rule wants the whole line.
 */
const FLAWS_END_RE = new RegExp(
  `^[ \\t]*(?:#{1,6}|(?:\\*\\*|__)[^*_\\n]+(?:\\*\\*|__)[ \\t]*:?[ \\t]*$|(?:\\*\\*|__|\\d+[.)][ \\t]*)?(?:${OTHER_PARTS})\\b)`,
  'i',
);

/** A word that names an outcome. `PIVOT` alone stands for `PIVOT REQUIRED`. */
const VERDICT_WORD = '(?:STRONG|WEAK|PIVOT(?:[ \\t]+REQUIRED)?)';

/**
 * A vote: the verdict word **first**, and then the line either ends or turns into punctuation.
 *
 * Both halves are load-bearing. First, because the prompt says one of those three and nothing else on that
 * line, and because searching the whole line for a verdict word is what let
 * `- Verdict: strong disagreement among the advisors` overwrite a real vote with a word that was not one (I4).
 * Then punctuation or nothing, because `VERDICT: STRONG — the pain is real` is a strong verdict (Decision 4)
 * and `strong disagreement` is not a verdict at all; the difference between them is exactly the character
 * after the word.
 */
const VOTE_RE = new RegExp(`^(${VERDICT_WORD})(?=[ \\t]*$|[ \\t]*[^\\p{L}\\p{N}\\s])`, 'iu');

/** The separators the template uses between the three outcomes, one or more in a row (`, or`). */
const ECHO_SEP = '(?:[ \\t]*(?:\\||/|,|\\bor\\b))+[ \\t]*';

/**
 * An echo is recognised by its **shape**, not by counting words: two or more outcomes enumerated, from the top
 * of the value (after the prompt's own "one of", if the chair copied that too), with nothing between them but
 * the separators the template uses — `|`, `/`, `,` or "or" — or a value that still carries the prompt's own
 * `<…>` placeholder (ruling H1).
 *
 * Counting verdict words instead threw away real decisions: a chair that writes `VERDICT: WEAK (not STRONG)`
 * or `VERDICT: WEAK - not STRONG enough` names one outcome and then dismisses another, which is argument, not
 * enumeration. The anchor is what keeps those, and keeps `PIVOT REQUIRED (not STRONG or WEAK)` too — the
 * enumeration there is inside the chair's reasoning rather than in place of its answer.
 */
const ECHO_RE = new RegExp(`^(?:one[ \\t]+of[ \\t]+)?${VERDICT_WORD}(?:${ECHO_SEP}${VERDICT_WORD})+`, 'iu');
const PLACEHOLDER_RE = /<[^<>]*>/;

function isFormatEcho(value: string): boolean {
  return PLACEHOLDER_RE.test(value) || ECHO_RE.test(value);
}

function verdictOn(value: string): PressureVerdict | null {
  const word = value.match(VOTE_RE)?.[1]?.toUpperCase();
  if (!word) return null;
  return word.startsWith('PIVOT') ? 'PIVOT REQUIRED' : word.startsWith('STRONG') ? 'STRONG' : 'WEAK';
}

/**
 * Read the chair's merged answer. Strict on the one line that decides and forgiving everywhere else.
 *
 * `VERDICT: STRONG — the pain is real` is a strong verdict: the words after the dash are the chair's reasons,
 * not a fourth outcome (Decision 4). `VERDICT: maybe`, `VERDICT: it has potential but…` and an answer with no
 * verdict line are all refusals, because each of them is the chair declining to decide, which is the failure
 * the whole exercise exists to prevent.
 *
 * Of the verdict lines that are votes rather than format echoes, the **last** one is the answer: a chair that
 * thinks again, or that reprints the template before deciding, has its final word taken. A labelled line that
 * is not a vote — `VERDICT: MAYBE`, a bullet beginning "Verdict: strong disagreement" — never becomes one and
 * never overwrites one; when no line on the page is a vote, the last of those is what the refusal quotes back.
 * An answer whose only verdict line is an echo has not voted at all, and is missing rather than STRONG.
 */
export function readPressureVerdict(text: string): PressureRead {
  const t = text ?? '';
  if (BANNED_HEDGE_RE.test(t)) return { ok: false, reason: PRESSURE_REFUSAL_HEDGE };
  const values = [...t.matchAll(VERDICT_LINE_RE)].map((m) => cleanValue(m[1])).filter((v) => !isFormatEcho(v));
  const verdict = values.map(verdictOn).filter((v): v is PressureVerdict => v !== null).at(-1);
  if (!verdict) {
    const said = values.filter((v) => v.length > 0).at(-1);
    if (said === undefined) return { ok: false, reason: PRESSURE_REFUSAL_MISSING };
    return { ok: false, reason: pressureRefusalUnknown(said.toUpperCase().replace(/\s+/g, ' ')) };
  }
  const wedge = t.match(WEDGE_LINE_RE)?.[1]?.trim() ?? '';
  return { ok: true, verdict, flaws: flawBullets(t), wedge, rubric: parseRubric(t) };
}

/** STRONG passes; WEAK and PIVOT REQUIRED both return. The board advises; the owner decides. */
export function pressureToBoard(v: PressureVerdict): 'pass' | 'return' {
  return v === 'STRONG' ? 'pass' : 'return';
}

/**
 * The findings a verdict carries. A pivot leads with the wedge, because "attack this narrower thing instead"
 * is the one finding the author can act on today; the flaws follow it. A verdict that named no flaws says so,
 * rather than arriving as an empty list the reader has to interpret.
 */
export function pressureFindings(r: { verdict: PressureVerdict; flaws: string[]; wedge: string }): string[] {
  const flaws = r.flaws.length ? r.flaws : [PRESSURE_NO_FLAWS];
  if (r.verdict !== 'PIVOT REQUIRED') return flaws.slice(0, PRESSURE_MAX_FLAWS);
  const wedge = r.wedge.trim() ? `Pivot required. The wedge to attack instead: ${r.wedge.trim()}` : PRESSURE_NO_WEDGE;
  return [wedge, ...flaws].slice(0, PRESSURE_MAX_FLAWS);
}
