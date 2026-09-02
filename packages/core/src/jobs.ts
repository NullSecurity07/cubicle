import { JobFrontmatter, type JobStatus } from './schemas.js';
import { makeId, nowIso } from './fs.js';
import type { Vault } from './vault.js';
import { stringifyNote } from './frontmatter.js';

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
  });
  const body = `## Goal\n\n${job.goal.trim()}\n\n## Plan\n\n## Checkpoint log\n\n## Result\n`;
  vault.writeText(jobPath(id), stringifyNote(data as Record<string, unknown>, body), by, { job: id });
  vault.events.emit({ type: 'job.queued', agent: by, job: id, payload: { type: job.type, title: job.title, assigned: job.assigned, priority: data.priority } });
  return id;
}

const warned = new Map<string, string>();
function warnOnce(vault: Vault, rel: string, issue: string): void {
  const sha = vault.currentSha(rel) ?? '';
  if (warned.get(rel) === sha) return;
  warned.set(rel, sha);
  vault.events.emit({ type: 'daemon.warning', payload: { path: rel, reason: 'malformed job frontmatter; skipped', issue } });
}

export function readJob(vault: Vault, id: string): { data: JobFrontmatter; body: string } | null {
  const note = vault.readNoteOrNull(jobPath(id));
  if (!note) return null;
  const parsed = JobFrontmatter.safeParse(note.data);
  if (!parsed.success) return null;
  return { data: parsed.data, body: note.body };
}

export function listJobs(vault: Vault, filter: { status?: JobStatus | JobStatus[]; assigned?: string } = {}): JobFrontmatter[] {
  const out: JobFrontmatter[] = [];
  for (const rel of vault.list('Jobs', { ext: '.md' })) {
    if (rel.endsWith('/_template.md') || rel.endsWith('/queue.md')) continue;
    const note = vault.readNoteOrNull(rel);
    if (!note) continue;
    const parsed = JobFrontmatter.safeParse(note.data);
    if (!parsed.success) { warnOnce(vault, rel, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); continue; }
    const j = parsed.data;
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
