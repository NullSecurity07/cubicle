import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import {
  type Vault, type InboxFrontmatter, RoleFrontmatter, parseNote, stringifyNote, nowIso, createJob, listJobs, readJob, updateJob, cancelJob, isValidRoleId, repoRoot, extractOwnerComments, idFromKey,
  loadOrg, leadOf, teamOf, openSubtree, expandProcess, unifiedDiff, HEARTBEAT_WAKE_AREAS,
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

// ---------- reorg (spec §2) ----------

/** Apply an approved reorg: `teams:` map from the fenced yaml; validated against the constitution and the org. */
export async function applyReorg(vault: Vault, note: { path: string; data: InboxFrontmatter; body: string }): Promise<string> {
  const fence = note.body.match(/```ya?ml\s*\n([\s\S]*?)```/)?.[1];
  if (!fence) return 'no ```yaml fence with teams:';
  let parsed: { teams?: Record<string, { lead?: string; members?: string[] }> };
  try { parsed = (YAML.parse(fence) ?? {}) as { teams?: Record<string, { lead?: string; members?: string[] }> }; }
  catch (err) { return `reorg yaml does not parse: ${(err as Error).message}`; }
  if (!parsed.teams || !Object.keys(parsed.teams).length) return 'teams: map is empty';
  const org = loadOrg(vault);
  const c = vault.constitution();
  const seen = new Map<string, string>();
  for (const [id, t] of Object.entries(parsed.teams)) {
    if (!org.teams[id]) return `unknown team ${id} (create it as Teams/${id}.md first)`;
    if (!t.lead || !org.roles[t.lead]) return `team ${id} needs an active lead`;
    const members = t.members ?? [];
    for (const m of members) { if (!org.roles[m]) return `unknown role ${m}`; if (m === t.lead) return `${m} cannot be both lead and member of ${id}`; }
    if (members.length + 1 > c.max_team_size) return `team ${id} would exceed max_team_size (${c.max_team_size})`;
    for (const r of [t.lead, ...members]) { const prev = seen.get(r); if (prev && prev !== id) return `${r} would be in two teams (${prev}, ${id})`; seen.set(r, id); }
  }
  // untouched teams keep their members; a role moved into a listed team leaves its old one
  const moved = new Set(seen.keys());
  // An unlisted team must not silently lose its lead because that lead moved into a listed team.
  for (const [id, t] of Object.entries(org.teams)) if (!parsed.teams[id] && moved.has(t.lead)) return `team ${id} would lose its lead`;
  const nextByTeam: Record<string, { lead: string; members: string[] }> = {};
  for (const [id, t] of Object.entries(org.teams)) {
    const next = parsed.teams[id] ? { lead: parsed.teams[id].lead!, members: parsed.teams[id].members ?? [] } : { lead: t.lead, members: t.members.filter((m) => !moved.has(m)) };
    if (!org.roles[next.lead]) return `team ${id} would lose its lead`;
    nextByTeam[id] = next;
  }
  // F6: a reorg must not leave an active, non-CEO role belonging to no team at all — computed against every
  // team's final membership (listed and derived-unlisted) before anything is written.
  const placed = new Set(Object.values(nextByTeam).flatMap((t) => [t.lead, ...t.members]));
  for (const r of Object.keys(org.roles)) {
    if (r === 'ceo' || placed.has(r)) continue;
    return `role ${r} would belong to no team`;
  }
  for (const [id, next] of Object.entries(nextByTeam)) {
    const n = vault.readNoteOrNull(`Teams/${id}.md`)!;
    vault.writeText(`Teams/${id}.md`, stringifyNote({ ...n.data, ...next }, n.body), 'daemon', { job: note.data.job ?? null });
    for (const r of [next.lead, ...next.members]) {
      const rn = vault.readNoteOrNull(`Roles/${r}.md`); if (!rn) continue;
      const reports_to = r === next.lead ? (r === 'ceo' ? 'owner' : 'ceo') : next.lead;
      if (rn.data.team !== id || rn.data.reports_to !== reports_to) vault.writeText(`Roles/${r}.md`, stringifyNote({ ...rn.data, team: id, reports_to }, rn.body), 'daemon', { job: note.data.job ?? null });
    }
  }
  vault.events.emit({ type: 'org.changed', agent: 'daemon', job: note.data.job ?? null, payload: { reason: 'reorg', proposal: note.data.id, teams: Object.keys(parsed.teams) } });
  return `applied reorg to ${Object.keys(parsed.teams).join(', ')}`;
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
  // F2: a charter naming a team joins it — otherwise reportsOf(lead) never sees the hire and the lead can't
  // schedule it. Refuse the hire outright rather than silently exceeding max_team_size.
  const org = loadOrg(vault);
  const team = role.team ? org.teams[role.team] : undefined;
  if (role.team && !team) return `unknown team ${role.team} (create it as Teams/${role.team}.md first)`;
  if (team && team.members.length + 2 > c.max_team_size) return `team ${role.team} would exceed max_team_size (${c.max_team_size})`;
  const reports_to = role.reports_to ?? team?.lead;
  const data = { ...role, active: true, hired: nowIso(), desk, sprite: role.sprite || role.role, ...(reports_to ? { reports_to } : {}) };
  vault.writeText(`Roles/${role.role}.md`, stringifyNote(data, parseNote(charter).body), 'daemon', { job: note.data.job ?? null });
  if (team) {
    const teamNote = vault.readNoteOrNull(`Teams/${role.team!}.md`)!;
    const members = [...new Set([...(teamNote.data.members as string[] ?? []), role.role])];
    vault.writeText(`Teams/${role.team!}.md`, stringifyNote({ ...teamNote.data, members }, teamNote.body), 'daemon', { job: note.data.job ?? null });
    vault.events.emit({ type: 'org.changed', agent: 'daemon', job: note.data.job ?? null, payload: { reason: 'hire', role: role.role, team: role.team } });
  }
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
  const org = loadOrg(vault);
  const manager = leadOf(org, target) ?? 'ceo';
  const managerRole = manager === 'owner' ? 'ceo' : manager;
  vault.writeText(rel, stringifyNote({ ...n.data, active: false, fired: nowIso() }, n.body), 'daemon', { job: note.data.job ?? null });
  vault.move(rel, `Roles/archive/${target}-${nowIso().slice(0, 10)}.md`, 'daemon');
  // Gate jobs (qa.review/coo.verify/requester.review) must not be cancelled — that would strand the parent
  // in_review forever (F1) — so they always go to the manager. A work job cannot go to the manager blindly: a
  // lead/manager's charter rarely carries the tools (shell.run, git.*, deploy.*, …) a specialist's work needs, so
  // a reassigned engineer.ship would just fail or exhaust its budget and strand its dependents again. Instead try
  // a team-mate whose charter's tool families (compared by prefix before the dot, so `shell.*` covers `shell.run`)
  // cover every family the fired role's charter had; only if none qualifies is the job cancelled — and then any
  // job still depending on it is blocked on the owner instead of waiting on a cancelled dependency forever.
  const team = teamOf(org, target);
  const firedFamilies = new Set(((n.data.tools as string[] | undefined) ?? []).map((t) => t.split('.')[0]));
  const standIn = team
    ? ([team.lead, ...team.members].filter((r) => r !== target).find((r) => {
        const candidateFamilies = new Set((org.roles[r]?.tools ?? []).map((t) => t.split('.')[0]));
        return [...firedFamilies].every((f) => candidateFamilies.has(f));
      }) ?? null)
    : null;
  const allJobs = listJobs(vault);
  for (const j of allJobs.filter((x) => x.assigned === target && ['queued', 'blocked', 'running'].includes(x.status))) {
    const isGate = /\.(review|verify)$/.test(j.type) && !!j.parent;
    if (isGate) {
      updateJob(vault, j.id, { assigned: managerRole }, 'daemon', `- ${nowIso()}: ${target} was fired; job reassigned to ${managerRole}`);
    } else if (standIn) {
      updateJob(vault, j.id, { assigned: standIn }, 'daemon', `- ${nowIso()}: ${target} was fired; job reassigned to ${standIn} (tools cover it)`);
    } else {
      cancelJob(vault, j.id, 'daemon', `role ${target} left; no team-mate's tools cover it`); // running jobs stop at their next tool step
      for (const dep of allJobs.filter((y) => y.depends_on.includes(j.id) && !['done', 'failed', 'cancelled'].includes(y.status))) {
        updateJob(vault, dep.id, { status: 'blocked', blocked_on: { kind: 'owner', id: j.id, since: nowIso() } }, 'daemon', `- ${nowIso()}: dependency ${j.id} cancelled (role ${target} left); needs the owner`);
      }
    }
  }
  // Reassign everything the fired role was accountable for (owner_role) that it wasn't itself doing, to its manager.
  for (const j of openSubtree(vault, target)) if (j.assigned !== target) updateJob(vault, j.id, { owner_role: managerRole }, 'daemon', `- ${nowIso()}: owner ${target} left; now owned by ${managerRole}`);
  // If the fired role led a team, the manager is promoted to lead; otherwise just drop it from whichever team it was a member of.
  const led = Object.values(org.teams).find((t) => t.lead === target);
  if (led) {
    const tn = vault.readNoteOrNull(`Teams/${led.id}.md`)!;
    vault.writeText(`Teams/${led.id}.md`, stringifyNote({ ...tn.data, lead: managerRole, members: led.members.filter((m) => m !== target) }, tn.body), 'daemon');
  } else {
    for (const t of Object.values(org.teams)) {
      if (t.members.includes(target)) {
        const tn = vault.readNoteOrNull(`Teams/${t.id}.md`)!;
        vault.writeText(`Teams/${t.id}.md`, stringifyNote({ ...tn.data, members: t.members.filter((m) => m !== target) }, tn.body), 'daemon');
      }
    }
  }
  vault.events.emit({ type: 'org.changed', agent: 'daemon', job: note.data.job ?? null, payload: { reason: 'fire', role: target } });
  vault.events.emit({ type: 'role.fired', agent: 'daemon', job: note.data.job ?? null, payload: { role: target, proposal: note.data.id } });
  onFired?.(target);
  return `fired ${target}; charter archived, open jobs cancelled`;
}

// ---------- postmortems (spec §3) ----------

/** Two failures of the same job type since the last heartbeat → one postmortem research job for the CTO. */
export function maybeEnqueuePostmortem(vault: Vault): string | null {
  const since = vault.events.last('heartbeat.completed')?.ts;
  const failed = vault.events.query({ types: ['job.failed'], from: since }).filter((e) => e.job && !e.payload.requeued);
  const byType = new Map<string, string[]>();
  for (const e of failed) { const t = readJob(vault, e.job!)?.data.type; if (t) byType.set(t, [...(byType.get(t) ?? []), e.job!]); }
  for (const [type, jobs] of byType) {
    if (jobs.length < 2) continue;
    const title = `Postmortem: ${type} failed ${jobs.length}× this cycle`;
    if (listJobs(vault).some((j) => j.type === 'research' && j.title.startsWith(`Postmortem: ${type}`) && j.status !== 'cancelled' && (!since || j.created >= since))) continue;
    return createJob(vault, {
      type: 'research', title, assigned: 'research_analyst', priority: 2, team: 'research', owner_role: 'cto', for: 'cto',
      done_when: `Docs/postmortems/<date>-${type}.md exists with a root cause and one proposed change`,
      goal: `Root-cause ${jobs.length} failures of ${type}: ${jobs.map((j) => `[[${j}]]`).join(', ')}.\n\nDo: (1) vault.read each job note (Result, Checkpoint log, Review findings) and Memory/lessons.md; (2) if shell output is involved read the latest .cubicle/jobs observations via vault.read of the job note only (no shell); (3) vault.write Docs/postmortems/${nowIso().slice(0, 10)}-${type.replace(/\W/g, '_')}.md with: what happened, root cause, evidence, one proposed change (a charter line, a skill, or a gate criterion); (4) finish with a two-line summary.`,
    }, 'daemon');
  }
  return null;
}

// ---------- weekly review (spec §4) ----------

export const WEEKLY_REVIEW_EVERY = 7;

/** Every 7 heartbeats: expand Processes/weekly_review.md once and open a board meeting with all leads. */
export async function maybeEnqueueWeeklyReview(vault: Vault, openMeeting?: (agenda: string, participants: string[]) => Promise<string | null>): Promise<string[]> {
  const n = vault.events.count('heartbeat.completed');
  if (n === 0 || n % WEEKLY_REVIEW_EVERY !== 0) return [];
  const marker = `weekly-${n}`;
  if (listJobs(vault).some((j) => j.links.includes(`[[${marker}]]`))) return [];
  // `marker` is not a job id, so it must not be passed as `parent` (F9) — expandProcess threads it through
  // `links` instead, which is all this idempotency check reads.
  const ids = expandProcess(vault, 'weekly_review', `week ${n / WEEKLY_REVIEW_EVERY}`, { by: 'daemon', owner_role: 'ceo', marker });
  const org = loadOrg(vault);
  const leads = Object.values(org.teams).map((t) => t.lead).filter((l) => l !== 'ceo');
  if (openMeeting) await openMeeting(`Weekly review ${n / WEEKLY_REVIEW_EVERY}: what shipped, what failed, what each team does next; the COO proposes which team skills go company-wide.`, leads).catch(() => null);
  return ids;
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

/**
 * The `## Diff` block a `charter_change` proposal owes the owner: what its "## Proposed content" would actually
 * change in the charter on disk, as a unified diff of the two bodies (frontmatter is carried over by the
 * dispatcher, so diffing it would only show noise).
 *
 * Always returns a section, never null. "Nothing to diff" is itself worth telling the owner — a proposal that
 * would change nothing, or one that forgot its fence, is a proposal not worth approving — and it doubles as the
 * marker that stops the dispatcher recomputing this on every tick for as long as the note sits unapproved.
 */
export function charterDiffSection(vault: Vault, target: string, proposedContent: string | null): string {
  const block = (text: string) => `## Diff\n\n${text}\n\n`;
  const current = vault.readNoteOrNull(target);
  if (!current) return block(`\`${target}\` does not exist, so there is nothing to compare. A charter_change may only edit an existing role.`);
  if (!proposedContent) return block('This proposal has no fenced "## Proposed content" charter, so there is nothing to compare.');
  let proposedBody: string;
  try { proposedBody = parseNote(proposedContent).body; } catch { return block('The proposed charter could not be parsed, so there is nothing to compare.'); }
  const diff = unifiedDiff(current.body, proposedBody, `${target} (current)`, `${target} (proposed)`).trim();
  return diff ? block('```diff\n' + diff + '\n```') : block('No change to the charter body; only the frontmatter or the formatting would differ.');
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

export const OWNER_PREFERENCES = 'Memory/owner_preferences.md';

/** Identity of a `feedback:` entry: sha1 of its trimmed text, so re-indenting or re-ordering the list is not a new entry. */
export function feedbackSha(text: string): string {
  return createHash('sha1').update(text.trim()).digest('hex');
}

function deliveredFeedbackShas(vault: Vault): Set<string> {
  return new Set(vault.events.query({ types: ['owner.feedback_delivered'] }).map((e) => String(e.payload.sha)));
}

/** The shas of the `feedback:` entries in `feedback` that come from the owner's preferences, in order. */
export function preferenceFeedbackShas(feedback: OwnerFeedback[]): string[] {
  return feedback.filter((f) => f.source === OWNER_PREFERENCES).map((f) => feedbackSha(f.text));
}

/**
 * Record that these `feedback:` entries have now been put in front of the CEO, so the next cycle leaves them out.
 *
 * Takes the shas gathered at the *start* of the cycle, not a fresh read: `Memory/` is not a heartbeat-wake area,
 * so an entry the owner adds mid-cycle is in no prompt this cycle. Re-reading here would mark it delivered
 * without ever having shown it, and `collectOwnerFeedback` would then filter it out of every future cycle — the
 * line would be lost for good, which is the very failure this machinery exists to prevent. Marking the gathered
 * shas instead keeps the entries available to a mid-cycle plan rewrite and re-delivers everything if the cycle
 * never finished. Returns how many entries it marked.
 */
export function markFeedbackDelivered(vault: Vault, shas: string[]): number {
  const already = deliveredFeedbackShas(vault);
  let n = 0;
  for (const sha of shas) {
    if (already.has(sha)) continue;
    already.add(sha);
    vault.events.emit({ type: 'owner.feedback_delivered', agent: 'ceo', payload: { sha, source: OWNER_PREFERENCES } });
    n++;
  }
  return n;
}

/**
 * Comments the owner typed while the daemon was down. The watcher starts with `ignoreInitial`, so nothing ever
 * replays those edits and `collectOwnerFeedback` — which reads only `owner.edited` events — would never see them.
 * This startup sweep compares each note's `%%cubicle: …%%` comments against the last version the system wrote
 * (git HEAD as the fallback) and emits one `owner.edited { offline: true }` per file that gained some, which is
 * exactly the shape the rest of the feedback path already consumes. Returns the paths it reported.
 */
export function collectOfflineOwnerComments(vault: Vault): string[] {
  const out: string[] = [];
  for (const { path: rel, added } of vault.commentsChangedSinceWritten()) {
    const area = rel.split('/')[0];
    vault.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: rel, area, deleted: false, offline: true, comments: added.length, wakes_heartbeat: HEARTBEAT_WAKE_AREAS.includes(area) } });
    out.push(rel);
  }
  return out;
}

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
  const alreadyDelivered = deliveredFeedbackShas(vault);
  for (const f of vault.ownerPreferences().feedback) {
    // An entry the owner typed once must not be repeated to the CEO every cycle for the rest of the company's
    // life; `owner.feedback_delivered` is the marker, and it lives in the event log so `cubicle rebuild` keeps it.
    if (alreadyDelivered.has(feedbackSha(f))) continue;
    out.push({ role: 'ceo', source: OWNER_PREFERENCES, text: f });
  }
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
