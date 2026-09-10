import { describe, it, expect } from 'vitest';
import { can, defaultPermissions, leadOf, reportsOf, isLead, type Org } from '../src/org.js';

const role = (r: string, extra: Record<string, unknown> = {}) => ({ role: r, display: r, model_tier: 'medium' as const, tools: [], approval_overrides: {}, active: true, hired: 'x', sprite: r, desk: r, permissions: [], ...extra });
const team = (id: string, lead: string, members: string[]) => ({ id, name: id, lead, members, mission: '', processes: [] });

/** The tower shape, trimmed to the roles the resolver rules are about: divisions hold managers, rooms hold members. */
const MEMBERS: Record<string, string[]> = {
  executive: [], board: ['advisor_investor'], technology: ['dev_manager', 'qa_lead'], dev: ['backend_engineer', 'frontend_engineer'],
  qa: [], revenue: ['cmo'], operations: ['research_manager'], research: ['research_analyst'],
};
const LEADS: Record<string, string> = { executive: 'ceo', board: 'advisor_skeptic', technology: 'cto', dev: 'dev_manager', qa: 'qa_lead', revenue: 'cfo', operations: 'coo', research: 'research_manager' };
const TEAM_OF: Record<string, string> = { ceo: 'executive', advisor_skeptic: 'board', advisor_investor: 'board', cto: 'technology', dev_manager: 'dev', qa_lead: 'qa', backend_engineer: 'dev', frontend_engineer: 'dev', cfo: 'revenue', cmo: 'revenue', coo: 'operations', research_manager: 'research', research_analyst: 'research' };
const REPORTS_TO: Record<string, string> = { ceo: 'owner', advisor_skeptic: 'ceo', advisor_investor: 'advisor_skeptic', cto: 'ceo', dev_manager: 'cto', qa_lead: 'cto', backend_engineer: 'dev_manager', frontend_engineer: 'dev_manager', cfo: 'ceo', cmo: 'cfo', coo: 'ceo', research_manager: 'coo', research_analyst: 'research_manager' };

const org: Org = {
  teams: Object.fromEntries(Object.entries(LEADS).map(([id, lead]) => [id, team(id, lead, MEMBERS[id])])),
  // the advisors carry review+veto explicitly on their charters: the board lead's *default* set is the lead set
  roles: Object.fromEntries(Object.keys(TEAM_OF).map((r) => [r, role(r, { team: TEAM_OF[r], reports_to: REPORTS_TO[r], ...(r.startsWith('advisor_') ? { permissions: ['review', 'veto'] } : {}) })])),
};

/** A v1 (nine-role) org: `defaultPermissions` still has the critic and lone-analyst branches for un-migrated vaults. */
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
    expect(reportsOf(org, 'cto').sort()).toEqual(['dev_manager', 'qa_lead']);
    expect(reportsOf(org, 'dev_manager').sort()).toEqual(['backend_engineer', 'frontend_engineer']);
    expect(reportsOf(org, 'ceo').sort()).toEqual(['advisor_skeptic', 'cfo', 'coo', 'cto', 'dev_manager', 'qa_lead', 'research_manager']);
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
    // an un-migrated v1 vault keeps the old positions
    expect(defaultPermissions(v1Org, 'critic').sort()).toEqual(['review', 'veto']);
    expect(defaultPermissions(v1Org, 'research_analyst')).toEqual([]);
  });
  it('schedule: CEO anyone; lead own members; member only a teammate, never self; the research lead nobody', () => {
    expect(can(org, 'ceo', 'schedule', 'backend_engineer')).toBe(true);
    expect(can(org, 'cto', 'schedule', 'dev_manager')).toBe(true);
    expect(can(org, 'cto', 'schedule', 'backend_engineer')).toBe(false); // the CTO reaches the manager, who reaches the engineers
    expect(can(org, 'dev_manager', 'schedule', 'backend_engineer')).toBe(true);
    expect(can(org, 'cto', 'schedule', 'cfo')).toBe(false);
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
});
