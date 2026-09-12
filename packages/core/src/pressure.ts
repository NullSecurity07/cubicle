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

/** A machine line the chair was asked to write. Never a flaw, wherever it appears. */
const MACHINE_LINE_RE = /^(?:\*\*)?(?:rubric|wedge|verdict)(?:\*\*)?\s*[:\-–—]/i;

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
 * The rubric out of a chair's answer, or null. All five or nothing: four scores and a guess is not a rubric,
 * and a partial one on a card would read as a board that scored the idea 6/10 when it scored four dimensions.
 *
 * A dimension counts only when its own segment of the line carries **exactly one** digit, and that digit is
 * 0–2. The prompt's own template reads `core assumption <0-2>, fatal flaws <0-2>, …`; a chair that echoes it
 * before answering must not be read as having scored every dimension zero, which is what "find the first digit
 * after the label" does. Two digits is a placeholder or a range (`1-2`), and neither is a score.
 */
export function parseRubric(text: string): BoardRubric | null {
  const line = text.match(new RegExp(`^[ \\t]*(?:[-*]\\s*)?(?:\\*\\*)?\\s*rubric\\s*(?:\\*\\*)?\\s*${DELIM}\\s*(.+)$`, 'im'))?.[1];
  if (!line) return null;
  // One segment per dimension. A dimension written twice keeps the first score, the way a reader would.
  const segments = line.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const out: Record<string, number> = {};
  for (const d of RUBRIC_DIMENSIONS) {
    const seg = segments.find((s) => RUBRIC_CUE[d].test(s));
    if (seg === undefined) return null;
    const digits = seg.match(/\d/g) ?? [];
    if (digits.length !== 1) return null;
    out[d] = Number(digits[0]);
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
    .map((l) => l.trim().match(/^[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((f): f is string => !!f && f.length > 3)
    .filter((f) => !MACHINE_LINE_RE.test(f));
}

/** The same lines when the chair wrote its three flaws as prose rather than as a list. */
function linesIn(text: string): string[] {
  return text.split('\n')
    .map((l) => l.trim())
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
 * The section ends at the next heading whether or not the chair put a space after the hashes.
 */
function flawBullets(text: string): string[] {
  const head = text.match(/^#{1,4}[ \t]*(?:\d+[.)]\s*)?Three Fatal Flaws.*$/im);
  if (head?.index === undefined) return [];
  const after = text.slice(head.index + head[0].length);
  const section = after.split(/^#{1,4}/m)[0];
  const bullets = bulletsIn(section);
  return (bullets.length ? bullets : linesIn(section)).slice(0, PRESSURE_MAX_FLAWS);
}

/** A word that names an outcome. `PIVOT` alone stands for `PIVOT REQUIRED`. */
const VERDICT_WORD = '(?:STRONG|WEAK|PIVOT(?:\\s+REQUIRED)?)';

/** Whitespace and punctuation — anything that is not the chair saying a further word. */
const GAP = '[\\s\\p{P}]*';

/**
 * An echo is recognised by its **shape**, not by counting words.
 *
 * The prompt shows the chair `VERDICT: STRONG | WEAK | PIVOT REQUIRED`, and a chair that reprints that has
 * not voted. What makes it a template rather than a decision is that the outcomes are *enumerated*: two or
 * more of them strung together by the separators the template uses — `|`, `/` or the word "or" — with nothing
 * but whitespace and punctuation in between, starting from the top of the line.
 *
 * Counting verdict words instead is what the first attempt did, and it threw away real decisions: a chair that
 * writes `VERDICT: WEAK (not STRONG)` or `VERDICT: WEAK - not STRONG enough` names one outcome and then
 * dismisses another, which is argument, not enumeration. The shape rule keeps those, and keeps
 * `PIVOT REQUIRED (not STRONG or WEAK)` too — the enumeration there is inside the chair's reasoning rather
 * than in place of its answer, which is why the match is anchored.
 */
const ECHO_RE = new RegExp(`^${GAP}${VERDICT_WORD}(?:${GAP}(?:\\||/|\\bor\\b)${GAP}${VERDICT_WORD})+`, 'iu');

/** The outcome a line votes for: the first one it names. Everything after it is the chair's reasoning. */
const FIRST_VERDICT_RE = new RegExp(`\\b${VERDICT_WORD}\\b`, 'i');

function isFormatEcho(value: string): boolean {
  return ECHO_RE.test(value);
}

function verdictOn(value: string): PressureVerdict | null {
  const word = value.match(FIRST_VERDICT_RE)?.[0]?.toUpperCase();
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
 * thinks again, or that reprints the template before deciding, has its final word taken. An answer whose only
 * verdict line is an echo has not voted at all, and is missing rather than STRONG.
 */
export function readPressureVerdict(text: string): PressureRead {
  const t = text ?? '';
  if (BANNED_HEDGE_RE.test(t)) return { ok: false, reason: PRESSURE_REFUSAL_HEDGE };
  const lines = [...t.matchAll(new RegExp(`^[ \\t]*(?:[-*]\\s*)?(?:\\*\\*)?\\s*verdict\\s*(?:\\*\\*)?\\s*${DELIM}\\s*(.*)$`, 'gim'))]
    .map((m) => m[1])
    .filter((value) => !isFormatEcho(value));
  const last = lines.at(-1);
  if (last === undefined) return { ok: false, reason: PRESSURE_REFUSAL_MISSING };
  const verdict = verdictOn(last);
  if (!verdict) {
    const raw = (last.match(/^(?:\*\*)?\s*([A-Za-z ]+)/)?.[1] ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    return { ok: false, reason: pressureRefusalUnknown(raw) };
  }
  const wedge = t.match(new RegExp(`^[ \\t]*(?:[-*]\\s*)?(?:\\*\\*)?\\s*wedge\\s*(?:\\*\\*)?\\s*${DELIM}\\s*(.+)$`, 'im'))?.[1]?.trim() ?? '';
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
