import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import {
  type Vault, type InboxFrontmatter, RoleFrontmatter, parseNote, stringifyNote, nowIso, createJob, listJobs, readJob, updateJob, cancelJob, isValidRoleId, repoRoot, extractOwnerComments, idFromKey,
  loadOrg, leadOf, teamOf, openSubtree, expandProcess, unifiedDiff, HEARTBEAT_WAKE_AREAS, researchLead, resolveRole, jobPath,
  RESEARCH_INDEX, upsertIndexRow, resultBlock, researchSlug, type ResearchRequest, type DeliveredResearch,
  readStream, budgetLines, listStreams, readFlags, expiredFlags,
} from '@cubicle/core';

// ---------- desks ----------
export interface DeskRow { id: string; x: number; y: number; room: string; floor: number; slot: 'fixed' | 'member' }
export function loadDesks(): DeskRow[] {
  try { return (YAML.parse(readFileSync(path.join(repoRoot(), 'config', 'world', 'desks.yaml'), 'utf8')) as { desks: DeskRow[] }).desks; }
  catch { return []; }
}

export function activeRoles(vault: Vault): RoleFrontmatter[] {
  return vault.list('Roles', { ext: '.md' }).filter((r) => !r.includes('/archive/')).flatMap((rel) => { const n = vault.readNoteOrNull(rel); const p = n && RoleFrontmatter.safeParse(n.data); return p && p.success ? [p.data] : []; });
}

/**
 * The desk a hire into `team` gets: a member desk in that team's room that no active role holds, preferring the
 * one named after the role (so re-hiring a fired specialist puts them back where they sat). No team, or a team
 * without a room, means no desk: the CEO's proposal must say which room the hire joins.
 */
export function freeDesk(vault: Vault, team?: string, roleId?: string): string | null {
  if (!team) return null;
  const room = loadOrg(vault).teams[team]?.room;
  if (!room) return null;
  const used = new Set(activeRoles(vault).filter((r) => r.active).map((r) => r.desk));
  const free = loadDesks().filter((d) => d.slot === 'member' && d.room === room && !used.has(d.id));
  return free.find((d) => d.id === roleId)?.id ?? free[0]?.id ?? null;
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
  // F2: a charter naming a team joins it — otherwise reportsOf(lead) never sees the hire and the lead can't
  // schedule it. Refuse the hire outright rather than silently exceeding max_team_size. B10: the team is also
  // what picks the desk, so a teamless charter has nowhere to sit and is refused before the desk lookup.
  const org = loadOrg(vault);
  if (!role.team) return 'a hire must name a team (team: <id>) so it gets a desk in that room';
  const team = org.teams[role.team];
  if (!team) return `unknown team ${role.team} (create it as Teams/${role.team}.md first)`;
  const desk = freeDesk(vault, role.team, role.role);
  if (!desk) return `no free desk in the ${role.team} room`;
  if (team.members.length + 2 > c.max_team_size) return `team ${role.team} would exceed max_team_size (${c.max_team_size})`;
  const reports_to = role.reports_to ?? team.lead;
  const data = { ...role, active: true, hired: nowIso(), desk, sprite: role.sprite || role.role, ...(reports_to ? { reports_to } : {}) };
  vault.writeText(`Roles/${role.role}.md`, stringifyNote(data, parseNote(charter).body), 'daemon', { job: note.data.job ?? null });
  const teamNote = vault.readNoteOrNull(`Teams/${role.team}.md`)!;
  const members = [...new Set([...(teamNote.data.members as string[] ?? []), role.role])];
  vault.writeText(`Teams/${role.team}.md`, stringifyNote({ ...teamNote.data, members }, teamNote.body), 'daemon', { job: note.data.job ?? null });
  vault.events.emit({ type: 'org.changed', agent: 'daemon', job: note.data.job ?? null, payload: { reason: 'hire', role: role.role, team: role.team } });
  if (!vault.exists(`Messages/${role.role}.md`)) vault.writeText(`Messages/${role.role}.md`, `# Messages for ${role.role}\n\nColleagues append sections here; the harness includes unread ones in context.\n`, 'daemon');
  vault.events.emit({ type: 'role.hired', agent: 'daemon', job: note.data.job ?? null, payload: { role: role.role, display: role.display, desk, sprite: data.sprite, team: role.team, reports_to, proposal: note.data.id } });
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
      type: 'research', title, assigned: researchLead(loadOrg(vault)) ?? 'research_analyst', priority: 2, team: 'research', owner_role: 'cto', for: 'cto',
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
  // §41 is computed, not written by an agent, so it is refreshed on the cadence rather than asked for in a job.
  // It sits before the marker check on purpose: the numbers should be current even on a repeat tick.
  try { vault.writeText('Metrics/research.md', renderResearchMetrics(researchMetrics(vault), new Date()), 'daemon', { generated: true }); } catch { /* a metrics page is never worth failing the review over */ }
  const marker = `weekly-${n}`;
  if (listJobs(vault).some((j) => j.links.includes(`[[${marker}]]`))) return [];
  const dora = writeEngineeringMetrics(vault);
  // `marker` is not a job id, so it must not be passed as `parent` (F9) — expandProcess threads it through
  // `links` instead, which is all this idempotency check reads.
  const ids = expandProcess(vault, 'weekly_review', `week ${n / WEEKLY_REVIEW_EVERY}`, { by: 'daemon', owner_role: 'ceo', marker });
  const org = loadOrg(vault);
  const leads = Object.values(org.teams).map((t) => t.lead).filter((l) => l !== 'ceo');
  if (openMeeting) await openMeeting(`Weekly review ${n / WEEKLY_REVIEW_EVERY}: what shipped, what failed, what each team does next; the COO proposes which team skills go company-wide. Engineering flow this week: ${dora.deploys} deploys, change failure rate ${dora.change_failure_rate === null ? 'n/a' : `${(dora.change_failure_rate * 100).toFixed(0)} %`} (Metrics/engineering.md).`, leads).catch(() => null);
  return ids;
}

