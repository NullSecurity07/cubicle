import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { can, defaultPermissions, leadOf, reportsOf, isLead, subtreeRoles, roleWithTool, loadOrg, type Org } from '../src/org.js';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { stringifyNote, parseNote } from '../src/frontmatter.js';

const role = (r: string, extra: Record<string, unknown> = {}) => ({ role: r, display: r, model_tier: 'medium' as const, tools: [], approval_overrides: {}, active: true, hired: 'x', sprite: r, desk: r, permissions: [], ...extra });
const team = (id: string, lead: string, members: string[], parent?: string) => ({ id, name: id, lead, members, mission: '', processes: [], ...(parent ? { parent } : {}) });

/** The tower shape: divisions hold no members of their own, the rooms under them do. */
const MEMBERS: Record<string, string[]> = {
  executive: [], board: ['advisor_investor'], technology: [], dev: ['backend_engineer', 'frontend_engineer'],
  qa: [], revenue: ['cmo'], operations: [], research: ['research_analyst'],
};
const LEADS: Record<string, string> = { executive: 'ceo', board: 'advisor_skeptic', technology: 'cto', dev: 'dev_manager', qa: 'qa_lead', revenue: 'cfo', operations: 'coo', research: 'research_manager' };
const PARENTS: Record<string, string | undefined> = { dev: 'technology', qa: 'technology', research: 'operations' };
const TEAM_OF: Record<string, string> = { ceo: 'executive', advisor_skeptic: 'board', advisor_investor: 'board', cto: 'technology', dev_manager: 'dev', qa_lead: 'qa', backend_engineer: 'dev', frontend_engineer: 'dev', cfo: 'revenue', cmo: 'revenue', coo: 'operations', research_manager: 'research', research_analyst: 'research' };
const REPORTS_TO: Record<string, string> = { ceo: 'owner', advisor_skeptic: 'ceo', advisor_investor: 'advisor_skeptic', cto: 'ceo', dev_manager: 'cto', qa_lead: 'cto', backend_engineer: 'dev_manager', frontend_engineer: 'dev_manager', cfo: 'ceo', cmo: 'cfo', coo: 'ceo', research_manager: 'coo', research_analyst: 'research_manager' };

const org: Org = {
  teams: Object.fromEntries(Object.entries(LEADS).map(([id, lead]) => [id, team(id, lead, MEMBERS[id], PARENTS[id])])),
  // the advisors carry review+veto explicitly on their charters: the board lead's *default* set is the lead set
  roles: Object.fromEntries(Object.keys(TEAM_OF).map((r) => [r, role(r, { team: TEAM_OF[r], reports_to: REPORTS_TO[r], ...(r.startsWith('advisor_') ? { permissions: ['review', 'veto'] } : {}) })])),
};

/** A v1 (nine-role) org: `defaultPermissions` still has the lone-analyst branch for un-migrated vaults. */
const v1Org: Org = {
  teams: { strategy: team('strategy', 'ceo', ['critic']), research: team('research', 'research_analyst', []) },
  roles: Object.fromEntries([['ceo', 'strategy'], ['critic', 'strategy'], ['research_analyst', 'research']].map(([r, t]) => [r, role(r, { team: t, reports_to: r === 'ceo' ? 'owner' : 'ceo' })])),
};

const LEAD_SET = ['meeting', 'plan', 'reprioritize', 'research_request', 'review', 'schedule'];

