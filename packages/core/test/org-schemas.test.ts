import { describe, it, expect } from 'vitest';
import { TeamFrontmatter, RoleFrontmatter, JobFrontmatter, JobStatus, ProposalKind, Constitution, KNOWN_JOB_TYPES, EVENT_TYPES, JobResult, PERMISSIONS } from '../src/schemas.js';

describe('org schemas', () => {
  it('parses a team note and rejects a team without a lead', () => {
    const t = TeamFrontmatter.parse({ id: 'dev', name: 'Dev', lead: 'dev_manager', members: ['backend_engineer', 'frontend_engineer', 'sre'], mission: 'Ship.' });
    expect(t.processes).toEqual([]); expect(t.room).toBeUndefined();
    expect(() => TeamFrontmatter.parse({ id: 'x', name: 'X', members: [] })).toThrow();
  });
  it('a team note may carry its room, floor and parent division', () => {
    const t = TeamFrontmatter.parse({ id: 'dev', name: 'Dev', lead: 'dev_manager', room: 'dev', floor: 2, parent: 'technology' });
    expect(t).toMatchObject({ room: 'dev', floor: 2, parent: 'technology' });
    expect(TeamFrontmatter.parse({ id: 'x', name: 'X', lead: 'ceo' }).floor).toBeUndefined();
    expect(() => TeamFrontmatter.parse({ id: 'x', name: 'X', lead: 'ceo', floor: 'two' })).toThrow();
  });
  it('role charters accept org fields with defaults and validate permissions', () => {
    const r = RoleFrontmatter.parse({ role: 'qa_lead', display: 'QA Lead', hired: 'now', sprite: 'qa_lead', desk: 'qa_lead', team: 'qa', reports_to: 'cto', title: 'Quality Engineering Lead', persona: 'James Bach.' });
    expect(r.permissions).toEqual([]);
    expect(() => RoleFrontmatter.parse({ role: 'qa_lead', display: 'QA Lead', hired: 'now', sprite: 'qa_lead', desk: 'd', permissions: ['launch_nukes'] })).toThrow();
    expect(PERMISSIONS).toEqual(['schedule', 'plan', 'review', 'hire', 'fire', 'veto', 'research_request', 'reprioritize', 'meeting']);
  });
  it('jobs carry team, owner_role, for, done_when, returns and the in_review status', () => {
    const j = JobFrontmatter.parse({ id: 'job_1', type: 'research', title: 't', assigned: 'research_manager', created: 'c', updated: 'u', team: 'research', owner_role: 'cto', for: 'cto', done_when: 'ADR exists', status: 'in_review' });
    expect(j.returns).toEqual({}); expect(JobStatus.options).toContain('in_review');
  });
  it('new kinds, types, events, constitution fields and finish verdicts exist', () => {
    expect(ProposalKind.options).toContain('reorg');
    expect(Constitution.parse({})).toMatchObject({ max_team_size: 6, auto_approve_reorg: false });
    for (const t of ['team.plan', 'division.plan', 'critic.premortem', 'board.premortem', 'team:qa.review', 'office:operations.verify', 'office:security.review', 'company.plan']) expect(KNOWN_JOB_TYPES).toContain(t);
    for (const t of ['qa.review', 'coo.verify', 'security.review']) expect(KNOWN_JOB_TYPES).toContain(t);   // pre-office names stay valid for jobs queued before the rename
    for (const e of ['team.planned', 'review.passed', 'review.returned', 'plan.vetoed', 'research.delivered', 'org.changed']) expect(EVENT_TYPES).toContain(e);
    expect(JobResult.parse({ status: 'done', verdict: 'return', findings: ['no tests'] }).findings).toEqual(['no tests']);
  });
});
