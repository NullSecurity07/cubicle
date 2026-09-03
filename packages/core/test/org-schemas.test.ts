import { describe, it, expect } from 'vitest';
import { TeamFrontmatter, RoleFrontmatter, JobFrontmatter, JobStatus, ProposalKind, Constitution, KNOWN_JOB_TYPES, EVENT_TYPES, JobResult, PERMISSIONS } from '../src/schemas.js';

describe('org schemas', () => {
  it('parses a team note and rejects a team without a lead', () => {
    const t = TeamFrontmatter.parse({ id: 'engineering', name: 'Engineering', lead: 'cto', members: ['tech_lead', 'engineer', 'qa'], mission: 'Ship.' });
    expect(t.processes).toEqual([]); expect(t.room).toBeUndefined();
    expect(() => TeamFrontmatter.parse({ id: 'x', name: 'X', members: [] })).toThrow();
  });
  it('role charters accept org fields with defaults and validate permissions', () => {
    const r = RoleFrontmatter.parse({ role: 'qa', display: 'QA', hired: 'now', sprite: 'qa', desk: 'cubicle_5', team: 'engineering', reports_to: 'cto', title: 'QA Engineer', persona: 'James Bach.' });
    expect(r.permissions).toEqual([]);
    expect(() => RoleFrontmatter.parse({ role: 'qa', display: 'QA', hired: 'now', sprite: 'qa', desk: 'd', permissions: ['launch_nukes'] })).toThrow();
    expect(PERMISSIONS).toEqual(['schedule', 'plan', 'review', 'hire', 'fire', 'veto', 'research_request', 'reprioritize', 'meeting']);
  });
  it('jobs carry team, owner_role, for, done_when, returns and the in_review status', () => {
    const j = JobFrontmatter.parse({ id: 'job_1', type: 'research', title: 't', assigned: 'research_analyst', created: 'c', updated: 'u', team: 'research', owner_role: 'cto', for: 'cto', done_when: 'ADR exists', status: 'in_review' });
    expect(j.returns).toEqual({}); expect(JobStatus.options).toContain('in_review');
  });
  it('new kinds, types, events, constitution fields and finish verdicts exist', () => {
    expect(ProposalKind.options).toContain('reorg');
    expect(Constitution.parse({})).toMatchObject({ max_team_size: 6, auto_approve_reorg: false });
    for (const t of ['team.plan', 'critic.premortem', 'qa.review', 'company.plan']) expect(KNOWN_JOB_TYPES).toContain(t);
    for (const e of ['team.planned', 'review.passed', 'review.returned', 'plan.vetoed', 'research.delivered', 'org.changed']) expect(EVENT_TYPES).toContain(e);
    expect(JobResult.parse({ status: 'done', verdict: 'return', findings: ['no tests'] }).findings).toEqual(['no tests']);
  });
});
