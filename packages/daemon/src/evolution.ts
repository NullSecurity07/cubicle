import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  type Vault, type InboxFrontmatter, RoleFrontmatter, parseNote, stringifyNote, nowIso, createJob, listJobs, readJob, isValidRoleId, repoRoot, extractOwnerComments, idFromKey,
} from '@cubicle/core';

// ---------- desks ----------
export function loadDesks(): { id: string; x: number; y: number; room?: string }[] {
  try { return (YAML.parse(readFileSync(path.join(repoRoot(), 'config', 'world', 'desks.yaml'), 'utf8')) as { desks: { id: string; x: number; y: number; room?: string }[] }).desks; }
  catch { return Array.from({ length: 8 }, (_, i) => ({ id: `cubicle_${i + 1}`, x: 8 + i * 6, y: 10 })); }
}

export function activeRoles(vault: Vault): RoleFrontmatter[] {
  return vault.list('Roles', { ext: '.md' }).filter((r) => !r.includes('/archive/')).flatMap((rel) => { const n = vault.readNoteOrNull(rel); const p = n && RoleFrontmatter.safeParse(n.data); return p && p.success ? [p.data] : []; });
}

export function freeDesk(vault: Vault): string | null {
  const used = new Set(activeRoles(vault).filter((r) => r.active).map((r) => r.desk));
  return loadDesks().find((d) => !d.room && !used.has(d.id))?.id ?? null;
}

// ---------- hire / fire (spec §9.5) ----------
function fencedCharter(body: string): string | null {
  const m = body.match(/```(?:markdown|md)?\s*\n(---\n[\s\S]*?)\n```/);
  return m ? m[1] + '\n' : null;
}

/** Apply an approved hire: validate the charter, cap headcount, assign a desk, write Roles/<role>.md, emit role.hired. */
export async function applyHire(vault: Vault, note: { path: string; data: InboxFrontmatter; body: string }, onHired?: (role: string) => void, opts: { autoApproved?: boolean } = {}): Promise<string> {
  const c = vault.constitution();
  const charter = fencedCharter(note.body);
  if (!charter) return 'no fenced charter (```markdown … ```) in the proposal';
  const raw = parseNote(charter).data as Record<string, unknown>;
  // hired/desk/sprite are assigned here; a CEO-drafted charter need not guess them.
  const parsed = RoleFrontmatter.safeParse({ hired: '', sprite: String(raw.role ?? ''), desk: '', active: true, ...raw });
  if (!parsed.success) return `charter frontmatter invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  const role = parsed.data;
  if (opts.autoApproved) {
    // Under auto_approve_hire the new role may only use tools some existing charter already has (no privilege escalation without the owner).
    const known = new Set(activeRoles(vault).flatMap((r) => r.tools));
    const novel = role.tools.filter((t) => !known.has(t) && ![...known].some((k) => k.endsWith('.*') && t.startsWith(k.slice(0, -1))));
    if (novel.length) return `auto-approved hires may not introduce tools no current role has (${novel.join(', ')}); the owner must approve`;
    if (Object.values(role.approval_overrides).length) return 'auto-approved hires may not set approval overrides; the owner must approve';
  }
  if (!isValidRoleId(role.role)) return `invalid role id ${role.role}`;
  if (vault.exists(`Roles/${role.role}.md`)) return `role ${role.role} already exists`;
  const linked = [...new Set((note.body.match(/\[\[(job_[^\]|]+)/g) ?? []).map((m) => m.slice(2)))];
  const justified = linked.filter((id) => { const j = readJob(vault, id); return !!j && (['blocked', 'failed'].includes(j.data.status) || j.data.attempt > 1); });
  if (justified.length < 2) return `hire needs links to at least 2 distinct blocked, failed or retried jobs (found ${justified.length} of ${linked.length} linked)`;
  const active = activeRoles(vault).filter((r) => r.active).length;
  if (active >= c.max_roles) return `max_roles (${c.max_roles}) reached`;
  const desk = freeDesk(vault);
  if (!desk) return 'no free desk';
  const data = { ...role, active: true, hired: nowIso(), desk, sprite: role.sprite || role.role };
  vault.writeText(`Roles/${role.role}.md`, stringifyNote(data, parseNote(charter).body), 'daemon', { job: note.data.job ?? null });
  if (!vault.exists(`Messages/${role.role}.md`)) vault.writeText(`Messages/${role.role}.md`, `# Messages for ${role.role}\n\nColleagues append sections here; the harness includes unread ones in context.\n`, 'daemon');
  vault.events.emit({ type: 'role.hired', agent: 'daemon', job: note.data.job ?? null, payload: { role: role.role, display: role.display, desk, sprite: data.sprite, proposal: note.data.id } });
  onHired?.(role.role);
  return `hired ${role.role} (${role.display}) at ${desk}`;
}

