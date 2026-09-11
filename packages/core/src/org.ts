import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { TeamFrontmatter, RoleFrontmatter, type Permission, type CubicleEvent } from './schemas.js';
import type { Vault } from './vault.js';
import { parseNote, stringifyNote } from './frontmatter.js';
import { listJobs, updateJob } from './jobs.js';
import { nowIso } from './fs.js';

export interface Org { teams: Record<string, TeamFrontmatter>; roles: Record<string, RoleFrontmatter> }
export type Action = Permission;

/**
 * `loadOrg` re-reads and re-parses every Teams/*.md and Roles/*.md note, which used to be fine when the only
 * caller was the once-per-heartbeat-tick planner. `nextJob`'s WIP check (§7) now calls it once per idle worker
 * per poll — a dozen-plus roles, each polling on its own schedule — which turned "cheap, call per tick" into a
 * few dozen synchronous file reads every few hundred milliseconds and was enough, under load, to push a busy
 * heartbeat cycle past a 30s test timeout (never a hang: the same cycle finishes fine with more time or less
 * contention). Cache per vault, invalidated by anything that changes a Teams/ or Roles/ note: an agent write
 * (`vault.wrote`) *and* an owner edit made straight in Obsidian, which never goes through the Vault write API
 * and instead reaches the daemon as `owner.edited` from `VaultWatcher` (watcher.ts) — including a delete/rename,
 * which the watcher reports as `owner.edited` with `deleted: true`. Both event payloads carry the same shape
 * (`{ path }`), so one predicate below covers both.
 */
const orgCache = new WeakMap<Vault, { org: Org | null; dirty: boolean }>();

/** True when a written/edited/deleted path could change what `loadOrg` returns. */
function isOrgPath(rel: string): boolean {
  return rel.startsWith('Teams/') || rel.startsWith('Roles/');
}

function computeOrg(vault: Vault): Org {
  const teams: Org['teams'] = {};
  for (const rel of vault.list('Teams', { ext: '.md' })) {
    if (rel.includes('/archive/')) continue;
    const n = vault.readNoteOrNull(rel); const p = n && TeamFrontmatter.safeParse(n.data);
    if (p && p.success) teams[p.data.id] = p.data;
  }
  const roles: Org['roles'] = {};
  for (const rel of vault.list('Roles', { ext: '.md' })) {
    if (rel.includes('/archive/') || rel.includes('/_hireable/')) continue;
    const n = vault.readNoteOrNull(rel); const p = n && RoleFrontmatter.safeParse(n.data);
    if (p && p.success && p.data.active) roles[p.data.role] = p.data;
  }
  return { teams, roles };
}

export function loadOrg(vault: Vault): Org {
  let entry = orgCache.get(vault);
  if (!entry) {
    entry = { org: null, dirty: true };
    orgCache.set(vault, entry);
    const invalidateOnOrgPath = (e: CubicleEvent) => {
      const p = String((e.payload as { path?: string } | undefined)?.path ?? '');
      if (isOrgPath(p)) entry!.dirty = true;
    };
    vault.events.on('vault.wrote', invalidateOnOrgPath);
    vault.events.on('owner.edited', invalidateOnOrgPath);
  }
  if (entry.dirty || !entry.org) { entry.org = computeOrg(vault); entry.dirty = false; }
  return entry.org;
}

export function teamOf(org: Org, role: string): TeamFrontmatter | null {
  const byField = org.roles[role]?.team;
  if (byField && org.teams[byField]) return org.teams[byField];
  return Object.values(org.teams).find((t) => t.lead === role || t.members.includes(role)) ?? null;
}

/**
 * v1 role ids → tower roles (2026-09-11). Processes, gates, seeds and tests written against the nine-role org keep
 * working: `resolveRole` swaps an inactive legacy id for its alias when the alias is active, and leaves anything
 * else alone so an unknown id still fails loudly where it always did.
 *
 * Each alias keeps the position the v1 id actually held. `engineer` was the person who built, so it aliases to a
 * worker with the tools to build (`backend_engineer`); `tech_lead` was the person who planned the room, so it
 * aliases to `dev_manager`. Aliasing `engineer` upward would hand build jobs to a manager whose charter carries
 * no `deploy.site`, `git.*` or `browser.*`.
 */