describe('org resolver (spec §2)', () => {
  it('structure helpers', () => {
    expect(leadOf(org, 'backend_engineer')).toBe('dev_manager'); expect(leadOf(org, 'ceo')).toBe('owner');
    expect(leadOf(org, 'dev_manager')).toBe('cto'); expect(leadOf(org, 'advisor_investor')).toBe('advisor_skeptic');
    expect(isLead(org, 'cto')).toBe(true); expect(isLead(org, 'backend_engineer')).toBe(false);
    // a division lead's reports are the leads of its rooms, even though the division note lists no members
    expect(reportsOf(org, 'cto').sort()).toEqual(['dev_manager', 'qa_lead']);
    expect(reportsOf(org, 'dev_manager').sort()).toEqual(['backend_engineer', 'frontend_engineer']);
    // the CEO's reports are the leads of the top-level teams plus its own team's members
    expect(reportsOf(org, 'ceo').sort()).toEqual(['advisor_skeptic', 'cfo', 'coo', 'cto']);
  });
  it('default permissions by position', () => {
    expect(defaultPermissions(org, 'ceo').sort()).toEqual(['hire', 'fire', 'meeting', 'plan', 'reprioritize', 'research_request', 'review', 'schedule'].sort());
    expect(defaultPermissions(org, 'cto').sort()).toEqual(LEAD_SET);
    expect(defaultPermissions(org, 'dev_manager').sort()).toEqual(LEAD_SET);
    expect(defaultPermissions(org, 'backend_engineer')).toEqual(['schedule']);
    // the tower's advisors and research analyst are ordinary positions; their veto (and the research lead's
    // unschedulability) come from the charter and from `can`, not from a special case in the default set
    expect(defaultPermissions(org, 'advisor_skeptic').sort()).toEqual(LEAD_SET);
    expect(defaultPermissions(org, 'advisor_investor')).toEqual(['schedule']);
    expect(defaultPermissions(org, 'research_manager').sort()).toEqual(LEAD_SET);
    expect(defaultPermissions(org, 'research_analyst')).toEqual(['schedule']);
    // an un-migrated v1 vault keeps the lone-analyst position; the critic's review+veto is no longer a name-based
    // default (that special case is gone) — a v1 critic charter carries them as explicit `permissions` instead
    expect(defaultPermissions(v1Org, 'critic')).toEqual(['schedule']);
    expect(defaultPermissions(v1Org, 'research_analyst')).toEqual([]);
  });
  it('schedule: CEO anyone; lead own members; member only a teammate, never self; the research lead nobody', () => {
    expect(can(org, 'ceo', 'schedule', 'backend_engineer')).toBe(true);
    expect(can(org, 'cto', 'schedule', 'dev_manager')).toBe(true);
    // a lead schedules anyone in its subtree — a division lead reaches the rooms under it
    expect(can(org, 'cto', 'schedule', 'backend_engineer')).toBe(true);
    expect(can(org, 'cto', 'schedule', 'qa_lead')).toBe(true);
    expect(can(org, 'cto', 'schedule', 'cmo')).toBe(false);          // another division
    expect(can(org, 'dev_manager', 'schedule', 'backend_engineer')).toBe(true);
    expect(can(org, 'backend_engineer', 'schedule', 'frontend_engineer')).toBe(true);
    expect(can(org, 'backend_engineer', 'schedule', 'backend_engineer')).toBe(false);
    expect(can(org, 'backend_engineer', 'schedule', 'cmo')).toBe(false);
    expect(can(org, 'research_manager', 'schedule', 'backend_engineer')).toBe(false);
    expect(can(org, 'cfo', 'schedule', 'research_manager')).toBe(false); // research goes through research_request
    expect(can(org, 'cfo', 'research_request')).toBe(true);
    expect(can(org, 'backend_engineer', 'research_request')).toBe(false);
  });
  it('hire/fire only the CEO; veto only the board; reprioritize scoped to own team', () => {
    expect(can(org, 'ceo', 'hire')).toBe(true); expect(can(org, 'cto', 'hire')).toBe(false);
    expect(can(org, 'advisor_skeptic', 'veto')).toBe(true); expect(can(org, 'advisor_investor', 'veto')).toBe(true); expect(can(org, 'ceo', 'veto')).toBe(false);
    expect(can(org, 'cto', 'reprioritize', 'technology')).toBe(true); expect(can(org, 'cto', 'reprioritize', 'revenue')).toBe(false);
    expect(can(org, 'ceo', 'reprioritize', 'revenue')).toBe(true);
  });
  it('charter permissions override the defaults, and unknown roles can do nothing', () => {
    const o2: Org = { ...org, roles: { ...org.roles, backend_engineer: role('backend_engineer', { team: 'dev', reports_to: 'dev_manager', permissions: ['research_request'] }) } };
    expect(can(o2, 'backend_engineer', 'research_request')).toBe(true);
    expect(can(o2, 'backend_engineer', 'schedule', 'frontend_engineer')).toBe(false); // explicit list replaces defaults
    expect(can(org, 'nobody', 'schedule', 'frontend_engineer')).toBe(false);
  });
  it('self-schedule guard defends against malformed orgs where lead is in members', () => {
    const malformed: Org = { ...org, teams: { ...org.teams, dev: { ...org.teams.dev, members: [...MEMBERS.dev, 'dev_manager'] } } };
    expect(can(malformed, 'dev_manager', 'schedule', 'dev_manager')).toBe(false); // lead cannot schedule self even if in members
    expect(can(malformed, 'ceo', 'schedule', 'ceo')).toBe(false); // CEO cannot schedule self
  });

  it('the team tree decides who a lead may schedule, and members still only reach their own room', () => {
    expect(subtreeRoles(org, 'technology').sort()).toEqual(['backend_engineer', 'cto', 'dev_manager', 'frontend_engineer', 'qa_lead']);
    expect(subtreeRoles(org, 'dev').sort()).toEqual(['backend_engineer', 'dev_manager', 'frontend_engineer']);
    expect(can(org, 'dev_manager', 'schedule', 'qa_lead')).toBe(false);     // a sibling room is not below you
    expect(can(org, 'backend_engineer', 'schedule', 'qa_lead')).toBe(false);
    expect(can(org, 'backend_engineer', 'schedule', 'frontend_engineer')).toBe(true);
    expect(can(org, 'coo', 'schedule', 'research_analyst')).toBe(true);     // a member of a room in your division
    expect(can(org, 'coo', 'schedule', 'research_manager')).toBe(false);    // …but the research lead is requested, never scheduled
    expect(roleWithTool({ ...org, roles: { ...org.roles, backend_engineer: role('backend_engineer', { team: 'dev', tools: ['deploy.site', 'finish'] }) } }, 'technology', 'deploy.site')).toBe('backend_engineer');
    expect(roleWithTool(org, 'technology', 'deploy.site')).toBeNull();
    expect(roleWithTool(org, undefined, 'deploy.site')).toBeNull();
  });
});

