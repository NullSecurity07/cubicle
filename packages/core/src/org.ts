import { TeamFrontmatter, RoleFrontmatter, type Permission } from './schemas.js';
import type { Vault } from './vault.js';

export interface Org { teams: Record<string, TeamFrontmatter>; roles: Record<string, RoleFrontmatter> }
export type Action = Permission;

/** Teams/*.md + active Roles/*.md (never archive/ or _hireable/). Pure read; call per tick, it is cheap. */
export function loadOrg(vault: Vault): Org {
  const teams: Org['teams'] = {};
  for (const rel of vault.list('Teams', { ext: '.md' })) {
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

export function teamOf(org: Org, role: string): TeamFrontmatter | null {
  const byField = org.roles[role]?.team;
  if (byField && org.teams[byField]) return org.teams[byField];
  return Object.values(org.teams).find((t) => t.lead === role || t.members.includes(role)) ?? null;
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
  if (role === 'critic') return ['review', 'veto'];
  if (role === 'research_analyst') return [];
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
      if (target === 'research_analyst') return false;
      if (isLead(org, role)) return reportsOf(org, role).includes(target);
      const mine = teamOf(org, role);
      return !!mine && mine.members.includes(target);
    }
    case 'reprioritize': return role === 'ceo' || !target || teamOf(org, role)?.id === target;
    default: return true;
  }
}
