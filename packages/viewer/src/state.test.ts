import { describe, it, expect } from 'vitest';
import { emptyState, applySnapshot, applyEvent, tick, toolIcon, targetFor, type Snapshot } from './state.js';

const snap: Snapshot = { op: 'snapshot', at: 'now', roles: [{ role: 'ceo', display: 'CEO', sprite: 'ceo', desk: 'ceo_cabin', active: true }, { role: 'growth', display: 'Growth', sprite: 'growth', desk: 'cubicle_3', active: true }, { role: 'coo', display: 'COO', sprite: 'coo', desk: 'cubicle_4', active: true }], jobs: [{ id: 'job_1', type: 'research', title: 'r', assigned: 'growth', status: 'running', priority: 3, checkpoint_step: 2, updated: 'now' }], surfaces: [], quota: [], latestRun: null, plan: '# Plan', pendingProposals: 1 };
const ev = (type: string, agent: string | null, payload: Record<string, unknown> = {}, job: string | null = 'job_1') => ({ ts: '2026-09-02T00:00:00.000Z', type, agent, job, payload });

describe('viewer state machine (spec §10)', () => {
  it('snapshot seeds agents at desks and marks running jobs as working', () => {
    const s = applySnapshot(emptyState(), snap);
    expect(s.agents.ceo.state).toBe('idle_at_desk');
    expect(s.agents.growth.state).toBe('working');
    expect(s.agents.growth.job).toBe('job_1');
    expect(s.pendingProposals).toBe(1);
  });
  it('tool calls walk to places and overlay icons; results return to working; done walks home', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('agent.tool_call', 'growth', { tool: 'browser.goto', summary: '{}' }));
    expect(s.agents.growth.state).toBe('walking');
    expect(s.agents.growth.target).toBe('billboard');
    expect(s.agents.growth.tool).toBe('browser');
    s = applyEvent(s, ev('agent.tool_call', 'growth', { tool: 'vault.write' }));
    expect(s.agents.growth.target).toBeNull();
    expect(s.agents.growth.tool).toBe('doc');
    s = applyEvent(s, ev('job.done', 'growth', { status: 'done' }));
    expect(s.jobs.job_1.status).toBe('done');
    expect(s.agents.growth.job).toBeNull();
  });
  it('failed job → error badge and the COO walks over; blocked → ? bubble', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('job.failed', 'growth', { reason: 'x' }));
    expect(s.agents.growth.badge).toBe('error');
    expect(s.agents.coo.target).toBe('desk:growth');
    s = applyEvent(s, ev('job.blocked', 'growth', { reason: 'approval' }));
    expect(s.agents.growth.badge).toBe('blocked');
    expect(s.agents.growth.bubble?.text.startsWith('?')).toBe(true);
    const later = tick(s, Date.now() + 60_000);
    expect(later.agents.growth.bubble).toBeNull();
  });
  it('meetings move participants to the room and turns speak; hire enters, fire leaves', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('meeting.opened', 'ceo', { id: 'm1', room: 'board', participants: ['ceo', 'growth'], agenda: 'x' }, null));
    expect(s.agents.growth.target).toBe('boardroom');
    s = applyEvent(s, ev('meeting.turn', 'growth', { id: 'm1', text: 'we should' }, null));
    expect(s.agents.growth.state).toBe('talking');
    s = applyEvent(s, ev('meeting.closed', 'ceo', { id: 'm1' }, null));
    expect(s.agents.growth.target).toBeNull();
    s = applyEvent(s, ev('role.hired', 'daemon', { role: 'support', display: 'Support', desk: 'cubicle_5', sprite: 'support' }, null));
    expect(s.agents.support.state).toBe('entering');
    s = applyEvent(s, ev('role.fired', 'daemon', { role: 'growth' }, null));
    expect(s.agents.growth.state).toBe('leaving');
  });
  it('surfaces track browser sessions, frames, mail, terminal, proposals, deploys', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('browser.session_started', 'growth', { session: 's1' }));
    s = applyEvent(s, ev('browser.frame', 'growth', { session: 's1', seq: 3, path: '.cubicle/screens/s1/00003.jpg' }));
    expect(s.surfaces.s1.active).toBe(true);
    expect(s.frames.s1.seq).toBe(3);
    s = applyEvent(s, ev('browser.session_ended', 'growth', { session: 's1' }));
    expect(s.surfaces.s1.active).toBe(false);
    s = applyEvent(s, ev('shell.output', 'engineer', { text: 'npm run build' }));
    expect(s.terminal.at(-1)).toBe('npm run build');
    s = applyEvent(s, ev('email.sent', 'growth', { to: 'a@x', subject: 'hi', mock: true }));
    expect(s.mail.at(-1)!.text).toContain('(mock)');
    s = applyEvent(s, ev('proposal.created', 'ceo', { kind: 'brand_change', title: 'Name' }, null));
    expect(s.pendingProposals).toBe(2);
    s = applyEvent(s, ev('proposal.resolved', 'owner', { kind: 'brand_change', approved: true, outcome: 'applied' }, null));
    expect(s.pendingProposals).toBe(1);
    s = applyEvent(s, ev('deploy.done', 'engineer', { url: 'https://x.pages.dev' }));
    expect(s.deploys.at(-1)!.url).toBe('https://x.pages.dev');
  });
  it('icons and targets', () => {
    expect(toolIcon('email.send')).toBe('envelope');
    expect(targetFor('shell.run')).toBe('terminal');
    expect(targetFor('vault.read')).toBeNull();
  });
});

describe('critique 7-9 reducer fixes', () => {
  it('snapshot resets stale in-flight states, keeps a still-running job, bounds surfaces; fired agents are inert; arrival resumes working', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('agent.tool_call', 'growth', { tool: 'browser.goto' }));
    expect(s.agents.growth.state).toBe('walking');
    s = applyEvent(s, ev('agent.tool_result', 'growth', { tool: 'browser.goto', ok: true }));
    expect(s.agents.growth.state).toBe('walking'); // still has a target → keeps walking
    s = applyEvent(s, ev('agent.tool_call', 'growth', { tool: 'vault.write' }));
    s = applyEvent(s, ev('agent.tool_result', 'growth', { tool: 'vault.write', ok: true }));
    expect(s.agents.growth.state).toBe('working'); // no target → back to typing
    const again = applySnapshot(s, { ...snap, jobs: [] }); // job gone while disconnected
    expect(again.agents.growth.state).toBe('idle_at_desk');
    expect(again.agents.growth.job).toBeNull();
    const still = applySnapshot(s, snap);
    expect(still.agents.growth.state).toBe('working');
    let f = applyEvent(s, ev('role.fired', 'daemon', { role: 'growth' }, null));
    f = applyEvent(f, ev('agent.tool_call', 'growth', { tool: 'browser.goto' }));
    expect(f.agents.growth.state).toBe('leaving');
    const d = applyEvent(s, ev('vault.wrote', 'ceo', { path: 'Decisions/d1.md', sha: 'x', by: 'ceo' }, null));
    expect(d.feed.at(-1)!.text).toContain('decision recorded');
    expect(applyEvent(s, ev('vault.wrote', 'cto', { path: 'Plans/plan.md', sha: 'x', by: 'cto' }, null)).staleSnapshot).toBe(true);
  });
});