/**
 * `loadOrg` caches its result per `Vault` (org.ts) — nextJob's WIP check calls it on every idle
 * worker's poll, so re-reading every Teams/Roles note on every call was expensive enough, under
 * load, to push a heartbeat cycle past a test timeout. The cache must still see every way a
 * Teams/ or Roles/ note can change: an agent write through the Vault API (`vault.wrote`), and an
 * owner edit made straight in Obsidian, which never goes through that API and instead reaches the
 * vault as `owner.edited` from `VaultWatcher` (including a delete/rename, reported as
 * `owner.edited` with `deleted: true`) — and it must never leak across two different vaults.
 */
describe('loadOrg caching (perf fix)', () => {
  let dir: string; let vault: Vault;
  beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-orgcache-')); vault = (await scaffoldVault(dir)).vault; });
  afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

  it('a role written through the Vault API (vault.wrote) invalidates the cache', () => {
    expect(loadOrg(vault).roles.temp_role).toBeUndefined();
    vault.writeNote('Roles/temp_role.md', { role: 'temp_role', display: 'Temp Role', active: true, hired: '2026-01-01', sprite: 'temp_role', desk: 'temp_role' }, '', 'owner');
    expect(loadOrg(vault).roles.temp_role).toBeDefined();
    expect(loadOrg(vault).roles.temp_role.display).toBe('Temp Role');
  });

  it('an owner edit made straight on disk (no vault.wrote) is picked up once the watcher reports owner.edited', () => {
    const rel = 'Roles/backend_engineer.md';
    const before = loadOrg(vault).roles.backend_engineer;
    expect(before).toBeDefined();
    expect(before.display).not.toBe('Edited In Obsidian');

    // Edit the file on disk directly, the way Obsidian would — bypassing vault.writeNote entirely,
    // so no vault.wrote fires. The cache must still be holding the pre-edit value here.
    const note = parseNote(vault.readText(rel));
    writeFileSync(path.join(vault.root, rel), stringifyNote({ ...note.data, display: 'Edited In Obsidian' }, note.body));
    expect(loadOrg(vault).roles.backend_engineer.display).not.toBe('Edited In Obsidian'); // still cached

    // VaultWatcher (watcher.ts) is what notices a disk-only change and emits this; simulate it directly
    // rather than starting a real chokidar watcher (debounced, filesystem-timing-dependent) in a unit test.
    vault.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: rel, area: 'Roles', deleted: false } });
    expect(loadOrg(vault).roles.backend_engineer.display).toBe('Edited In Obsidian');
  });

  it('a deleted/renamed role (owner.edited with deleted: true) invalidates the cache too', () => {
    vault.writeNote('Roles/temp_role.md', { role: 'temp_role', display: 'Temp Role', active: true, hired: '2026-01-01', sprite: 'temp_role', desk: 'temp_role' }, '', 'owner');
    expect(loadOrg(vault).roles.temp_role).toBeDefined();
    // A rename/delete made outside the Vault API: remove the file, no vault.wrote, only the watcher's
    // owner.edited({ deleted: true }) — same as VaultWatcher.fire() emits for an `unlink`.
    rmSync(path.join(vault.root, 'Roles/temp_role.md'));
    vault.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: 'Roles/temp_role.md', area: 'Roles', deleted: true } });
    expect(loadOrg(vault).roles.temp_role).toBeUndefined();
  });

  it('two Vault instances never share a cache entry, even for the same role id', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'cubicle-orgcache-2-'));
    try {
      const vault2 = (await scaffoldVault(dir2)).vault;
      try {
        vault.writeNote('Roles/temp_role.md', { role: 'temp_role', display: 'Only In Vault One', active: true, hired: '2026-01-01', sprite: 'temp_role', desk: 'temp_role' }, '', 'owner');
        expect(loadOrg(vault).roles.temp_role?.display).toBe('Only In Vault One');
        expect(loadOrg(vault2).roles.temp_role).toBeUndefined();
      } finally { vault2.close(); }
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  });
});
