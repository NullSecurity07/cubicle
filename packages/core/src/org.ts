import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { TeamFrontmatter, RoleFrontmatter, OFFICES, DEFAULT_OFFICES, type Permission, type Office, type CubicleEvent } from './schemas.js';
import type { Vault } from './vault.js';
import { parseNote, stringifyNote } from './frontmatter.js';
import { listJobs, updateJob } from './jobs.js';
import { nowIso } from './fs.js';

export interface Org { teams: Record<string, TeamFrontmatter>; roles: Record<string, RoleFrontmatter>; offices?: Record<string, string> }
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

/**
 * True when a written/edited/deleted path could change what `loadOrg` returns. `Memory/constitution.md` counts
 * too: the office map lives in its yaml block, so an owner who re-staffs a seat there must be followed on the
 * next lookup rather than at the next unrelated Teams/ write.
 */
function isOrgPath(rel: string): boolean {
  return rel.startsWith('Teams/') || rel.startsWith('Roles/') || rel === 'Memory/constitution.md';
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
  // A constitution that does not parse still yields the default map (Vault.constitution already warns), so a
  // broken owner edit degrades to the shipped roster instead of leaving every office unresolved.
  const offices = { ...DEFAULT_OFFICES, ...vault.constitution().offices };
  return { teams, roles, offices };
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

/** The role the constitution puts in this office, when that role is active; null otherwise. */
export function officeRole(org: Org, office: Office): string | null {
  const id = org.offices?.[office] ?? DEFAULT_OFFICES[office];
  return id && org.roles[id] ? id : null;
}

/**
 * Someone who can actually answer for an office: the office's own role, else the lead of the team that role sat
 * in, else that team's division lead, else the chief executive. A gate or an escalation must always land on a
 * live desk — an empty office cannot mean "nobody".
 */
export function officeHolder(org: Org, office: Office): string {
  const direct = officeRole(org, office);
  if (direct) return direct;
  const named = org.offices?.[office] ?? DEFAULT_OFFICES[office];
  const team = named ? teamOf(org, named) : null;
  if (team && org.roles[team.lead]) return team.lead;
  const div = team ? divisionOf(org, team.id) : null;
  const divLead = div && div !== team?.id ? org.teams[div]?.lead : null;
  if (divLead && org.roles[divLead]) return divLead;
  return officeRole(org, 'chief_executive') ?? DEFAULT_OFFICES.chief_executive;
}

/** Teams whose `parent` is this team. */
export function childTeams(org: Org, teamId: string): TeamFrontmatter[] {
  return Object.values(org.teams).filter((t) => t.parent === teamId);
}

/** The root of a team's `parent` chain — its division. Depth-capped so a cycle in owner-edited notes cannot hang. */
export function divisionOf(org: Org, teamId: string | undefined): string | null {
  // `id` is annotated rather than inferred: `TeamFrontmatter` is a loose object, so letting TS infer `id` from
  // `parent` (which it reads off `org.teams[id]`) is circular (TS7022).
  let id: string | undefined = teamId;
  if (!id || !org.teams[id]) return null;
  for (let hops = 0; hops < 8; hops++) {
    const parent: string | undefined = org.teams[id]?.parent;
    if (!parent || !org.teams[parent] || parent === id) break;
    id = parent;
  }
  return id ?? null;
}

/** The teams that hold a planning round: top-level teams with at least one room under them. */
export function divisionTeams(org: Org): TeamFrontmatter[] {
  return Object.values(org.teams).filter((t) => !t.parent && childTeams(org, t.id).length > 0);
}

/** The lead of the division a role works in (a division lead's own division lead is itself). */
export function divisionLeadOf(org: Org, role: string): string | null {
  const div = divisionOf(org, teamOf(org, role)?.id);
  const lead = div ? org.teams[div]?.lead : null;
  return lead ?? null;
}

/** Everyone in a team and in every team under it, lead first, in note order. Depth-capped against a parent cycle. */
export function subtreeRoles(org: Org, teamId: string): string[] {
  const out: string[] = []; const seen = new Set<string>();
  const walk = (id: string, depth: number): void => {
    const t = org.teams[id];
    if (!t || depth > 6) return;
    for (const r of [t.lead, ...t.members]) if (!seen.has(r)) { seen.add(r); out.push(r); }
    for (const c of childTeams(org, id)) walk(c.id, depth + 1);
  };
  walk(teamId, 0);
  return out;
}

/**
 * The first active role in a subtree whose charter carries `tool`. The daemon seeds work by capability ("who can
 * deploy") rather than by name, so a re-staffed room keeps working without a code change.
 */
export function roleWithTool(org: Org, teamId: string | undefined, tool: string): string | null {
  if (!teamId) return null;
  for (const r of subtreeRoles(org, teamId)) if (org.roles[r]?.tools.includes(tool)) return r;
  return null;
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
/**
 * Who answers a production incident, and under which room and lead — one lookup, so the two triggers
 * (`maybeOpenIncident` in the daemon, `errors.report` in the tools) and the corrective actions that follow
 * cannot drift, and none of them writes `assigned: 'sre', team: 'dev', owner_role: 'dev_manager'` as literals
 * (final review M6). The SRE's charter owns incidents in the shipped org, so it is preferred by name where it
 * exists; where it does not, the fall-back is by capability — someone in the engineering division who can roll
 * a deploy back — and then the office itself. The room and its lead always come from the tree, so a renamed
 * room or a re-staffed manager still routes.
 */
export function incidentResponder(org: Org): { role: string; team: string | undefined; lead: string } {
  const eng = officeHolder(org, 'engineering');
  const sre = resolveRole(org, 'sre');
  const role = org.roles[sre] ? sre : (roleWithTool(org, teamOf(org, eng)?.id, 'deploy.site') ?? eng);
  const team = teamOf(org, role)?.id;
  return { role, team, lead: (team ? org.teams[team]?.lead : undefined) ?? eng };
}

/** Who receives `research` jobs: the research office, else the research team's lead, else the v1 lone analyst. */
export function researchLead(org: Org): string | null {
  const byOffice = officeRole(org, 'research');
  if (byOffice) return byOffice;
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
/**
 * Who a role answers to. The one role that reports to the owner is whoever holds the chief executive's office,
 * and the last-resort `reports_to` is the same holder — not the literal id `ceo` (final review M4): `leadOf`
 * feeds `applyFire`, `enqueueGate`'s fallback and `secondPairOfEyes`, so a re-staffed seat would otherwise send
 * escalations and reassignments to a retired charter.
 */
export function leadOf(org: Org, role: string): string | null {
  const chief = officeHolder(org, 'chief_executive');
  if (role === chief) return 'owner';
  const t = teamOf(org, role);
  if (!t) return null;
  return t.lead === role ? (org.roles[role]?.reports_to ?? chief) : t.lead;
}
/** Direct reports: a lead's own members plus the leads of the rooms under its team; the CEO's are the top-level leads. */
export function reportsOf(org: Org, role: string): string[] {
  const ceo = officeHolder(org, 'chief_executive');
  if (role === ceo) {
    const own = Object.values(org.teams).find((t) => t.lead === ceo);
    const leads = Object.values(org.teams).filter((t) => !t.parent && t.lead !== ceo).map((t) => t.lead);
    return [...new Set([...leads, ...(own?.members ?? [])])];
  }
  const t = Object.values(org.teams).find((x) => x.lead === role);
  if (!t) return [];
  return [...new Set([...t.members, ...childTeams(org, t.id).map((c) => c.lead)])];
}

export function defaultPermissions(org: Org, role: string): Permission[] {
  if (!org.roles[role]) return [];
  if (role === officeHolder(org, 'chief_executive')) return ['schedule', 'plan', 'review', 'hire', 'fire', 'research_request', 'reprioritize', 'meeting'];
  // The research lead is reached through research_request, never scheduled. When the department is only the lead
  // (v1: the analyst led a team of one) there is nobody to schedule either, so the default set is empty. In the
  // tower template the research room carries five members, so this same rule hands research_manager the full
  // lead set below — accepted and deliberate (spec: Research owns the investigation; R14).
  if (researchLead(org) === role && (teamOf(org, role)?.members.length ?? 0) === 0) return [];
  if (isLead(org, role)) return ['plan', 'schedule', 'review', 'research_request', 'meeting', 'reprioritize'];
  return ['schedule'];
}

function granted(org: Org, role: string): Set<Permission> {
  const explicit = org.roles[role]?.permissions ?? [];
  return new Set(explicit.length ? explicit : defaultPermissions(org, role));
}

/**
 * The one answer to "may this role do that". `target`: the assignee for schedule, the team id for reprioritize.
 * Members may schedule only a teammate (a handoff), never themselves; leads their whole subtree; the CEO anyone.
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
      if (role === officeHolder(org, 'chief_executive')) return true;
      if (target === researchLead(org)) return false;   // research is requested, never scheduled directly
      // A lead owns its whole subtree: the CTO can hand a job straight to an engineer in the Dev room, which is
      // what "managers schedule within their division" means now that divisions list no members of their own.
      if (isLead(org, role)) return Object.values(org.teams).filter((t) => t.lead === role).some((t) => subtreeRoles(org, t.id).includes(target));
      const mine = teamOf(org, role);
      return !!mine && mine.members.includes(target);
    }
    case 'reprioritize': return role === officeHolder(org, 'chief_executive') || !target || teamOf(org, role)?.id === target;
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
  copyDir('Research'); copyDir('Ideas'); copyDir('Discovery'); copyMissing('Metrics/research.md');
  // 3b. The v2 stopgap: division notes listed their rooms' leads as members so a lead could reach them before the
  //     team tree existed. `can(schedule)` walks the tree now, and a doubly-listed lead breaks team size and
  //     `reportsOf`, so take it out wherever a member also leads a team under this one.
  for (const t of Object.values(loadOrg(vault).teams)) {
    const childLeads = new Set(Object.values(loadOrg(vault).teams).filter((c) => c.parent === t.id).map((c) => c.lead));
    const members = t.members.filter((m) => !childLeads.has(m));
    if (members.length === t.members.length) continue;
    const n = vault.readNoteOrNull(`Teams/${t.id}.md`); if (!n) continue;
    vault.writeText(`Teams/${t.id}.md`, stringifyNote({ ...n.data, members }, n.body), 'daemon');
    changed.push(`Teams/${t.id}.md`);
  }
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
  // 6. offices (v2, 2026-09-11): the daemon addresses functions, not names. A vault written before this block keeps
  //    its own values for everything else — only the missing keys are added, each on its own so a hand-edited
  //    constitution that already names some of them is left alone.
  if (patched && !/^offices:/m.test(patched)) {
    const block = ['offices:', ...OFFICES.map((o) => `  ${o}: ${DEFAULT_OFFICES[o]}`)].join('\n');
    patched = patched.replace(/^```ya?ml\s*\n/m, (m) => `${m}${block}\n`);
  }
  if (patched && !/^board_decides_after_hours:/m.test(patched)) {
    patched = patched.replace(/^```ya?ml\s*\n/m, (m) => `${m}board_decides_after_hours: 0\n`);
  }
  if (patched !== c) { vault.writeText('Memory/constitution.md', patched, 'daemon'); changed.push('Memory/constitution.md'); }
  if (changed.length) vault.events.emit({ type: 'org.changed', agent: 'daemon', payload: { reason: 'migration', changed } });
  return { changed };
}
