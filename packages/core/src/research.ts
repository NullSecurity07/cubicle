import { z } from 'zod';

/**
 * The owner's Research & Intelligence operating model, as code.
 *
 * Every exported function here is pure: the tool layer, the daemon and the tests all share one definition of
 * what a research request is, what it is worth, and how it reads on the page. Section numbers in the comments
 * refer to `docs/owner/research-operating-model.md`.
 */

export const ResearchConfidence = z.enum(['high', 'medium', 'low']);
export type ResearchConfidence = z.infer<typeof ResearchConfidence>;

/** §21: incremental (present) / adjacent (near future) / exploratory (long future). */
export const PortfolioTag = z.enum(['incremental', 'adjacent', 'exploratory']);
export type PortfolioTag = z.infer<typeof PortfolioTag>;

/**
 * §33 universal research request, plus the §21 portfolio tag and the three §29 prioritisation inputs.
 *
 * `hypothesis` and `exploration` are both optional *here* because §3 allows either: the "exactly one of them"
 * rule lives in `missingRequestFields`, which is what refuses a request, so the schema itself stays a plain
 * shape that `JobFrontmatter` can embed and `gen-docs` can describe.
 */
export const ResearchRequest = z.object({
  decision: z.string().trim().min(1),
  decision_owner: z.string().trim().min(1),
  question: z.string().trim().min(1),
  hypothesis: z.string().default(''),
  exploration: z.string().default(''),
  known_evidence: z.string().trim().min(1),
  unknowns: z.string().trim().min(1),
  constraints: z.string().default(''),
  deadline: z.string().trim().min(1),
  required_confidence: ResearchConfidence,
  potential_decisions: z.array(z.string().trim().min(1)).min(2),
  portfolio: PortfolioTag,
  impact: z.number().int().min(1).max(5),
  uncertainty: z.number().int().min(1).max(5),
  cost_of_being_wrong: z.number().int().min(1).max(5),
});
export type ResearchRequest = z.infer<typeof ResearchRequest>;

/**
 * The fields a request must carry, in the order a refusal lists them. `constraints` is absent on purpose:
 * §33 accepts "none". `hypothesis or exploration` is one entry because either satisfies it.
 */
export const REQUEST_FIELDS = [
  'decision', 'decision_owner', 'question', 'hypothesis or exploration', 'known_evidence', 'unknowns',
  'deadline', 'required_confidence', 'potential_decisions', 'portfolio', 'impact', 'uncertainty', 'cost_of_being_wrong',
] as const;

/** One line per field, shown in the refusal so the next attempt can be right without reading the handbook. */
export const REQUEST_FIELD_HELP: Record<string, string> = {
  decision: 'the decision this research informs, in one sentence ("ship the pricing page or keep the waitlist")',
  decision_owner: 'the role id who will make that decision and who receives the report',
  question: 'the single question the research answers, sharp enough that evidence could settle it',
  'hypothesis or exploration': 'a testable hypothesis ("a public price cuts signups by >20%"), or, when you genuinely do not know what is happening, one line of exploration instead',
  known_evidence: 'what the company already knows or believes, and where that came from',
  unknowns: 'what is missing — the gap the research has to close',
  deadline: 'the date the decision has to be made by (YYYY-MM-DD)',
  required_confidence: 'high, medium or low — how sure the decision owner needs to be',
  potential_decisions: 'at least two options the report could recommend (proceed, modify, delay, stop, investigate further)',
  portfolio: 'incremental (improves what exists), adjacent (a nearby market or technology) or exploratory (uncertain, long-term)',
  impact: '1–5: how much the decision matters to the company',
  uncertainty: '1–5: how unsure the company is today',
  cost_of_being_wrong: '1–5: what it costs if the decision goes the wrong way',
};

/** Which required fields are absent or invalid, in `REQUEST_FIELDS` order. Empty means the request is complete. */
export function missingRequestFields(input: unknown): string[] {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const bad = new Set<string>();
  const parsed = ResearchRequest.safeParse(o);
  if (!parsed.success) for (const i of parsed.error.issues) { const k = String(i.path[0] ?? ''); if (k) bad.add(k); }
  const filled = (k: string) => typeof o[k] === 'string' && (o[k] as string).trim() !== '';
  if (!filled('hypothesis') && !filled('exploration')) bad.add('hypothesis or exploration');
  return REQUEST_FIELDS.filter((f) => bad.has(f));
}

/**
 * The refusal a model can act on. Naming the missing fields *and* what each one means is the difference between
 * one corrected retry and four blind ones — the same lesson `cannotScheduleText` learned in the scheduler.
 */
export function incompleteRequestText(missing: string[]): string {
  const lines = missing.map((f) => `- ${f}: ${REQUEST_FIELD_HELP[f] ?? 'required'}`);
  return [
    `A research job needs the full research request before anyone can work on it (Research operating model §33).`,
    `Missing: ${missing.join(', ')}.`,
    ...lines,
    `Call scheduler.request again with a \`research\` object carrying every field. Nothing was queued.`,
  ].join('\n');
}

/** §29: priority rises with impact and uncertainty, and most of all with the cost of being wrong. 1–125. */
export function priorityScore(r: Pick<ResearchRequest, 'impact' | 'uncertainty' | 'cost_of_being_wrong'>): number {
  return r.impact * r.uncertainty * r.cost_of_being_wrong;
}

