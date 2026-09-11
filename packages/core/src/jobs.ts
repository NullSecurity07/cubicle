import { JobFrontmatter, type JobStatus } from './schemas.js';
import { makeId, nowIso } from './fs.js';
import type { Vault } from './vault.js';
import { stringifyNote } from './frontmatter.js';
import { renderResearchRequest, type ResearchRequest } from './research.js';

export interface NewJob {
  type: string;
  title: string;
  assigned: string;
  goal: string;
  priority?: number;
  depends_on?: string[];
  privacy?: 'cloud' | 'local';
  runs_on?: 'laptop' | 'any';
  links?: string[];
  parent?: string;
  max_attempts?: number;
  id?: string;
  team?: string;
  owner_role?: string;
  for?: string;
  done_when?: string;
  research?: ResearchRequest;
  research_slug?: string;
}

export function jobPath(id: string): string {
  return `Jobs/${id}.md`;
}

/** Create a queued job note. `by` is the actor (role id or daemon). */
export function createJob(vault: Vault, job: NewJob, by: string): string {
  let id = job.id ?? makeId('job');
  if (job.id) {
    if (vault.exists(jobPath(id))) return id; // deterministic id already created (idempotent replay)
  } else {
    while (vault.exists(jobPath(id))) id = makeId('job');
  }
  const ts = nowIso();
  const data = JobFrontmatter.parse({
    id, type: job.type, title: job.title, assigned: job.assigned,
    status: 'queued', priority: job.priority ?? 3, created: ts, updated: ts,
    attempt: 1, max_attempts: job.max_attempts ?? 3, depends_on: job.depends_on ?? [],
    approval: 'none', checkpoint_step: 0, side_effects_done: [], links: job.links ?? [],
    privacy: job.privacy ?? 'cloud', runs_on: job.runs_on ?? 'laptop', parent: job.parent,
    team: job.team, owner_role: job.owner_role, for: job.for, done_when: job.done_when,
    research: job.research, research_slug: job.research_slug,
  });
  let body = `## Goal\n\n${job.goal.trim()}\n\n`;
  if (job.research) body += `${renderResearchRequest(job.research)}\n`;
  if (job.done_when) body += `## Done when\n\n${job.done_when}\n\n`;
  body += `## Plan\n\n## Checkpoint log\n\n## Result\n`;
  vault.writeText(jobPath(id), stringifyNote(data as Record<string, unknown>, body), by, { job: id });
  vault.events.emit({ type: 'job.queued', agent: by, job: id, payload: { type: job.type, title: job.title, assigned: job.assigned, priority: data.priority } });
  return id;
}

const warned = new Map<string, string>();
function warnOnce(vault: Vault, rel: string, reason: string, extra: Record<string, unknown> = {}): void {
  const sha = vault.currentSha(rel) ?? '';
  const key = `${rel}::${reason}`;
  if (warned.get(key) === sha) return;
  warned.set(key, sha);
  vault.events.emit({ type: 'daemon.warning', payload: { path: rel, reason, ...extra } });
}

/** `Jobs/_template.md` and the generated `Jobs/queue.md` are not job notes and are never rewritten. */
function isJobNote(rel: string): boolean {
  const stem = jobStem(rel);
  return stem !== 'queue' && !stem.startsWith('_');
}