export const LEGACY_ROLES: Record<string, string> = { critic: 'advisor_skeptic', research_analyst: 'research_manager', engineer: 'backend_engineer', tech_lead: 'dev_manager', qa: 'qa_lead', head_of_growth: 'cmo', growth: 'cmo' };
export function resolveRole(org: Org, id: string): string {
  if (org.roles[id]) return id;
  const alias = LEGACY_ROLES[id];
  return alias && org.roles[alias] ? alias : id;
}
/** Who receives `research` jobs: the research team's lead (v1: the analyst, who led a team of one). */
export function researchLead(org: Org): string | null {
  const lead = org.teams.research?.lead;
  if (lead && org.roles[lead]) return lead;
  return org.roles.research_analyst ? 'research_analyst' : null;
}

/**
 * Resolve a `### <header>` section header (from Plans/plan.md) to a team id, matching case-insensitively
 * against either the team's id or its display name, and tolerating a trailing "team" (`### Growth team`) — the
 * plan is CEO-written prose, not a machine key (F4). Returns null when nothing matches.
 */
export function resolveTeamSection(org: Org, header: string): string | null {
  const norm = header.trim().replace(/\s+team$/i, '').trim().toLowerCase();
  if (!norm) return null;
  for (const t of Object.values(org.teams)) if (t.id.toLowerCase() === norm || t.name.toLowerCase() === norm) return t.id;
  return null;
}
export function isLead(org: Org, role: string): boolean { return Object.values(org.teams).some((t) => t.lead === role); }
export function leadOf(org: Org, role: string): string | null {
  if (role === 'ceo') return 'owner';
  const t = teamOf(org, role);
  if (!t) return null;
  return t.lead === role ? (org.roles[role]?.reports_to ?? 'ceo') : t.lead;
}
/** Direct reports: a lead's members; the CEO's are every other lead plus their team members. */
export function reportsOf(org: Org, role: string): string[] {
  if (role === 'ceo') {
    const leads = Object.values(org.teams).map((t) => t.lead).filter((l) => l !== 'ceo');
    const members = Object.values(org.teams).find((t) => t.lead === 'ceo')?.members ?? [];
    return [...new Set([...leads, ...members])];
  }
  const t = Object.values(org.teams).find((x) => x.lead === role);
  return t ? [...t.members] : [];
}

export function defaultPermissions(org: Org, role: string): Permission[] {
  if (!org.roles[role]) return [];
  if (role === 'ceo') return ['schedule', 'plan', 'review', 'hire', 'fire', 'research_request', 'reprioritize', 'meeting'];
  if (role === 'research_analyst' && researchLead(org) === role) return [];   // v1: the analyst led a team of one and was reached only through research_request
  if (isLead(org, role)) return ['plan', 'schedule', 'review', 'research_request', 'meeting', 'reprioritize'];
  return ['schedule'];
}

function granted(org: Org, role: string): Set<Permission> {
  const explicit = org.roles[role]?.permissions ?? [];
  return new Set(explicit.length ? explicit : defaultPermissions(org, role));
}

/**
 * The one answer to "may this role do that". `target`: the assignee for schedule, the team id for reprioritize.
 * Members may schedule only a teammate (a handoff), never themselves; leads only their members; the CEO anyone.
 * The Research Analyst is reached through `research_request`, never scheduled directly by a lead.
 */
export function can(org: Org, role: string, action: Action, target?: string): boolean {
  if (!org.roles[role]) return false;
  const has = granted(org, role);
  if (!has.has(action)) return false;
  switch (action) {
    case 'schedule': {
      if (!target || !org.roles[target]) return false;
      if (target === role) return false; // explicit guard: no role schedules itself
      if (role === 'ceo') return true;
      if (target === researchLead(org)) return false;   // research is requested, never scheduled directly
      if (isLead(org, role)) return reportsOf(org, role).includes(target);
      const mine = teamOf(org, role);
      return !!mine && mine.members.includes(target);
    }
    case 'reprioritize': return role === 'ceo' || !target || teamOf(org, role)?.id === target;
    default: return true;
  }
}

