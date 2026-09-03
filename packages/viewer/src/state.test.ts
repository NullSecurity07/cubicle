import { describe, it, expect } from 'vitest';
import { emptyState, applySnapshot, applyEvent, tick, toolIcon, targetFor, actionVerb, SLEEP_AFTER_MS, type Snapshot } from './state.js';

const snap: Snapshot = { op: 'snapshot', at: 'now', roles: [{ role: 'ceo', display: 'CEO', sprite: 'ceo', desk: 'ceo_cabin', active: true }, { role: 'growth', display: 'Growth', sprite: 'growth', desk: 'cubicle_3', active: true }, { role: 'coo', display: 'COO', sprite: 'coo', desk: 'cubicle_4', active: true }], jobs: [{ id: 'job_1', type: 'research', title: 'r', assigned: 'growth', status: 'running', priority: 3, checkpoint_step: 2, updated: 'now' }], surfaces: [], quota: [], latestRun: null, plan: '# Plan', pendingProposals: 1 };
const ev = (type: string, agent: string | null, payload: Record<string, unknown> = {}, job: string | null = 'job_1') => ({ ts: '2026-09-02T00:00:00.000Z', type, agent, job, payload });

describe('viewer state machine (spec §10)', () => {
  it('snapshot carries brand and pending inbox rows; proposal events mark the snapshot stale so the list refreshes', () => {
    let s = applySnapshot(emptyState(), { ...snap, brand: { name: 'PlateReady', tagline: 'Meal plans', url: '' }, inbox: [{ id: 'p1', kind: 'spend', title: 'Deploy the site', path: '00 Inbox/x.md', created: 'now' }] });
    expect(s.brand.name).toBe('PlateReady');
    expect(s.inbox[0].title).toBe('Deploy the site');
    s = applyEvent(s, ev('proposal.created', 'engineer', { kind: 'spend', title: 't' }));
    expect(s.staleSnapshot).toBe(true);
    s = applySnapshot(s, snap); // an older daemon without the fields still works
    expect(s.brand.name).toBe('');
    expect(s.inbox).toEqual([]);
  });
  it('snapshot chat history replaces local lines, keeping a just-sent message the note does not have yet', () => {
    let s = applyEvent(applySnapshot(emptyState(), snap), ev('agent.spoke', 'ceo', { to: 'owner', text: 'Got it.' }));
    s = { ...s, chat: [...s.chat, { ts: '2026-09-03T05:00:00.000Z', from: 'you', text: 'Add a pricing page' }] };
    s = applySnapshot(s, { ...snap, chat: [{ ts: '2026-09-03T04:37:00.000Z', from: 'you', text: 'A meal site' }, { ts: '2026-09-03T04:46:00.000Z', from: 'ceo', text: 'Got it.' }] });
    expect(s.chat.map((m) => m.text)).toEqual(['A meal site', 'Got it.', 'Add a pricing page']);
  });
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
    expect(s.agents.growth.bubble?.kind).toBe('thought');
    expect(s.agents.growth.emote?.kind).toBe('?');
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

  describe('expressions (moods, emotes, bubble kinds)', () => {
    const base = () => applySnapshot(emptyState(), snap);
    it('thinking → thought bubble with no text and a thinking face; a tool call → action bubble with a verb', () => {
      let s = applyEvent(base(), ev('agent.thinking', 'growth', { step: 1 }), 1000);
      expect(s.agents.growth.bubble).toEqual({ kind: 'thought', text: '', until: 5000 });
      expect(s.agents.growth.mood).toBe('thinking');
      s = applyEvent(s, ev('agent.tool_call', 'growth', { tool: 'browser.goto', summary: '{"url":"https://example.com/a"}' }), 2000);
      expect(s.agents.growth.bubble).toMatchObject({ kind: 'action', text: 'opening example.com' });
      s = applyEvent(s, ev('agent.tool_result', 'growth', { tool: 'browser.goto', ok: true }), 2500);
      expect(s.agents.growth.bubble).toBeNull();
      s = applyEvent(s, ev('agent.tool_result', 'growth', { tool: 'shell.run', ok: false }), 2600);
      expect(s.agents.growth.mood).toBe('worried');
      expect(s.agents.growth.emote?.kind).toBe('sweat');
    });
    it('speech bubbles for spoke and meeting turns; job done → happy + cheer; failed → worried + sweat, COO brings a clipboard', () => {
      let s = applyEvent(base(), ev('agent.spoke', 'growth', { to: 'cto', text: 'hi' }), 1000);
      expect(s.agents.growth.bubble?.kind).toBe('speech');
      s = applyEvent(s, ev('meeting.turn', 'coo', { id: 'm', text: 'ok' }), 1000);
      expect(s.agents.coo.bubble?.kind).toBe('speech');
      s = applyEvent(s, ev('job.done', 'growth', { status: 'done' }), 2000);
      expect(s.agents.growth.mood).toBe('happy'); expect(s.agents.growth.emote?.kind).toBe('cheer');
      s = applyEvent(s, ev('job.started', 'growth', {}), 3000);
      s = applyEvent(s, ev('job.failed', 'growth', { reason: 'x' }), 4000);
      expect(s.agents.growth.mood).toBe('worried'); expect(s.agents.growth.emote?.kind).toBe('sweat');
      expect(s.agents.coo.emote?.kind).toBe('clipboard'); expect(s.agents.coo.target).toBe('desk:growth');
    });
    it('blocked → puzzled face, ? emote and a thought bubble with the reason', () => {
      const s = applyEvent(base(), ev('job.blocked', 'growth', { reason: 'need a key' }), 1000);
      expect(s.agents.growth.mood).toBe('puzzled'); expect(s.agents.growth.emote?.kind).toBe('?');
      expect(s.agents.growth.bubble).toMatchObject({ kind: 'thought', text: 'need a key' });
    });
    it('deploy.done cheers everyone; an owner message makes the CEO wave; a hire arrives with a heart', () => {
      let s = applyEvent(base(), ev('deploy.done', 'engineer', { url: 'https://x.pages.dev' }, null), 1000);
      for (const r of ['ceo', 'growth', 'coo']) { expect(s.agents[r].mood).toBe('happy'); expect(s.agents[r].emote?.kind).toBe('cheer'); }
      s = applyEvent(s, ev('proposal.created', 'owner', { kind: 'message', to: 'ceo', title: 'Build a site' }, null), 2000);
      expect(s.agents.ceo.emote?.kind).toBe('wave');
      s = applyEvent(s, ev('role.hired', 'daemon', { role: 'support', display: 'Support', desk: 'cubicle_5', sprite: 'support' }, null), 3000);
      expect(s.agents.support.emote?.kind).toBe('heart'); expect(s.agents.support.mood).toBe('happy');
    });
    it('moods and emotes expire on tick; a long quiet desk dozes off with zzz and any event wakes it', () => {
      let s = applyEvent(base(), ev('job.done', 'coo', { status: 'done' }), 1000);
      s = tick(s, 7000);
      expect(s.agents.coo.mood).toBe('neutral'); expect(s.agents.coo.emote).toBeNull();
      s = applyEvent(s, ev('job.cancelled', 'coo', {}), 8000); // idle at the desk from now on
      s = tick(s, 8000 + SLEEP_AFTER_MS + 1);
      expect(s.agents.coo.mood).toBe('asleep'); expect(s.agents.coo.emote?.kind).toBe('zzz');
      s = applyEvent(s, ev('agent.spoke', 'coo', { to: 'ceo', text: 'awake' }), 8000 + SLEEP_AFTER_MS + 2);
      expect(s.agents.coo.mood).toBe('neutral'); expect(s.agents.coo.emote).toBeNull();
    });
    it('actionVerb turns tool calls into short present-tense lines', () => {
      expect(actionVerb('shell.run', '{"cmd":"npm run build"}')).toBe('running npm run build');
      expect(actionVerb('vault.write', '{"path":"Plans/plan.md"}')).toBe('writing Plans/plan.md');
      expect(actionVerb('email.send', {})).toBe('sending an email');
      expect(actionVerb('finish', '')).toBe('wrapping up');
      expect(actionVerb('shell.run', 'not json at all but a very long command line that keeps going').length).toBeLessThanOrEqual(34);
    });

    it('review, veto, research and team.planned events drive expressions', () => {
      let s = applySnapshot(emptyState(), { ...snap, roles: [...snap.roles, { role: 'qa', display: 'QA', sprite: 'qa', desk: 'cubicle_5', active: true }, { role: 'critic', display: 'Critic', sprite: 'critic', desk: 'cubicle_9', active: true }, { role: 'research_analyst', display: 'Research', sprite: 'research_analyst', desk: 'cubicle_7', active: true }] });
      s = applyEvent(s, ev('review.returned', 'qa', { gate: 'qa.review', findings: ['no title'] }), 1000);
      expect(s.agents.growth.mood).toBe('worried'); expect(s.agents.qa.bubble).toMatchObject({ kind: 'speech', text: expect.stringContaining('no title') });
      s = applyEvent(s, ev('plan.vetoed', 'critic', { findings: ['x'] }, null), 1000);
      expect(s.agents.critic.emote?.kind).toBe('!');
      s = applyEvent(s, ev('research.delivered', 'research_analyst', {}, 'job_1'), 1000);
      expect(s.agents.research_analyst.emote?.kind).toBe('idea');
      s = applyEvent(s, ev('job.checkpoint', 'growth', { in_review: 'qa.review' }), 1000);
      expect(s.jobs.job_1.status).toBe('in_review');
    });
  });
});