/** Apply an approved fire: deactivate, archive the charter, emit role.fired. Founding roles can be fired too — the owner decided. */
export async function applyFire(vault: Vault, note: { path: string; data: InboxFrontmatter; body: string }, onFired?: (role: string) => void): Promise<string> {
  if (note.data.from !== 'ceo' && note.data.from !== 'owner') return `only the CEO (or the owner) may file fire proposals (this one is from ${note.data.from})`;
  const target = note.data.target?.match(/^Roles\/([a-z0-9_-]+)\.md$/)?.[1] ?? note.body.match(/role:\s*([a-z0-9_-]+)/)?.[1];
  if (!target || !isValidRoleId(target)) return 'fire proposal must set target: Roles/<role>.md';
  const rel = `Roles/${target}.md`;
  const n = vault.readNoteOrNull(rel);
  if (!n) return `no such role ${target}`;
  if (target === 'ceo') return 'the CEO cannot be fired (it owns the heartbeat); edit its charter instead';
  vault.writeText(rel, stringifyNote({ ...n.data, active: false, fired: nowIso() }, n.body), 'daemon', { job: note.data.job ?? null });
  vault.move(rel, `Roles/archive/${target}-${nowIso().slice(0, 10)}.md`, 'daemon');
  for (const j of listJobs(vault, { assigned: target, status: ['queued', 'blocked', 'running'] })) vault.updateNote(`Jobs/${j.id}.md`, (x) => ({ data: { ...x.data, status: 'cancelled', updated: nowIso() }, body: x.body }), 'daemon'); // running jobs stop at their next tool step
  vault.events.emit({ type: 'role.fired', agent: 'daemon', job: note.data.job ?? null, payload: { role: target, proposal: note.data.id } });
  onFired?.(target);
  return `fired ${target}; charter archived, open jobs cancelled`;
}

// ---------- lessons (spec §9.1): appended by the harness from finish.lessons[] (packages/harness/src/loop.ts) ----------

// ---------- charter compression (spec §9.2) ----------
export const CHARTER_COMPRESSION_EVERY = 7;

/** Enqueue cto.compress_charters when 7 heartbeats completed since the last compression job. */
export function maybeEnqueueCharterCompression(vault: Vault): string | null {
  const heartbeats = vault.events.count('heartbeat.completed');
  if (heartbeats === 0 || heartbeats % CHARTER_COMPRESSION_EVERY !== 0) return null;
  const marker = `compress-${heartbeats}`;
  const id = idFromKey('job', marker);
  if (listJobs(vault).some((j) => j.id === id)) return null;
  const roles = activeRoles(vault).filter((r) => r.active).map((r) => r.role);
  return createJob(vault, {
    id, type: 'cto.compress_charters', title: `Compress charters after ${heartbeats} heartbeats`, assigned: 'cto', priority: 3,
    goal: `Every ${CHARTER_COMPRESSION_EVERY} heartbeats the CTO tightens the role charters from what the company learned.\n\nDo: (1) vault.read Memory/lessons.md and every Roles/<role>.md for ${roles.join(', ')}; (2) for each role whose charter should change, file ONE proposal.create with kind=charter_change, target=Roles/<role>.md, a title naming the role, and a body that contains "## Proposed content" followed by the COMPLETE new charter note (frontmatter + body) inside a \`\`\`markdown fence — keep the frontmatter identical except tools/approval_overrides if a lesson justifies it, and make the body shorter, not longer; (3) skip roles with nothing to change; (4) finish with a one-paragraph summary listing the proposals.`,
  }, 'daemon');
}

// ---------- experiments (spec §9.4) ----------
export interface ExperimentNote { path: string; id: string; status: string; review_date?: string; owner?: string; title?: string; metric?: string }

export function listExperiments(vault: Vault): ExperimentNote[] {
  return vault.list('Experiments', { ext: '.md' }).filter((r) => !r.endsWith('_template.md') && !r.startsWith('Experiments/posts/')).flatMap((rel) => {
    const n = vault.readNoteOrNull(rel); if (!n) return [];
    const d = n.data as Record<string, unknown>;
    return [{ path: rel, id: String(d.id ?? rel), status: String(d.status ?? 'proposed'), review_date: d.review_date ? String(d.review_date) : undefined, owner: d.owner ? String(d.owner) : undefined, title: d.title ? String(d.title) : undefined, metric: d.metric ? String(d.metric) : undefined }];
  });
}