const ORG_FIELDS = ['team', 'reports_to', 'title', 'persona', 'permissions'] as const;

/** Bring a pre-org vault up to the default org. Idempotent: returns the list of paths it wrote. */
export function migrateOrg(vault: Vault, tpl: string): { changed: string[] } {
  const changed: string[] = [];
  const copyMissing = (rel: string) => { if (!vault.exists(rel) && existsSync(path.join(tpl, rel))) { vault.writeText(rel, readFileSync(path.join(tpl, rel), 'utf8'), 'daemon'); changed.push(rel); } };
  const copyDir = (relDir: string) => { const abs = path.join(tpl, relDir); if (!existsSync(abs)) return; for (const f of readdirSync(abs)) { const rel = `${relDir}/${f}`; if (statSync(path.join(abs, f)).isDirectory()) copyDir(rel); else copyMissing(rel); } };
  // 1. growth → head_of_growth
  if (vault.exists('Roles/growth.md') && !vault.exists('Roles/head_of_growth.md')) {
    const n = parseNote(vault.readText('Roles/growth.md'));
    const display = n.data.display === 'Growth' ? 'Head of Growth' : n.data.display; // preserve an owner-customised display
    vault.writeText('Roles/head_of_growth.md', stringifyNote({ ...n.data, role: 'head_of_growth', display }, n.body), 'daemon');
    vault.remove('Roles/growth.md', 'daemon');
    if (vault.exists('Messages/growth.md') && !vault.exists('Messages/head_of_growth.md')) vault.move('Messages/growth.md', 'Messages/head_of_growth.md', 'daemon');
    for (const j of listJobs(vault)) if (j.assigned === 'growth') updateJob(vault, j.id, { assigned: 'head_of_growth' }, 'daemon', `- ${nowIso()}: reassigned growth → head_of_growth (org migration)`);
    changed.push('Roles/head_of_growth.md');
  }
  // 2. tower roster (v2, 2026-09-11): a v1 vault still has the nine-role org. Archive the legacy six, move open
  //    work to their tower successors, and take team notes and processes from the template (the v1 ones name
  //    legacy roles). Guarded on the template too, so a repo that has not shipped the roster leaves v1 alone.
  let towerMigrated = false;
  if (vault.exists('Roles/engineer.md') && !vault.exists('Roles/dev_manager.md') && existsSync(path.join(tpl, 'Roles/dev_manager.md'))) {
    const date = nowIso().slice(0, 10);
    for (const id of Object.keys(LEGACY_ROLES)) {
      const rel = `Roles/${id}.md`;
      if (!vault.exists(rel)) continue;
      const n = parseNote(vault.readText(rel));
      vault.writeText(`Roles/archive/${id}-${date}.md`, stringifyNote({ ...n.data, active: false, archived: `tower migration ${date}` }, n.body), 'daemon');
      vault.remove(rel, 'daemon');
      changed.push(rel);
    }
    for (const j of listJobs(vault)) {
      const to = LEGACY_ROLES[j.assigned];
      if (to && !['done', 'failed', 'cancelled'].includes(j.status)) updateJob(vault, j.id, { assigned: to }, 'daemon', `- ${nowIso()}: reassigned ${j.assigned} → ${to} (tower migration)`);
    }
    for (const t of ['engineering', 'growth', 'strategy']) { const rel = `Teams/${t}.md`; if (vault.exists(rel)) { vault.remove(rel, 'daemon'); changed.push(rel); } }
    for (const dir of ['Teams', 'Processes']) {
      const abs = path.join(tpl, dir);
      if (!existsSync(abs)) continue;
      for (const f of readdirSync(abs)) {
        if (statSync(path.join(abs, f)).isDirectory()) continue;
        const rel = `${dir}/${f}`;
        const tplContent = readFileSync(path.join(abs, f), 'utf8');
        const existing = vault.readTextOrNull(rel);
        // the template's tower note replaces whatever is there; archive an owner-edited one first so it is not silently lost
        if (existing !== null && existing !== tplContent) {
          const archiveRel = `${dir}/archive/${f.replace(/\.md$/, '')}-${date}.md`;
          vault.writeText(archiveRel, existing, 'daemon');
          if (!changed.includes(archiveRel)) changed.push(archiveRel);
        }
        vault.writeText(rel, tplContent, 'daemon');
        if (!changed.includes(rel)) changed.push(rel);
      }
    }
    for (const f of readdirSync(path.join(tpl, 'Roles'))) if (f.endsWith('.md')) copyMissing(`Roles/${f}`);
    // kept charters (ceo, cto, coo …) take the template's desk, team and line of report; everything else the owner wrote stays
    for (const rel of vault.list('Roles', { ext: '.md' })) {
      if (rel.includes('/archive/') || rel.includes('/_hireable/')) continue;
      const tplPath = path.join(tpl, rel); if (!existsSync(tplPath)) continue;
      const n = vault.readNoteOrNull(rel); if (!n) continue;
      const t = parseNote(readFileSync(tplPath, 'utf8')).data as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const f of ['desk', 'team', 'reports_to'] as const) if (t[f] !== undefined && n.data[f] !== t[f]) patch[f] = t[f];
      if (Object.keys(patch).length) { vault.writeText(rel, stringifyNote({ ...n.data, ...patch }, n.body), 'daemon'); if (!changed.includes(rel)) changed.push(rel); }
    }
    towerMigrated = true;
  }
  // 3. teams, processes, docs, the research area and hireable charters that are simply missing
  copyDir('Teams'); copyDir('Processes'); copyDir('Docs'); copyDir('Roles/_hireable');
  copyDir('Research'); copyDir('Ideas'); copyMissing('Metrics/research.md');
  // 4. org fields on every active charter, from the template's charter of the same role
  for (const rel of vault.list('Roles', { ext: '.md' })) {
    if (rel.includes('/archive/') || rel.includes('/_hireable/')) continue;
    const n = vault.readNoteOrNull(rel); if (!n) continue;
    const tplPath = path.join(tpl, rel);
    if (!existsSync(tplPath)) {
      // A custom-hired role has no template counterpart to copy org fields from: if it also has no team of its
      // own, migration leaves it teamless with no way to fix that automatically (F13).
      if (n.data.team === undefined) vault.events.emit({ type: 'daemon.warning', agent: 'daemon', payload: { path: rel, reason: 'no team assigned; add team/reports_to to the charter' } });
      continue;
    }
    const t = parseNote(readFileSync(tplPath, 'utf8')).data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const f of ORG_FIELDS) if (n.data[f] === undefined && t[f] !== undefined) patch[f] = t[f];
    if (Object.keys(patch).length) { vault.writeText(rel, stringifyNote({ ...n.data, ...patch }, n.body), 'daemon'); changed.push(rel); }
  }
  // 5. constitution fields
  const c = vault.readTextOrNull('Memory/constitution.md') ?? '';
  let patched = c;
  if (c && !/^max_team_size:/m.test(c)) {
    patched = /^max_roles:.*$/m.test(c)
      ? c.replace(/^max_roles:.*$/m, (m) => `${m.replace(/\d+/, (d) => String(Math.max(12, Number(d))))}\nmax_team_size: 6\nauto_approve_reorg: false`)
      // no max_roles anchor at all (corrupted or pre-dates the field): add it, inside the fenced yaml block, instead of a no-op replace
      : c.replace(/^```ya?ml\s*\n/m, (m) => `${m}max_roles: 12\nmax_team_size: 6\nauto_approve_reorg: false\n`);
    patched = patched.replace(/^never_modify:\n((?:\s+-.*\n)*)/m, (m) => (m.includes('Teams/') ? m : m + '  - Teams/\n'));
  }
  if (towerMigrated) {
    patched = patched.replace(/^max_roles:\s*(\d+)\s*$/m, (_m, d: string) => `max_roles: ${Math.max(40, Number(d))}`).replace(/^max_team_size:\s*(\d+)\s*$/m, (_m, d: string) => `max_team_size: ${Math.max(8, Number(d))}`);
  }
  if (patched !== c) { vault.writeText('Memory/constitution.md', patched, 'daemon'); changed.push('Memory/constitution.md'); }
  if (changed.length) vault.events.emit({ type: 'org.changed', agent: 'daemon', payload: { reason: 'migration', changed } });
  return { changed };
}