function jobStem(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

/**
 * The filename is authoritative for a job's id (spec §11: the owner copies the template and renames it).
 * Reconciles a mismatched `id` and blank template timestamps back into the note so `readJob` finds it.
 */
function reconcile(vault: Vault, rel: string, raw: Record<string, unknown>, parsed: JobFrontmatter): JobFrontmatter {
  if (!isJobNote(rel)) return parsed;
  const stem = jobStem(rel);
  const idChanged = parsed.id !== stem;
  const stamped = raw.created !== parsed.created || raw.updated !== parsed.updated;
  if (!idChanged && !stamped) return parsed;
  if (idChanged) warnOnce(vault, rel, 'job id reconciled to filename', { from: parsed.id, to: stem });
  const data = { ...parsed, id: stem };
  // This write touches machine-owned frontmatter only, so it must not adopt the owner's %%cubicle:%%
  // comments as a system baseline — they would then never reach the role as feedback.
  const baseline = vault.writtenComments(rel);
  try {
    vault.updateNote(rel, (n) => ({ data: { ...n.data, id: stem, created: data.created, updated: data.updated }, body: n.body }), 'daemon', { job: stem });
  } catch {
    return data; // a concurrent owner edit; the in-memory view still uses the filename
  }
  vault.setWrittenComments(rel, baseline);
  return data;
}

export function readJob(vault: Vault, id: string): { data: JobFrontmatter; body: string } | null {
  const rel = jobPath(id);
  const note = vault.readNoteOrNull(rel);
  if (!note) return null;
  const parsed = JobFrontmatter.safeParse(note.data);
  if (!parsed.success) return null;
  return { data: reconcile(vault, rel, note.data, parsed.data), body: note.body };
}

export function listJobs(vault: Vault, filter: { status?: JobStatus | JobStatus[]; assigned?: string } = {}): JobFrontmatter[] {
  const out: JobFrontmatter[] = [];
  for (const rel of vault.list('Jobs', { ext: '.md' })) {
    if (!isJobNote(rel)) continue;
    const note = vault.readNoteOrNull(rel);
    if (!note) continue;
    const parsed = JobFrontmatter.safeParse(note.data);
    if (!parsed.success) { warnOnce(vault, rel, 'malformed job frontmatter; skipped', { issue: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }); continue; }
    const j = reconcile(vault, rel, note.data, parsed.data);
    if (filter.status && !(Array.isArray(filter.status) ? filter.status : [filter.status]).includes(j.status)) continue;
    if (filter.assigned && j.assigned !== filter.assigned) continue;
    out.push(j);
  }
  return out.sort((a, b) => a.priority - b.priority || a.created.localeCompare(b.created));
}

/** Patch job frontmatter fields (and optionally append to a section) atomically. */
export function updateJob(vault: Vault, id: string, patch: Partial<JobFrontmatter>, by: string, appendLog?: string): JobFrontmatter {
  const note = vault.updateNote<Record<string, unknown>>(jobPath(id), (n) => {
    const data = { ...n.data, ...patch, updated: nowIso() };
    let body = n.body;
    if (appendLog) body = appendToSection(body, '## Checkpoint log', appendLog);
    return { data, body };
  }, by, { job: id });
  return JobFrontmatter.parse(note.data);
}

/**
 * Cancel a job and say so — the one way anything outside the harness loop cancels (spec §11). A job cancelled
 * while queued or blocked is never picked up again, so a bare `updateJob(..., { status: 'cancelled' })` left the
 * office showing it as open forever and the event log with no trace of who stopped it or why.
 *
 * A *running* job is the exception: its loop notices the flag at its next tool step and emits `job.cancelled`
 * itself, with the step it actually stopped on. Emitting here as well produced two events for one stop — the
 * office tolerated it (the second just re-parks the sprite) but the log double-counted every `cubicle job
 * cancel` of a running job. The flag is still written, which is what stops the work; only the announcement is
 * left to the loop, which is the one that knows when the job really came to rest (M3).
 *
 * Returns false without touching anything when the job is unknown or already finished: a done, failed or
 * cancelled job has no work left to stop, and re-cancelling would emit a second event for the same stop.
 */
export function cancelJob(vault: Vault, id: string, by: string, reason: string): boolean {
  const cur = readJob(vault, id);
  if (!cur || ['done', 'failed', 'cancelled'].includes(cur.data.status)) return false;
  updateJob(vault, id, { status: 'cancelled' }, by, `- ${nowIso()}: cancelled (${reason})`);
  if (cur.data.status !== 'running') vault.events.emit({ type: 'job.cancelled', agent: by, job: id, payload: { at_step: cur.data.checkpoint_step, reason } });
  return true;
}

/** Append a line under a `## Heading` (creating it before `## Result` or at the end). */
export function appendToSection(body: string, heading: string, line: string): string {
  const idx = body.indexOf(heading);
  const entry = line.endsWith('\n') ? line : line + '\n';
  if (idx < 0) return body.trimEnd() + `\n\n${heading}\n\n${entry}`;
  const after = idx + heading.length;
  const next = body.indexOf('\n## ', after);
  const end = next < 0 ? body.length : next;
  const section = body.slice(after, end).replace(/\s+$/, '');
  return body.slice(0, after) + section + '\n' + entry + (next < 0 ? '' : '\n' + body.slice(end + 1));
}

export function setSection(body: string, heading: string, content: string): string {
  const idx = body.indexOf(heading);
  const block = `${heading}\n\n${content.trim()}\n`;
  if (idx < 0) return body.trimEnd() + '\n\n' + block;
  const after = idx + heading.length;
  const next = body.indexOf('\n## ', after);
  return body.slice(0, idx) + block + (next < 0 ? '' : body.slice(next + 1));
}

const OPEN: JobStatus[] = ['queued', 'running', 'blocked', 'in_review'];

/** Direct children (jobs whose `parent` is `id`). */
export function childrenOf(vault: Vault, id: string): JobFrontmatter[] {
  return listJobs(vault).filter((j) => j.parent === id);
}

/** 'empty' (no children) | 'done' (all done) | 'failed' (any failed/cancelled and none open) | 'open'. */
export function rollup(vault: Vault, id: string): 'done' | 'failed' | 'open' | 'empty' {
  const kids = childrenOf(vault, id);
  if (!kids.length) return 'empty';
  if (kids.some((j) => OPEN.includes(j.status))) return 'open';
  if (kids.some((j) => j.status === 'failed' || j.status === 'cancelled')) return 'failed';
  return 'done';
}

/** Every open job a lead is accountable for (owner_role), including its own. */
export function openSubtree(vault: Vault, role: string): JobFrontmatter[] {
  return listJobs(vault, { status: OPEN }).filter((j) => j.owner_role === role);
}
