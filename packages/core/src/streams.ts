import { z } from 'zod';
import type { Vault } from './vault.js';
import type { CubicleEvent } from './schemas.js';
import { stringifyNote } from './frontmatter.js';
import { nowIso } from './fs.js';

/**
 * A *stream* is one product the company runs (program design §7, owner's operating model §9: small, stable,
 * stream-aligned teams own customer value end to end). Objectives against a stream are outcomes with a measure —
 * "raise checkout completion from 72 % to 82 %" — never feature lists.
 *
 * `error_budget` is in incident-hours per weekly cycle (§23): when it is spent, the division plan must prioritise
 * reliability work. `repo_path` is where the product's code lives in the vault, and is what `ci.run` mounts.
 */
export const StreamFrontmatter = z.looseObject({
  slug: z.string(),
  name: z.string(),
  problem: z.string(),
  customers: z.string(),
  outcome_metric: z.string(),
  owner_team: z.string(),
  error_budget: z.number().min(0).default(4),
  runbook: z.string().default(''),
  repo_path: z.string(),
  status: z.enum(['active', 'paused', 'retired']).default('active'),
  created: z.string(),
});
export type StreamFrontmatter = z.infer<typeof StreamFrontmatter>;

export const STREAMS_DIR = 'Streams';

export function streamPath(slug: string): string { return `${STREAMS_DIR}/${slug}.md`; }

/** Where the stream's code lives and where `ci.run` mounts its sandbox. */
export function workspacePath(slug: string): string { return `Workspace/${slug}`; }

export function streamSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'stream';
}

/** `_template.md` is the owner's copy-me note, not a stream. */
function isStreamNote(rel: string): boolean {
  const stem = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '');
  return !stem.startsWith('_');
}

export function readStream(vault: Vault, slug: string): { data: StreamFrontmatter; body: string } | null {
  const n = vault.readNoteOrNull(streamPath(slug));
  if (!n) return null;
  const p = StreamFrontmatter.safeParse({ ...n.data, slug });
  return p.success ? { data: p.data, body: n.body } : null;
}

export function listStreams(vault: Vault): StreamFrontmatter[] {
  const out: StreamFrontmatter[] = [];
  for (const rel of vault.list(STREAMS_DIR, { ext: '.md' })) {
    if (!isStreamNote(rel)) continue;
    const n = vault.readNoteOrNull(rel);
    if (!n) continue;
    const slug = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const p = StreamFrontmatter.safeParse({ ...n.data, slug });
    if (p.success) out.push(p.data);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export interface NewStream {
  slug?: string;
  name: string;
  problem: string;
  customers: string;
  outcome_metric: string;
  owner_team: string;
  error_budget?: number;
  runbook?: string;
  repo_path?: string;
}

/** Create `Streams/<slug>.md`. Returns the slug actually used — a clash gets `-2`, `-3`, … rather than clobbering. */
export function createStream(vault: Vault, s: NewStream, by: string): string {
  let slug = s.slug ? streamSlug(s.slug) : streamSlug(s.name);
  if (vault.exists(streamPath(slug))) {
    let n = 2;
    while (vault.exists(streamPath(`${slug}-${n}`))) n++;
    slug = `${slug}-${n}`;
  }
  const data = StreamFrontmatter.parse({
    slug, name: s.name, problem: s.problem, customers: s.customers, outcome_metric: s.outcome_metric,
    owner_team: s.owner_team, error_budget: s.error_budget ?? 4, runbook: s.runbook ?? '',
    repo_path: s.repo_path ?? workspacePath(slug), status: 'active', created: nowIso(),
  });
  const body = [
    `# ${s.name}`, '',
    '## Problem', '', s.problem.trim(), '',
    '## Customers', '', s.customers.trim(), '',
    '## Outcome metric', '', s.outcome_metric.trim(), '',
    '## Runbook', '', (s.runbook ?? '').trim() || `How to run, deploy and roll back this stream. Code lives in \`${data.repo_path}\`; CI is \`${data.repo_path}/cubicle-ci.yaml\`.`, '',
    '## Error budget', '', `${data.error_budget} incident-hours a week. When it is spent the division plan prioritises reliability work before new features.`, '',
  ].join('\n');
  vault.writeText(streamPath(slug), stringifyNote(data as Record<string, unknown>, body), by);
  return slug;
}

// ---------- error budgets (owner's operating model §23) ----------

/** The default window the error budget is measured over: one weekly cycle (operating model §23). */
export const BUDGET_WINDOW_MS = 7 * 24 * 3600_000;

/**
 * Incident-hours spent on a stream since `since`. A recovered incident contributes the time between
 * `incident.opened` and `incident.recovered`; one still open contributes the time it has been open so far,
 * because a budget that only moves after the fire is out tells you nothing while you are deciding.
 */
export function budgetSpentHours(vault: Vault, slug: string, since?: string): number {
  const from = since ?? new Date(Date.now() - BUDGET_WINDOW_MS).toISOString();
  const opened = vault.events.query({ types: ['incident.opened'], from, limit: 2000 }).filter((e) => e.payload.stream === slug);
  if (!opened.length) return 0;
  const recovered = new Map<string, CubicleEvent>();
  for (const e of vault.events.query({ types: ['incident.recovered'], from, limit: 2000 })) if (e.job) recovered.set(e.job, e);
  let hours = 0;
  for (const o of opened) {
    const end = o.job ? recovered.get(o.job) : undefined;
    const endMs = end ? Date.parse(end.ts) : Date.now();
    hours += Math.max(0, (endMs - Date.parse(o.ts)) / 3600_000);
  }
  return hours;
}

/**
 * One line per stream for a plan goal or the brief: how much of the budget is gone and what that means. The
 * division plan reads these, which is how "when the budget is spent the next plan is reliability work" (§23)
 * becomes something an agent acts on rather than a principle in a document.
 */
export function budgetLines(vault: Vault, team?: string, since?: string): string[] {
  return listStreams(vault)
    .filter((s) => s.status === 'active' && (!team || s.owner_team === team))
    .map((s) => {
      const spent = budgetSpentHours(vault, s.slug, since);
      const over = spent >= s.error_budget;
      return `${s.slug}: ${spent.toFixed(1)} h of ${s.error_budget} h error budget ${over ? 'SPENT' : 'used'}${over ? ' — this plan prioritises reliability work over new features (§23)' : ''}`;
    });
}