/** On each tick: running experiments past their review date get a COO judgement job (once). */
export function enqueueExperimentReviews(vault: Vault, now = new Date()): string[] {
  const out: string[] = [];
  for (const e of listExperiments(vault)) {
    if (e.status !== 'running' || !e.review_date) continue;
    if (Date.parse(e.review_date) > now.getTime()) continue;
    const prior = listJobs(vault).filter((j) => j.type === 'coo.verify' && (j.links ?? []).includes(`[[${e.path.replace(/\.md$/, '')}]]`));
    if (prior.some((j) => ['queued', 'running', 'blocked'].includes(j.status))) continue;
    const id = idFromKey('job', `judge:${e.path}:${prior.length}`); // a failed/cancelled judgement gets a fresh one
    createJob(vault, { id, type: 'coo.verify', title: `Judge experiment: ${e.title ?? e.id}`, assigned: 'coo', priority: 2, goal: `Experiment [[${e.path.replace(/\.md$/, '')}]] reached its review date (${e.review_date}). Read it and Metrics/daily.md, decide won | lost | inconclusive from the evidence, then vault.write the experiment note with status set accordingly, the result filled in, and a short ## Verdict. Append one lesson via finish.lessons. Do not invent numbers.`, links: [`[[${e.path.replace(/\.md$/, '')}]]`] }, 'daemon');
    out.push(id);
  }
  return out;
}

// ---------- owner feedback (spec §9.6) ----------
export interface OwnerFeedback { role: string; source: string; text: string }

/**
 * %%cubicle: …%% comments in files the owner edited since `since`, attributed to the note's author role; plus owner_preferences
 * feedback and decision ratings. Provenance: a comment counts as the owner's only if it was NOT present in the last version the
 * system wrote (recorded at write time; git HEAD as fallback) — text that arrived through email, scraping or an LLM is ignored.
 */
export function collectOwnerFeedback(vault: Vault, since?: string): OwnerFeedback[] {
  const out: OwnerFeedback[] = [];
  const seen = new Set<string>();
  for (const e of vault.events.query({ types: ['owner.edited'], from: since, limit: 500 })) {
    const rel = String(e.payload.path);
    if (seen.has(rel) || e.payload.deleted) continue;
    seen.add(rel);
    const text = vault.readTextOrNull(rel);
    if (!text) continue;
    const prior = new Set(vault.writtenComments(rel) ?? extractOwnerComments(gitHead(vault, rel) ?? ''));
    const comments = extractOwnerComments(text).filter((c) => !prior.has(c));
    if (!comments.length) continue;
    const d = parseNote(text).data as Record<string, unknown>;
    const byName = rel.match(/^(?:Roles|Messages)\/([a-z0-9_-]+)\.md$/)?.[1];
    const role = String(byName ?? d.assigned ?? d.decided_by ?? d.from ?? d.by ?? d.author ?? d.owner ?? (rel.startsWith('Site/') ? 'engineer' : rel.startsWith('Customers/') || rel.startsWith('Experiments/') ? 'head_of_growth' : rel.startsWith('Plans/') ? 'cto' : 'ceo'));
    for (const c of comments) out.push({ role, source: rel, text: c });
  }
  for (const f of vault.ownerPreferences().feedback) out.push({ role: 'ceo', source: 'Memory/owner_preferences.md', text: f });
  for (const rel of vault.list('Decisions', { ext: '.md' })) {
    const d = vault.readNoteOrNull(rel)?.data as { owner_rating?: string; decided_by?: string; rating_seen?: string } | undefined;
    if (d?.owner_rating === 'down' && !d.rating_seen) {
      out.push({ role: String(d.decided_by ?? 'ceo'), source: rel, text: `the owner rated this decision down` });
      try { vault.updateNote(rel, (n) => ({ data: { ...n.data, rating_seen: nowIso() }, body: n.body }), 'daemon'); } catch { /* keep going */ }
    }
  }
  return out;
}

function gitHead(vault: Vault, rel: string): string | null {
  try { const { execFileSync } = require_cp(); return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: vault.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}
import * as cp from 'node:child_process';
function require_cp() { return cp; }

export function feedbackFor(all: OwnerFeedback[], role: string): OwnerFeedback[] {
  return all.filter((f) => f.role === role || (role === 'ceo' && f.source === 'Memory/owner_preferences.md'));
}