/** Score → job priority (1 runs first, 5 last). Depth scales with the score; so does what runs next. */
export function jobPriorityFor(score: number): number {
  if (score >= 60) return 1;
  if (score >= 30) return 2;
  if (score >= 12) return 3;
  if (score >= 4) return 4;
  return 5;
}

/**
 * One bullet's worth of a requester-supplied field. Every value here is one line by contract, and collapsing the
 * whitespace enforces it: a multi-line value would otherwise carry its own `## Heading` line into the job note,
 * and the note's structure is what the harness and the gates read.
 */
const bullet = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The `## Research request` section written into the job note so the worker and the reviewer read the same brief. */
export function renderResearchRequest(r: ResearchRequest): string {
  const score = priorityScore(r);
  const frame = r.hypothesis.trim() ? `- **Hypothesis:** ${bullet(r.hypothesis)}` : `- **Exploration:** ${bullet(r.exploration)}`;
  return [
    '## Research request',
    '',
    `- **Decision:** ${bullet(r.decision)}`,
    `- **Decision owner:** ${bullet(r.decision_owner)}`,
    `- **Question:** ${bullet(r.question)}`,
    frame,
    `- **Known evidence:** ${bullet(r.known_evidence)}`,
    `- **Unknowns:** ${bullet(r.unknowns)}`,
    `- **Constraints:** ${bullet(r.constraints) || 'none stated'}`,
    `- **Deadline:** ${bullet(r.deadline)}`,
    `- **Required confidence:** ${r.required_confidence}`,
    `- **Potential decisions:** ${r.potential_decisions.map(bullet).join(' | ')}`,
    `- **Portfolio:** ${r.portfolio}`,
    `- **Priority score:** ${r.impact} impact × ${r.uncertainty} uncertainty × ${r.cost_of_being_wrong} cost of being wrong = ${score} (job priority ${jobPriorityFor(score)})`,
    '',
  ].join('\n');
}

/** Directory name for a research project: readable from the question, unique from the job id. */
export function researchSlug(question: string, jobId: string): string {
  const words = question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5);
  const base = words.join('-') || 'research';
  return `${base}-${jobId.replace(/^job_/, '').slice(-6)}`;
}

/** A `## Result` heading on a line of its own — text inside a rendered request never matches. */
export const RESULT_HEADING = /^## Result[ \t]*$/m;

/**
 * The **last** `## Result` JSON block of a job body, as a plain object. `{}` when absent or unparseable.
 *
 * Last, not first: `jobs.ts` renders the agent-supplied `## Research request` section *above* `## Result`, so a
 * requester whose question or known evidence contained a `## Result` heading and a ```json fence could forge the
 * method, confidence and summary that reach `Research/index.md` and the follow-up prediction. The split is
 * length-checked because `split` on a body with no heading returns the whole body, which would let a fence
 * anywhere in it be read as a result.
 */
export function resultBlock(body: string): Record<string, unknown> {
  const parts = body.split(RESULT_HEADING);
  const raw = parts.length > 1 ? parts[parts.length - 1].match(/```json\n([\s\S]*?)\n```/)?.[1] : undefined;
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch { return {}; }
}

/** The one institutional research repository (§23). Everything that ships gets a row. */
export const RESEARCH_INDEX = 'Research/index.md';

export const INDEX_HEADER = [
  '| delivered | job | question | decision | owner | method | confidence | report | outcome |',
  '|---|---|---|---|---|---|---|---|---|',
].join('\n');

export interface DeliveredResearch {
  job: string;
  /** YYYY-MM-DD. */
  delivered: string;
  question: string;
  decision: string;
  decision_owner: string;
  method: string;
  confidence: string;
  /** Vault-relative path to the report, e.g. `Research/<slug>/report.md`. */
  report: string;
}

/** A pipe inside agent-written prose would split the row into new columns; a slash is the honest repair. */
const cell = (s: string) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '—';

export function indexRow(d: DeliveredResearch, outcome = 'pending'): string {
  const link = `[[${d.report.replace(/\.md$/, '')}]]`;
  return `| ${cell(d.delivered)} | [[${d.job}]] | ${cell(d.question)} | ${cell(d.decision)} | ${cell(d.decision_owner)} | ${cell(d.method)} | ${cell(d.confidence)} | ${link} | ${cell(outcome)} |`;
}

/**
 * Add or update this job's row. Keyed on the job id, so a re-run updates rather than duplicating, and the
 * measurement job (§40) can come back weeks later and write the outcome into the row it already has.
 */
export function upsertIndexRow(existing: string | null, d: DeliveredResearch, outcome?: string): string {
  const row = indexRow(d, outcome);
  const base = existing?.trim()
    ? existing
    : `# Research index\n\nEvery delivered research project: the question, the decision it informed, how it was answered, how sure we were, and what actually happened. Search here before starting anything (§9).\n\n${INDEX_HEADER}\n`;
  const withHeader = base.includes(INDEX_HEADER) ? base : `${base.trimEnd()}\n\n${INDEX_HEADER}\n`;
  const lines = withHeader.split('\n');
  const at = lines.findIndex((l) => l.includes(`[[${d.job}]]`));
  if (at >= 0) { lines[at] = row; return lines.join('\n'); }
  const out = withHeader.trimEnd();
  return `${out}\n${row}\n`;
}