// ---------- engineering metrics (owner's operating model §31) ----------

export interface Dora {
  lead_time_h: number | null;
  deploys_per_week: number;
  change_failure_rate: number | null;
  time_to_restore_h: number | null;
  deploys: number;
  failures: number;
  incidents: number;
  window_days: number;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The four flow measures §31 asks for, computed from the event log — never from anything a role could inflate.
 * Lead time is `job.queued` → the `deploy.done` of that same job; deployment frequency counts live deploys;
 * change failure rate counts rollbacks and returned ships against deploys; time to restore is the incident
 * clock. A measure with no data in the window is null, not zero: "we deployed nothing" and "we restore
 * instantly" must not look the same.
 */
export function computeDora(vault: Vault, since: string, until = nowIso()): Dora {
  const deploys = vault.events.query({ types: ['deploy.done'], from: since, to: until, limit: 5000 }).filter((e) => (e.payload.stage ?? 'live') === 'live');
  const queued = new Map<string, string>();
  for (const e of vault.events.query({ types: ['job.queued'], from: since, to: until, limit: 5000 })) if (e.job) queued.set(e.job, e.ts);

  const leadTimes: number[] = [];
  for (const d of deploys) {
    if (d.payload.rolled_back === true || !d.job) continue;
    const q = queued.get(d.job);
    if (!q) continue;
    leadTimes.push((Date.parse(d.ts) - Date.parse(q)) / 3600_000);
  }

  const rollbacks = deploys.filter((e) => e.payload.rolled_back === true).length;
  const returned = vault.events.query({ types: ['review.returned'], from: since, to: until, limit: 5000 })
    .filter((e) => e.job && readJob(vault, e.job)?.data.type === 'engineer.ship').length;

  const opened = vault.events.query({ types: ['incident.opened'], from: since, to: until, limit: 2000 });
  const recovered = new Map<string, string>();
  for (const e of vault.events.query({ types: ['incident.recovered'], from: since, to: until, limit: 2000 })) if (e.job) recovered.set(e.job, e.ts);
  const restores = opened.flatMap((o) => { const r = o.job ? recovered.get(o.job) : undefined; return r ? [(Date.parse(r) - Date.parse(o.ts)) / 3600_000] : []; });

  const windowDays = Math.max(0.25, (Date.parse(until) - Date.parse(since)) / 86_400_000);
  const failures = rollbacks + returned;
  return {
    lead_time_h: median(leadTimes),
    deploys_per_week: Number(((deploys.length / windowDays) * 7).toFixed(2)),
    change_failure_rate: deploys.length ? Number((failures / deploys.length).toFixed(3)) : null,
    time_to_restore_h: median(restores),
    deploys: deploys.length,
    failures,
    incidents: opened.length,
    window_days: Number(windowDays.toFixed(2)),
  };
}

const NA = 'not enough data';
const hrs = (v: number | null) => (v === null ? NA : `${v.toFixed(1)} h`);
const pct = (v: number | null) => (v === null ? NA : `${(v * 100).toFixed(0)} %`);

export function renderEngineering(d: Dora, at: string, budgets: string[]): string {
  return `# Engineering metrics

_Computed by the weekly review from the event log at ${at}, over the last ${d.window_days} days. Never edit by hand._

| measure | value | how it is computed |
|---|---|---|
| Lead time | ${hrs(d.lead_time_h)} | median \`job.queued\` → the live \`deploy.done\` of the same job |
| Deployment frequency | ${d.deploys_per_week.toFixed(2)} / week | ${d.deploys} live deploys over ${d.window_days} days |
| Change failure rate | ${pct(d.change_failure_rate)} | ${d.failures} failures (rollbacks + returned ships) over ${d.deploys} deploys |
| Time to restore | ${hrs(d.time_to_restore_h)} | median \`incident.opened\` → \`incident.recovered\`, over ${d.incidents} incident(s) |

## Error budgets

${budgets.length ? budgets.map((b) => `- ${b}`).join('\n') : '- No active streams yet.'}

## What these are for

These four describe the delivery system, not the people in it (§31). A measure reading "${NA}" means the window
held nothing to measure — that is information, not a zero.

## What is never measured here

Lines of code. Number of tickets closed. Story points completed. §31: they are trivially gamed and they
encourage the wrong behaviour. If someone asks for one of these, the answer is one of the four above.
`;
}

/** Compute and write `Metrics/engineering.md` for the cycle that just ended. */
export function writeEngineeringMetrics(vault: Vault, now = new Date()): Dora {
  const until = now.toISOString();
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const d = computeDora(vault, since, until);
  vault.writeText('Metrics/engineering.md', renderEngineering(d, until, budgetLines(vault, undefined, since)), 'daemon', { generated: true });
  return d;
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

// ---------- continuous intelligence (owner model §14–17) ----------

/** The four standing intelligence beats. One job each, every heartbeat cycle. */
export const INTELLIGENCE_KINDS = ['competitive', 'market', 'technology', 'security'] as const;
export type IntelligenceKind = typeof INTELLIGENCE_KINDS[number];

const INTELLIGENCE_SCOPE: Record<IntelligenceKind, string> = {
  competitive: 'competitors, their products, pricing, technology, positioning, hiring, partnerships and public announcements (§14)',
  market: 'market size and growth, customer segments, pricing norms, demand, new entrants and economic conditions (§15)',
  technology: 'emerging technologies, open-source projects, standards, architecture patterns, infrastructure, AI/ML, developer tooling and technical maturity (§16)',
  security: 'the threat landscape, vulnerabilities affecting what we run, architecture risks, defensive technology and adversary behaviour (§17)',
};

const INTELLIGENCE_TEST: Record<IntelligenceKind, string> = {
  competitive: 'a competitor changed price, shipped or killed a product, changed who they sell to, or said something about direction',
  market: 'demand, a segment, a pricing norm or a regulation moved enough to change what the company should build or charge',
  technology: 'something we might use crossed from interesting into technically mature, or something we already use is being abandoned',
  security: 'a vulnerability or threat touches software we actually run, or a control we rely on stopped being sufficient',
};

/** The whole brief for one sweep. Exported so its wording is testable without running a job. */
export function intelligenceGoal(kind: IntelligenceKind, date: string, previous: string | null): string {
  const out = `Research/intelligence/${date}-${kind}.md`;
  return [
    `Standing ${kind} intelligence sweep for this cycle. Scope: ${INTELLIGENCE_SCOPE[kind]}.`,
    '',
    `The rule for this job is "Detect meaningful change, not collect everything" (§14). A meaningful change is one where ${INTELLIGENCE_TEST[kind]}. Everything else is noise, and noise is the enemy of intelligence.`,
    '',
    'Do:',
    `1. Read ${previous ? `the previous sweep, ${previous}, so you report what changed since it` : `Research/index.md and Docs/tech-radar.md for context — there is no previous ${kind} file, so this first sweep sets the baseline`}.`,
    '2. Gather with `http.fetch { archive: true }` so every page you rely on is snapshotted under `Research/archive/`. Use `memory.search` and `vault.search` before fetching: evidence the company already has is cheaper and often better.',
    `3. \`vault.write ${out}\` with four sections, in this order:`,
    '   - `## Observations` — one line each, every line dated and carrying its archive path or URL. Say what you saw, not what you think it means.',
    '   - `## Changes since last time` — only what actually moved. If nothing did, write "nothing meaningful changed" and say what you checked.',
    '   - `## Alerts` — anything someone needs to know now. One line each, naming who and why.',
    '   - `## Noise ignored` — one line per thing you deliberately did not escalate. This section is how the next sweep knows you looked.',
    `4. For each meaningful change that suggests something the company could **do**, \`vault.write Ideas/<slug>.md\` using the shape of \`Ideas/_template.md\`: \`id\` (the slug), \`title\`, \`source: intelligence:${kind}\`, \`status: new\`, \`evidence\` (the archive paths), and the three body sections. One card per change, never a digest.`,
    `5. For each alert, \`colleague.message\` the research_manager with the one line and the path to ${out}.`,
    '',
    'Never invent an observation, a number or a date. A sweep that found nothing is a good sweep honestly reported; a sweep that invented something is worse than no sweep at all.',
  ].join('\n');
}

/**
 * One sweep per kind, once per heartbeat cycle. Idempotent the way charter compression is: the job id is
 * derived from the cycle number, so a second call in the same cycle finds the note already there. `cheap`
 * tier because this is bounded, repetitive reading — exactly the work §38 says to automate cheaply.
 */
export function maybeEnqueueIntelligence(vault: Vault, now = new Date()): string[] {
  const cycle = vault.events.count('heartbeat.completed');
  if (cycle === 0) return [];
  const org = loadOrg(vault);
  const assigned = org.roles.intelligence_analyst ? 'intelligence_analyst' : (researchLead(org) ?? 'research_manager');
  if (!org.roles[assigned]) return [];
  const date = now.toISOString().slice(0, 10);
  const out: string[] = [];
  for (const kind of INTELLIGENCE_KINDS) {
    const id = idFromKey('job', `intel-${cycle}-${kind}`);
    if (vault.exists(jobPath(id))) continue;
    const previous = vault.list('Research/intelligence', { ext: '.md' }).filter((r) => r.endsWith(`-${kind}.md`)).sort().at(-1) ?? null;
    out.push(createJob(vault, {
      id, type: 'intelligence', title: `${kind[0].toUpperCase()}${kind.slice(1)} intelligence: cycle ${cycle}`,
      assigned, priority: 4, team: 'research', owner_role: 'research_manager', for: 'research_manager', model_tier: 'cheap',
      done_when: `Research/intelligence/${date}-${kind}.md exists with observations, changes, alerts and noise ignored; every meaningful change is either an Ideas/ card or a line under ## Alerts`,
      goal: intelligenceGoal(kind, date, previous),
    }, 'daemon'));
  }
  return out;
}

// ---------- research knowledge (owner model §23, §40) ----------

/** How long after delivery the company checks whether the recommendation was right. */
export const FOLLOW_UP_DAYS = 14;

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000).toISOString().slice(0, 10);

/**
 * Every research project that passed its gates gets a row in `Research/index.md` and a follow-up note with a
 * due date. Both are keyed on the job id and written once — the follow-up note's existence is the marker, so
 * this survives a restart and a replayed event log without duplicating anything.
 *
 * Nothing here asks a model for anything: the row is assembled from the request the requester already wrote
 * and the Result block the author already finished with. Where the author stated no confidence or method,
 * the row says `unstated` rather than guessing, because a fabricated confidence is worse than a missing one.
 */
export function captureResearchDeliveries(vault: Vault, now = new Date()): string[] {
  const written: string[] = [];
  for (const e of vault.events.query({ types: ['research.delivered'] })) {
    const jobId = e.job; if (!jobId) continue;
    const rel = `Research/followups/${jobId}.md`;
    if (vault.exists(rel)) continue;
    const note = readJob(vault, jobId); if (!note) continue;
    const req: ResearchRequest | undefined = note.data.research;
    const result = resultBlock(note.body);
    const metrics = (result.metrics ?? {}) as Record<string, unknown>;
    const slug = note.data.research_slug ?? researchSlug(req?.question ?? note.data.title, jobId);
    const delivered = e.ts.slice(0, 10);
    const row: DeliveredResearch = {
      job: jobId, delivered,
      question: req?.question ?? note.data.title,
      decision: req?.decision ?? 'not stated on the request',
      decision_owner: req?.decision_owner ?? note.data.for ?? note.data.owner_role ?? 'unstated',
      method: String(metrics.method ?? 'unstated'),
      confidence: String(metrics.confidence ?? 'unstated'),
      report: `Research/${slug}/report.md`,
    };
    vault.writeText(RESEARCH_INDEX, upsertIndexRow(vault.readTextOrNull(RESEARCH_INDEX), row), 'daemon', { job: jobId });
    const prediction = String(result.summary ?? '').trim() || 'the report recorded no summary';
    vault.writeText(rel, [
      '---',
      `id: ${jobId}`,
      `research: ${jobId}`,
      `slug: ${slug}`,
      `decision_owner: ${row.decision_owner}`,
      `delivered: ${delivered}`,
      `due: ${addDays(new Date(e.ts), FOLLOW_UP_DAYS)}`,
      'status: pending',
      `prediction: ${JSON.stringify(prediction)}`,
      'outcome: ""',
      '---',
      `# Follow-up: ${row.question}`,
      '',
      '## What we predicted',
      '',
      prediction,
      '',
      `Required confidence was ${req?.required_confidence ?? 'unstated'}; the report claimed ${row.confidence}.`,
      '',
      '## What actually happened',
      '',
      `_Filled in by the research.measure job on or after ${addDays(new Date(e.ts), FOLLOW_UP_DAYS)}._`,
      '',
    ].join('\n'), 'daemon', { job: jobId });
    written.push(rel);
  }
  return written;
}

export interface FollowUpNote { path: string; id: string; research: string; slug: string; decision_owner: string; due: string; status: string; prediction: string }

/** Every `Research/followups/*.md`, parsed loosely — an owner may edit one by hand. */
export function listResearchFollowUps(vault: Vault): FollowUpNote[] {
  return vault.list('Research/followups', { ext: '.md' }).flatMap((rel) => {
    const n = vault.readNoteOrNull(rel); if (!n) return [];
    const d = n.data as Record<string, unknown>;
    const research = String(d.research ?? d.id ?? '');
    if (!research) return [];
    return [{
      path: rel, id: String(d.id ?? research), research, slug: String(d.slug ?? ''),
      decision_owner: String(d.decision_owner ?? 'ceo'), due: String(d.due ?? ''),
      status: String(d.status ?? 'pending'), prediction: String(d.prediction ?? ''),
    }];
  });
}

/**
 * A pending follow-up whose due date has arrived becomes one `research.measure` job. Idempotent by job id, and
 * gated by the note's own `status`, so an owner who writes `status: measured` by hand stops the loop the same
 * way the measurement job does. §40: a recommendation nobody measures is an opinion with a bibliography.
 */
export function enqueueResearchFollowUps(vault: Vault, now = new Date()): string[] {
  const today = now.toISOString().slice(0, 10);
  const org = loadOrg(vault);
  const lead = researchLead(org) ?? 'research_manager';
  if (!org.roles[lead]) return [];
  const out: string[] = [];
  for (const f of listResearchFollowUps(vault)) {
    if (f.status !== 'pending' || !f.due || f.due > today) continue;
    const id = idFromKey('job', `measure:${f.research}`);
    if (vault.exists(jobPath(id))) continue;
    const report = `Research/${f.slug}/report.md`;
    const owner = org.roles[f.decision_owner] ? f.decision_owner : lead;
    out.push(createJob(vault, {
      id, type: 'research.measure', title: `Measure: did [[${f.research}]] turn out right?`,
      assigned: lead, priority: 3, team: 'research', owner_role: 'research_manager', for: owner,
      links: [`[[${f.research}]]`], model_tier: 'cheap',
      done_when: `${report} ends with a ## Prediction vs reality section, ${f.path} has status: measured with an outcome, and the job's row in Research/index.md carries that outcome`,
      goal: [
        `${FOLLOW_UP_DAYS} days ago this company acted on research [[${f.research}]]. Find out whether it was right.`,
        '',
        'What was predicted:',
        '',
        `> ${f.prediction.replace(/\n/g, ' ')}`,
        '',
        'Do:',
        `1. \`vault.read ${f.path}\` and \`vault.read ${report}\` for the recommendation and the confidence it claimed.`,
        `2. Look for what actually happened: \`vault.read Metrics/daily.md\`, the Decisions/ note if one was written, and the jobs that followed [[${f.research}]]. Use \`vault.search\` rather than guessing where the evidence is.`,
        `3. \`vault.append ${report}\` with a \`## Prediction vs reality\` section: what was predicted, what happened, and which of "as expected", "partly", "not as expected" or "cannot tell yet" it was. If the honest answer is "cannot tell yet", say so and say what would settle it — an invented outcome poisons every future confidence estimate the company makes.`,
        `4. \`vault.write ${f.path}\` with \`status: measured\` and \`outcome:\` set to that one-line verdict, keeping every other field.`,
        `5. \`vault.write Research/index.md\` replacing this job's row's last column with the same verdict. Change nothing else in that file.`,
        `6. Tell ${owner} with \`colleague.message\`, one line, and finish with the verdict as your summary.`,
      ].join('\n'),
    }, 'daemon'));
  }
  return out;
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
/**
 * One thing the owner said, addressed to a role. `kind` says which of the three channels it came from, because
 * each is retired differently: a `comment` by advancing the note's comment baseline, a `preference` by an
 * `owner.feedback_delivered` event, a `rating` by the `rating_seen` stamp written when it is collected.
 */
export interface OwnerFeedback { role: string; source: string; text: string; kind: 'comment' | 'preference' | 'rating' }

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
  return feedback.filter((f) => f.kind === 'preference').map((f) => feedbackSha(f.text));
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
 * For every note whose `%%cubicle: …%%` comments this cycle is showing the CEO, the note's full comment list as
 * it stood when they were gathered. Pass the result to {@link markCommentsDelivered} at the cycle's commit.
 *
 * The full list, not just the new comments: the baseline it becomes means "everything present at the last system
 * write", so keeping only the new ones would drop the older comments out of the baseline and make them new again.
 * A gather-time snapshot, not a fresh read at commit, for the same reason D5 records shas at gather — a comment
 * the owner types mid-cycle is in no prompt this cycle and must survive into the next one.
 */
export function gatheredCommentBaselines(vault: Vault, feedback: OwnerFeedback[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of feedback) {
    if (f.kind !== 'comment' || out[f.source]) continue;
    const text = vault.readTextOrNull(f.source);
    if (text !== null) out[f.source] = extractOwnerComments(text);
  }
  return out;
}

/**
 * Retire the owner comments this cycle delivered, by advancing each note's recorded comment baseline.
 *
 * Without this the startup sweep (`collectOfflineOwnerComments`) re-reports the same comment after every restart
 * for any note the system writes once and never rewrites — a run brief, a decision, a skill — because only a
 * system write moved `written_sha.comments_json`, and `collectOwnerFeedback` then re-delivered it in the cycle
 * that followed. A comment on yesterday's brief reached its author every morning, forever (I1).
 *
 * Merged with the baseline as it stands now rather than replacing it: a system rewrite mid-cycle has already
 * recorded its own comments there, and dropping those would hand the agent's own text to the owner's author as
 * owner feedback. Returns how many paths it advanced.
 */
export function markCommentsDelivered(vault: Vault, gathered: Record<string, string[]>): number {
  let n = 0;
  for (const [rel, comments] of Object.entries(gathered)) {
    // No `written_sha` row means the system never wrote this note, so there is nothing to update; that path
    // baselines against git HEAD instead and the heartbeat's own auto-commit retires it.
    if (vault.writtenSha(rel) === null) continue;
    vault.setWrittenComments(rel, [...new Set([...(vault.writtenComments(rel) ?? []), ...comments])]);
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
    const byArea = rel.startsWith('Site/') ? 'engineer' : rel.startsWith('Customers/') || rel.startsWith('Experiments/') ? 'head_of_growth' : rel.startsWith('Plans/') ? 'cto' : 'ceo';
    const role = resolveRole(loadOrg(vault), String(byName ?? d.assigned ?? d.decided_by ?? d.from ?? d.by ?? d.author ?? d.owner ?? byArea));
    for (const c of comments) out.push({ role, source: rel, text: c, kind: 'comment' });
  }
  const alreadyDelivered = deliveredFeedbackShas(vault);
  for (const f of vault.ownerPreferences().feedback) {
    // An entry the owner typed once must not be repeated to the CEO every cycle for the rest of the company's
    // life; `owner.feedback_delivered` is the marker, and it lives in the event log so `cubicle rebuild` keeps it.
    if (alreadyDelivered.has(feedbackSha(f))) continue;
    out.push({ role: 'ceo', source: OWNER_PREFERENCES, text: f, kind: 'preference' });
  }
  for (const rel of vault.list('Decisions', { ext: '.md' })) {
    const d = vault.readNoteOrNull(rel)?.data as { owner_rating?: string; decided_by?: string; rating_seen?: string } | undefined;
    if (d?.owner_rating === 'down' && !d.rating_seen) {
      out.push({ role: String(d.decided_by ?? 'ceo'), source: rel, text: `the owner rated this decision down`, kind: 'rating' });
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

// ---------- incidents (owner's operating model §33) ----------

/** How many corrective-action jobs one postmortem may create. Three is the most a room can actually pick up. */
export const CORRECTIVE_MAX = 3;

/** The postmortem a finished incident produced, from its Result artifacts. */
export function postmortemPath(vault: Vault, jobId: string): string | null {
  const body = readJob(vault, jobId)?.body ?? '';
  const raw = body.split('## Result')[1]?.match(/```json\s*([\s\S]*?)```/)?.[1];
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as { artifacts?: unknown };
    const arts = Array.isArray(r.artifacts) ? r.artifacts.map(String) : [];
    return arts.find((a) => a.startsWith('Docs/postmortems/') && a.endsWith('.md') && vault.exists(a)) ?? null;
  } catch { return null; }
}

/**
 * Open an incident for a production failure nobody has opened one for yet. Two triggers, both things the log
 * already records: a deploy that was rolled back, and a live deploy of a stream whose last CI run was red.
 * Detection is the first step of §33's chain, and a company that only notices an outage when a human looks has
 * no detection at all.
 *
 * Idempotent per trigger: the incident's id is derived from the event, so a second tick finds it already there.
 */
export function maybeOpenIncident(vault: Vault, now = new Date()): string | null {
  const deploys = vault.events.query({ types: ['deploy.done'], limit: 200 });
  for (const e of deploys) {
    const stream = typeof e.payload.stream === 'string' ? e.payload.stream : null;
    if (!stream || !readStream(vault, stream)) continue;
    const trigger = e.payload.rolled_back === true ? 'rollback' : null;
    if (!trigger) continue;
    const id = idFromKey('job', `incident:${trigger}:${e.ts}:${stream}`);
    if (readJob(vault, id)) continue;
    createJob(vault, {
      id, type: 'incident', title: `Incident: ${stream} was rolled back`, assigned: 'sre', priority: 1,
      team: 'dev', owner_role: 'dev_manager', stream, risk: 'high',
      goal: `A live deploy of stream "${stream}" was rolled back at ${e.ts}. Treat it as a production incident (operating model §33): detection → triage → mitigation → recovery → root cause → corrective actions → learning.\n\nDo: (1) confirm the stream is serving again, rolling back further with deploy.site({ rollback: true }) if it is not; (2) read the deploy events, the CI records under Workspace/${stream}/.cubicle-ci/ and the job that shipped the change; (3) write the blameless postmortem to Docs/postmortems/${nowIso().slice(0, 10)}-${stream}.md from Docs/postmortems/_template.md — a timeline, the impact in hours, a root cause that is a design or a missing check rather than a person, and at least one corrective action with an owner role; (4) finish with that path in artifacts and the open→recovered hours in metrics.hours.`,
      done_when: `The stream is serving again and Docs/postmortems/${nowIso().slice(0, 10)}-${stream}.md has a timeline, an impact in hours, a root cause and at least one corrective action.`,
    }, 'daemon');
    vault.events.emit({ type: 'incident.opened', agent: 'daemon', job: id, payload: { stream, trigger }, ts: e.ts });
    void now;
    return id;
  }
  return null;
}

/**
 * Turn a finished incident's postmortem into work. §33's bargain is "no personal blame, strong ownership of
 * corrective action": without this the postmortem is a document nobody acts on. Once per incident, at most
 * `CORRECTIVE_MAX` jobs, each linked back so the next postmortem can see whether the last one worked.
 */
export function maybeCorrectiveActions(vault: Vault): string[] {
  const out: string[] = [];
  for (const inc of listJobs(vault).filter((j) => j.type === 'incident' && j.status === 'done')) {
    const marker = `corrective:${inc.id}`;
    if (listJobs(vault).some((j) => j.links.includes(`[[${marker}]]`))) continue;
    const pm = postmortemPath(vault, inc.id);
    const recovered = vault.events.query({ types: ['incident.recovered'], job: inc.id, limit: 1 });
    if (!recovered.length) {
      const opened = vault.events.query({ types: ['incident.opened'], job: inc.id, limit: 1 })[0];
      const hours = opened ? (Date.parse(inc.updated) - Date.parse(opened.ts)) / 3600_000 : 0;
      vault.events.emit({ type: 'incident.recovered', agent: inc.assigned, job: inc.id, payload: { stream: inc.stream ?? null, hours: Number(Math.max(0, hours).toFixed(2)), postmortem: pm } });
    }
    if (!pm) { markCorrectiveDone(vault, inc.id, marker); continue; }
    const section = (vault.readTextOrNull(pm) ?? '').split('## Corrective actions')[1]?.split('\n## ')[0] ?? '';
    const actions = section.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter((l) => l.length > 8 && !l.startsWith('<')).slice(0, CORRECTIVE_MAX);
    for (const a of actions) {
      const title = a.replace(/\s*[—-]\s*owner:.*$/i, '').trim().slice(0, 80);
      const owner = a.match(/owner:\s*([a-z0-9_]+)/i)?.[1] ?? 'backend_engineer';
      out.push(createJob(vault, {
        id: idFromKey('job', `${marker}:${title}`), type: 'custom', title: `Corrective: ${title}`, assigned: owner,
        priority: 2, team: 'dev', owner_role: 'dev_manager', stream: inc.stream, links: [`[[${inc.id}]]`, `[[${marker}]]`],
        goal: `Corrective action from the postmortem of incident [[${inc.id}]] ([[${pm.replace(/\.md$/, '')}]]):\n\n${a}\n\nThe incident is closed; this is the change that stops it happening again. Read the postmortem's root cause first.`,
        done_when: `${title} is done and the postmortem's corrective action is ticked.`,
      }, 'daemon'));
    }
    if (!actions.length) markCorrectiveDone(vault, inc.id, marker);
  }
  return out;
}

/** A marker job-free way to say "this incident's actions were expanded": a link on the incident itself. */
function markCorrectiveDone(vault: Vault, incidentId: string, marker: string): void {
  const cur = readJob(vault, incidentId);
  if (!cur) return;
  updateJob(vault, incidentId, { links: [...cur.data.links, `[[${marker}]]`] }, 'daemon', `- ${nowIso()}: corrective actions expanded (none found)`);
}

// ---------- feature flags (owner's operating model §21) ----------

/**
 * A flag past its removal date is debt, and debt nobody names is debt nobody pays. One lesson line per flag,
 * written once — `Memory/lessons.md` is what the charter-compression pass and every role's context already
 * read, so the flag's owner meets it where they already look.
 */
export function maybeFlagLessons(vault: Vault, now = new Date()): string[] {
  const today = now.toISOString().slice(0, 10);
  const existing = vault.readTextOrNull('Memory/lessons.md') ?? '# Lessons\n';
  const made: string[] = [];
  const lines: string[] = [];
  for (const s of listStreams(vault)) {
    const expired = expiredFlags(readFlags(vault, s.slug), today);
    if (!expired.length) continue;
    const fresh = expired.filter((f) => !existing.includes(`flag "${f.key}"`));
    if (!fresh.length) continue;
    for (const f of fresh) {
      lines.push(`- [${today}] flag "${f.key}" in ${s.slug} passed its removal date ${f.remove_by} and is still there; ${f.owner} removes the flag and the dead branch, or sets a new date and says why (§21) #team:${s.owner_team}`);
      made.push(f.key);
    }
    vault.events.emit({ type: 'daemon.warning', payload: { where: 'flags', stream: s.slug, flags: fresh.map((f) => f.key), message: `${fresh.length} flag(s) past their removal date in ${s.slug}: ${fresh.map((f) => `${f.key} (${f.owner}, due ${f.remove_by})`).join(', ')}` } });
  }
  if (lines.length) vault.appendText('Memory/lessons.md', lines.join('\n') + '\n', 'daemon');
  return made;
}

// ---------- research metrics (owner model §41) ----------

export interface ResearchMetrics {
  delivered: number;
  open: number;
  /** Median hours from a research job being created to being delivered. `null` below one delivery. */
  medianHoursToAnswer: number | null;
  reused: number;
  /** Share of delivered projects that built on an earlier one. `null` when nothing has been delivered. */
  reuseRate: number | null;
  measured: number;
  asExpected: number;
}

/** Any `Research/<project>/` path that is not one of the four reserved subdirectories. */
const CITES_A_PROJECT = /Research\/(?!archive\/|intelligence\/|followups\/|index\b)[a-z0-9][a-z0-9-]*\//i;

/**
 * §41, computed rather than estimated. Everything here comes from files and events the company already wrote:
 * no model is asked how well research is going, because the answer to that question is exactly the one a model
 * would be tempted to flatter.
 */
export function researchMetrics(vault: Vault): ResearchMetrics {
  const hours: number[] = [];
  let delivered = 0; let reused = 0;
  for (const e of vault.events.query({ types: ['research.delivered'] })) {
    const note = e.job ? readJob(vault, e.job) : null; if (!note) continue;
    delivered++;
    const ms = Date.parse(e.ts) - Date.parse(note.data.created);
    // Defensive: a clock skew, a hand-edited note, or a replayed event log can put `created` after the
    // delivery `ts`. That interval is nonsense, not merely small, so it is dropped rather than counted as
    // (or floored to) zero hours to answer.
    if (Number.isFinite(ms) && ms >= 0) hours.push(ms / 3600_000);
    const own = note.data.research_slug ? new RegExp(`Research/${note.data.research_slug}/`, 'i') : null;
    const cited = note.body.split('\n').filter((l) => CITES_A_PROJECT.test(l) && !(own && own.test(l)));
    if (cited.length) reused++;
  }
  const sorted = [...hours].sort((a, b) => a - b);
  const median = sorted.length === 0 ? null
    : sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const followUps = listResearchFollowUps(vault);
  const measuredNotes = followUps.filter((f) => f.status === 'measured');
  const asExpected = measuredNotes.filter((f) => {
    const n = vault.readNoteOrNull(f.path);
    return /^as expected/i.test(String((n?.data as Record<string, unknown> | undefined)?.outcome ?? ''));
  }).length;
  return {
    delivered, open: listJobs(vault, { status: ['queued', 'running', 'blocked', 'in_review'] }).filter((j) => j.type === 'research').length,
    medianHoursToAnswer: median, reused, reuseRate: delivered ? reused / delivered : null,
    measured: measuredNotes.length, asExpected,
  };
}

export function renderResearchMetrics(m: ResearchMetrics, now: Date): string {
  const pct = (n: number | null) => (n === null ? 'not enough delivered research to say' : `${Math.round(n * 100)}%`);
  const hrs = (n: number | null) => (n === null ? 'not enough delivered research to say' : n < 48 ? `${n.toFixed(1)} h` : `${(n / 24).toFixed(1)} days`);
  return [
    '# Research metrics',
    '',
    `_Generated ${now.toISOString()} by the daemon on the weekly cadence. Edit nothing here; it is overwritten._`,
    '',
    '| measure | value | what it means |',
    '|---|---|---|',
    `| Delivered | ${m.delivered} | research projects that passed both gates |`,
    `| Open | ${m.open} | research jobs still in flight |`,
    `| Time to answer (median) | ${hrs(m.medianHoursToAnswer)} | request queued → delivered |`,
    `| Reuse rate | ${pct(m.reuseRate)} | delivered projects that built on an earlier one (${m.reused} of ${m.delivered}) |`,
    `| Measured | ${m.measured} | follow-ups where the company checked what actually happened |`,
    `| Decisions as expected | ${m.measured ? `${m.asExpected} of ${m.measured}` : 'nothing measured yet'} | the only outcome measure that matters (§41) |`,
    '',
    'Number of reports is deliberately not a metric: measuring it encourages useless output.',
    '',
    'Reuse rate low and time to answer high together mean the index is not being searched before work starts.',
    'Measured far below delivered means recommendations are being acted on without anyone checking them.',
    '',
  ].join('\n');
}
