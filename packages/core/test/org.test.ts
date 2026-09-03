import { describe, it, expect } from 'vitest';
import { can, defaultPermissions, leadOf, reportsOf, isLead, type Org } from '../src/org.js';

const role = (r: string, extra: Record<string, unknown> = {}) => ({ role: r, display: r, model_tier: 'medium' as const, tools: [], approval_overrides: {}, active: true, hired: 'x', sprite: r, desk: r, permissions: [], ...extra });
const org: Org = {
  teams: {
    strategy: { id: 'strategy', name: 'Strategy', lead: 'ceo', members: ['critic'], mission: '', processes: [] },
    engineering: { id: 'engineering', name: 'Engineering', lead: 'cto', members: ['tech_lead', 'engineer', 'qa'], mission: '', processes: [] },
    growth: { id: 'growth', name: 'Growth', lead: 'head_of_growth', members: [], mission: '', processes: [] },
    operations: { id: 'operations', name: 'Operations', lead: 'coo', members: [], mission: '', processes: [] },
    research: { id: 'research', name: 'Research', lead: 'research_analyst', members: [], mission: '', processes: [] },
  },
  roles: Object.fromEntries(['ceo', 'critic', 'cto', 'tech_lead', 'engineer', 'qa', 'head_of_growth', 'coo', 'research_analyst'].map((r) => [r, role(r, { team: r === 'ceo' || r === 'critic' ? 'strategy' : ['cto', 'tech_lead', 'engineer', 'qa'].includes(r) ? 'engineering' : r === 'head_of_growth' ? 'growth' : r === 'coo' ? 'operations' : 'research', reports_to: r === 'ceo' ? 'owner' : ['critic', 'cto', 'head_of_growth', 'coo', 'research_analyst'].includes(r) ? 'ceo' : 'cto' })])),
};

describe('org resolver (spec §2)', () => {
  it('structure helpers', () => {
    expect(leadOf(org, 'engineer')).toBe('cto'); expect(leadOf(org, 'ceo')).toBe('owner');
    expect(isLead(org, 'cto')).toBe(true); expect(isLead(org, 'engineer')).toBe(false);
    expect(reportsOf(org, 'cto').sort()).toEqual(['engineer', 'qa', 'tech_lead']);
    expect(reportsOf(org, 'ceo').sort()).toEqual(['coo', 'critic', 'cto', 'head_of_growth', 'research_analyst']);
  });
  it('default permissions by position', () => {
    expect(defaultPermissions(org, 'ceo').sort()).toEqual(['hire', 'fire', 'meeting', 'plan', 'reprioritize', 'research_request', 'review', 'schedule'].sort());
    expect(defaultPermissions(org, 'cto').sort()).toEqual(['meeting', 'plan', 'reprioritize', 'research_request', 'review', 'schedule'].sort());
    expect(defaultPermissions(org, 'engineer')).toEqual(['schedule']);
    expect(defaultPermissions(org, 'critic').sort()).toEqual(['review', 'veto']);
    expect(defaultPermissions(org, 'research_analyst')).toEqual([]);
  });
  it('schedule: CEO anyone; lead own members; member only a teammate, never self; analyst nobody', () => {
    expect(can(org, 'ceo', 'schedule', 'engineer')).toBe(true);
    expect(can(org, 'cto', 'schedule', 'engineer')).toBe(true);
    expect(can(org, 'cto', 'schedule', 'head_of_growth')).toBe(false);
    expect(can(org, 'engineer', 'schedule', 'qa')).toBe(true);
    expect(can(org, 'engineer', 'schedule', 'engineer')).toBe(false);
    expect(can(org, 'engineer', 'schedule', 'head_of_growth')).toBe(false);
    expect(can(org, 'research_analyst', 'schedule', 'engineer')).toBe(false);
    expect(can(org, 'head_of_growth', 'schedule', 'research_analyst')).toBe(false); // research goes through research_request
    expect(can(org, 'head_of_growth', 'research_request')).toBe(true);
    expect(can(org, 'engineer', 'research_request')).toBe(false);
  });
  it('hire/fire only the CEO; veto only the Critic; reprioritize scoped to own team', () => {
    expect(can(org, 'ceo', 'hire')).toBe(true); expect(can(org, 'cto', 'hire')).toBe(false);
    expect(can(org, 'critic', 'veto')).toBe(true); expect(can(org, 'ceo', 'veto')).toBe(false);
    expect(can(org, 'cto', 'reprioritize', 'engineering')).toBe(true); expect(can(org, 'cto', 'reprioritize', 'growth')).toBe(false);
    expect(can(org, 'ceo', 'reprioritize', 'growth')).toBe(true);
  });
  it('charter permissions override the defaults, and unknown roles can do nothing', () => {
    const o2: Org = { ...org, roles: { ...org.roles, engineer: role('engineer', { team: 'engineering', reports_to: 'cto', permissions: ['research_request'] }) } };
    expect(can(o2, 'engineer', 'research_request')).toBe(true);
    expect(can(o2, 'engineer', 'schedule', 'qa')).toBe(false); // explicit list replaces defaults
    expect(can(org, 'nobody', 'schedule', 'qa')).toBe(false);
  });
});
