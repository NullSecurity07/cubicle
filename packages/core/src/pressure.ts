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

/** The phrase the owner banned, because it lets the chair avoid deciding. */
export const BANNED_HEDGE = 'it has potential but';
const BANNED_HEDGE_RE = /it\s+has\s+potential\s*,?\s*but/i;

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

/** How each dimension is found on a `RUBRIC:` line. Written once so the prompt and the parse cannot drift. */
const RUBRIC_CUE: Record<RubricDimension, RegExp> = {
  core_assumption: /core\s*assumption\D{0,6}([0-2])/i,
  fatal_flaws: /(?:fatal\s*)?flaws?\D{0,6}([0-2])/i,
  pain: /pain(?:\s*level)?\D{0,6}([0-2])/i,
  founder_fit: /founder[\s-]*(?:market[\s-]*)?fit\D{0,6}([0-2])/i,
  why_now: /why\s*now\D{0,6}([0-2])/i,
};

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

/** 8–10 strong · 5–7 pivot / needs work · 0–4 weak. Advisory: it never moves `ideaBand` (Decision 11). */
export function rubricBand(total: number): 'strong' | 'pivot' | 'weak' {
  return total >= 8 ? 'strong' : total >= 5 ? 'pivot' : 'weak';
}

/** `7/10 — core assumption 2, fatal flaws 1, pain 2, founder fit 1, why now 1`. One line, everywhere it is shown. */
export function renderRubric(r: BoardRubric): string {
  return `${rubricTotal(r)}/${RUBRIC_MAX} — ${RUBRIC_DIMENSIONS.map((d) => `${RUBRIC_LABEL[d]} ${r[d]}`).join(', ')}`;
}

/**
 * The rubric out of a chair's answer, or null. All five or nothing: four scores and a guess is not a rubric,
 * and a partial one on a card would read as a board that scored the idea 6/10 when it scored four dimensions.
 */
export function parseRubric(text: string): BoardRubric | null {
  const line = text.match(/^[ \t]*(?:[-*]\s*)?(?:\*\*)?\s*rubric\s*(?:\*\*)?\s*[:\-–]\s*(.+)$/im)?.[1];
  if (!line) return null;
  const out: Record<string, number> = {};
  for (const d of RUBRIC_DIMENSIONS) {
    const m = line.match(RUBRIC_CUE[d]);
    if (!m) return null;
    out[d] = Number(m[1]);
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
    .filter((f) => !/^(?:\*\*)?(?:rubric|wedge|verdict)(?:\*\*)?\s*[:\-–]/i.test(f));
}

/**
 * The flaws, read out of `## Three Fatal Flaws` when the chair wrote the five parts, and out of the whole
 * answer when it did not. Scoped rather than global so a bullet under `## Problem Validation` — "they use a
 * spreadsheet today" — is not filed as a reason the idea dies.
 */
function flawBullets(text: string): string[] {
  const head = text.match(/^#{1,4}[ \t]*(?:\d+[.)]\s*)?Three Fatal Flaws.*$/im);
  if (head?.index === undefined) return bulletsIn(text).slice(0, PRESSURE_MAX_FLAWS);
  const after = text.slice(head.index + head[0].length);
  const section = after.split(/^#{1,4}[ \t]/m)[0];
  const scoped = bulletsIn(section);
  return (scoped.length ? scoped : bulletsIn(text)).slice(0, PRESSURE_MAX_FLAWS);
}

/**
 * Read the chair's merged answer. Strict on the one line that decides and forgiving everywhere else.
 *
 * `VERDICT: STRONG — the pain is real` is a strong verdict: the words after the dash are the chair's reasons,
 * not a fourth outcome (Decision 4). `VERDICT: maybe`, `VERDICT: it has potential but…` and an answer with no
 * verdict line are all refusals, because each of them is the chair declining to decide, which is the failure
 * the whole exercise exists to prevent.
 */
export function readPressureVerdict(text: string): PressureRead {
  const t = text ?? '';
  if (BANNED_HEDGE_RE.test(t)) return { ok: false, reason: PRESSURE_REFUSAL_HEDGE };
  const m = t.match(/^[ \t]*(?:[-*]\s*)?(?:\*\*)?\s*verdict\s*(?:\*\*)?\s*[:\-–]\s*(?:\*\*)?\s*([A-Za-z ]+)/im);
  if (!m) return { ok: false, reason: PRESSURE_REFUSAL_MISSING };
  const raw = m[1].trim().toUpperCase().replace(/\s+/g, ' ');
  const verdict: PressureVerdict | null =
    /^PIVOT(?: REQUIRED)?\b/.test(raw) ? 'PIVOT REQUIRED'
      : /^STRONG\b/.test(raw) ? 'STRONG'
        : /^WEAK\b/.test(raw) ? 'WEAK'
          : null;
  if (!verdict) return { ok: false, reason: pressureRefusalUnknown(raw) };
  const wedge = t.match(/^[ \t]*(?:[-*]\s*)?(?:\*\*)?\s*wedge\s*(?:\*\*)?\s*[:\-–]\s*(.+)$/im)?.[1]?.trim() ?? '';
  return { ok: true, verdict, flaws: flawBullets(t), wedge, rubric: parseRubric(t) };
}

/** STRONG passes; WEAK and PIVOT REQUIRED both return. The board advises; the owner decides. */
export function pressureToBoard(v: PressureVerdict): 'pass' | 'return' {
  return v === 'STRONG' ? 'pass' : 'return';
}

/**
 * The findings a verdict carries. A pivot leads with the wedge, because "attack this narrower thing instead"
 * is the one finding the author can act on today; the flaws follow it.
 */
export function pressureFindings(r: { verdict: PressureVerdict; flaws: string[]; wedge: string }): string[] {
  if (r.verdict !== 'PIVOT REQUIRED') return r.flaws.slice(0, PRESSURE_MAX_FLAWS);
  const wedge = r.wedge.trim() ? `Pivot required. The wedge to attack instead: ${r.wedge.trim()}` : PRESSURE_NO_WEDGE;
  return [wedge, ...r.flaws].slice(0, PRESSURE_MAX_FLAWS);
}
