import { describe, it, expect } from 'vitest';
import { emptyState, applySnapshot, applyEvent, tick, toolIcon, targetFor, actionVerb, withFrameSeq, SLEEP_AFTER_MS, divisionOf, OVERSEER, VETO_ROLE, overseerRole, vetoRole, type Snapshot } from './state.js';

const role = (o: Partial<Snapshot['roles'][number]> & { role: string }) => ({ display: o.role, sprite: o.role, desk: o.role, active: true, ...o });

const snap: Snapshot = { op: 'snapshot', at: 'now', roles: [{ role: 'ceo', display: 'CEO', sprite: 'ceo', desk: 'ceo', active: true }, { role: 'cmo', display: 'CMO', sprite: 'cmo', desk: 'sales_2', active: true, team: 'revenue' }, { role: 'coo', display: 'COO', sprite: 'coo', desk: 'coo', active: true }], jobs: [{ id: 'job_1', type: 'research', title: 'r', assigned: 'cmo', status: 'running', priority: 3, checkpoint_step: 2, updated: 'now' }], surfaces: [], quota: [], latestRun: null, plan: '# Plan', pendingProposals: 1, teams: [{ id: 'revenue', name: 'Revenue', lead: 'cfo', members: ['cmo'], mission: '', room: 'cfo_office', floor: 4 }, { id: 'technology', name: 'Technology', lead: 'cto', members: ['dev_manager'], mission: '' }, { id: 'dev', name: 'Dev', lead: 'dev_manager', members: ['backend_engineer'], mission: '', parent: 'technology' }] };
const ev = (type: string, agent: string | null, payload: Record<string, unknown> = {}, job: string | null = 'job_1') => ({ ts: '2026-09-02T00:00:00.000Z', type, agent, job, payload });

describe('viewer state machine (spec §10)', () => {
  it('snapshot carries brand and pending inbox rows; proposal events mark the snapshot stale so the list refreshes', () => {
    let s = applySnapshot(emptyState(), { ...snap, brand: { name: 'PlateReady', tagline: 'Meal plans', url: '' }, inbox: [{ id: 'p1', kind: 'spend', title: 'Deploy the site', path: '00 Inbox/x.md', created: 'now' }] });
    expect(s.brand.name).toBe('PlateReady');
    expect(s.inbox[0].title).toBe('Deploy the site');
    s = applyEvent(s, ev('proposal.created', 'backend_engineer', { kind: 'spend', title: 't' }));
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
    expect(s.agents.cmo.state).toBe('working');
    expect(s.agents.cmo.job).toBe('job_1');
    expect(s.pendingProposals).toBe(1);
  });
  it('tool calls walk to places and overlay icons; results return to working; done walks home', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('agent.tool_call', 'cmo', { tool: 'browser.goto', summary: '{}' }));
    expect(s.agents.cmo.state).toBe('walking');
    expect(s.agents.cmo.target).toBe('billboard');
    expect(s.agents.cmo.tool).toBe('browser');
    s = applyEvent(s, ev('agent.tool_call', 'cmo', { tool: 'vault.write' }));
    expect(s.agents.cmo.target).toBeNull();
    expect(s.agents.cmo.tool).toBe('doc');
    s = applyEvent(s, ev('job.done', 'cmo', { status: 'done' }));
    expect(s.jobs.job_1.status).toBe('done');
    expect(s.agents.cmo.job).toBeNull();
  });
  it('failed job → error badge and the COO walks over; blocked → ? bubble', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('job.failed', 'cmo', { reason: 'x' }));
    expect(s.agents.cmo.badge).toBe('error');
    expect(s.agents.coo.target).toBe('desk:sales_2');
    s = applyEvent(s, ev('job.blocked', 'cmo', { reason: 'approval' }));
    expect(s.agents.cmo.badge).toBe('blocked');
    expect(s.agents.cmo.bubble?.kind).toBe('thought');
    expect(s.agents.cmo.emote?.kind).toBe('?');
    const later = tick(s, Date.now() + 60_000);
    expect(later.agents.cmo.bubble).toBeNull();
  });
  it('meetings move participants to the room and turns speak; hire enters, fire leaves', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('meeting.opened', 'ceo', { id: 'm1', room: 'board', participants: ['ceo', 'cmo'], agenda: 'x' }, null));
    expect(s.agents.cmo.target).toBe('boardroom');
    s = applyEvent(s, ev('meeting.turn', 'cmo', { id: 'm1', text: 'we should' }, null));
    expect(s.agents.cmo.state).toBe('talking');
    s = applyEvent(s, ev('meeting.closed', 'ceo', { id: 'm1' }, null));
    expect(s.agents.cmo.target).toBeNull();
    s = applyEvent(s, ev('role.hired', 'daemon', { role: 'support', display: 'Support', desk: 'sales_1', sprite: 'support' }, null));
    expect(s.agents.support.state).toBe('entering');
    s = applyEvent(s, ev('role.fired', 'daemon', { role: 'cmo' }, null));
    expect(s.agents.cmo.state).toBe('leaving');
  });
  it('a board session walks the advisors to the table and lights the whiteboard', () => {
    let s = emptyState();
    s = applyEvent(s, { ts: '2026-09-11T10:00:00.000Z', type: 'meeting.opened', agent: 'advisor_skeptic', job: null, payload: { id: 'm1', room: 'board', participants: ['advisor_skeptic', 'advisor_investor'], subject: 'idea', title: 'Meal kits' } });
    expect(s.board).toMatchObject({ subject: 'idea', title: 'Meal kits', verdict: null });
    expect(s.meetings.m1.open).toBe(true);          // the owner's chair still reads this, unchanged
    expect(s.agents.advisor_skeptic?.target ?? 'boardroom').toBe('boardroom');
    s = applyEvent(s, { ts: '2026-09-11T10:01:00.000Z', type: 'meeting.closed', agent: 'advisor_skeptic', job: null, payload: { id: 'm1', verdict: 'return', findings: ['delivery is unpriced'] } });
    expect(s.board).toMatchObject({ verdict: 'return', findings: ['delivery is unpriced'] });
    expect(s.meetings.m1.open).toBe(false);
  });
  it('surfaces track browser sessions, frames, mail, terminal, proposals, deploys', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('browser.session_started', 'cmo', { session: 's1' }));
    s = applyEvent(s, ev('browser.frame', 'cmo', { session: 's1', seq: 3, path: '.cubicle/screens/s1/00003.jpg' }));
    expect(s.surfaces.s1.active).toBe(true);
    expect(s.frames.s1.seq).toBe(3);
    s = applyEvent(s, ev('browser.session_ended', 'cmo', { session: 's1' }));
    expect(s.surfaces.s1.active).toBe(false);
    s = applyEvent(s, ev('shell.output', 'backend_engineer', { text: 'npm run build' }));
    expect(s.terminal.at(-1)).toBe('npm run build');
    s = applyEvent(s, ev('email.sent', 'cmo', { to: 'a@x', subject: 'hi', mock: true }));
    expect(s.mail.at(-1)!.text).toContain('(mock)');
    s = applyEvent(s, ev('proposal.created', 'ceo', { kind: 'brand_change', title: 'Name' }, null));
    expect(s.pendingProposals).toBe(2);
    s = applyEvent(s, ev('proposal.resolved', 'owner', { kind: 'brand_change', approved: true, outcome: 'applied' }, null));
    expect(s.pendingProposals).toBe(1);
    s = applyEvent(s, ev('deploy.done', 'backend_engineer', { url: 'https://x.pages.dev' }));
    expect(s.deploys.at(-1)!.url).toBe('https://x.pages.dev');
  });
  it('first snapshot of an empty company makes the CEO enter and walk to the cabin', () => {
    const s = applySnapshot(emptyState(), { ...snap, brand: { name: '', tagline: '', url: '' }, jobs: [], chat: [] });
    expect(s.firstRun).toBe(true);
    expect(s.agents.ceo.state).toBe('entering');
    const named = applySnapshot(emptyState(), { ...snap, brand: { name: 'PlateReady', tagline: '', url: '' }, jobs: [], chat: [] });
    expect(named.firstRun).toBe(false);
    expect(named.agents.ceo.state).toBe('idle_at_desk');
    // The CEO's own heartbeat is not work the company is doing: a heartbeat job note in an otherwise empty
    // vault must not cancel the entrance (C1). Any other job does.
    const hb = { id: 'job_hb', type: 'ceo.heartbeat', title: 'heartbeat', assigned: 'ceo', status: 'running', priority: 2, checkpoint_step: 0, updated: '2026-01-01T00:00:00.000Z' };
    const beating = applySnapshot(emptyState(), { ...snap, brand: { name: '', tagline: '', url: '' }, jobs: [hb], chat: [] });
    expect(beating.firstRun).toBe(true);
    const working = applySnapshot(emptyState(), { ...snap, brand: { name: '', tagline: '', url: '' }, jobs: [hb, { ...hb, id: 'job_x', type: 'engineer.ship', assigned: 'backend_engineer' }], chat: [] });
    expect(working.firstRun).toBe(false);
  });
  it('the CEO entrance is a one-shot, not something every snapshot restarts', () => {
    const emptyCo = { ...snap, brand: { name: '', tagline: '', url: '' }, jobs: [], chat: [] };
    const first = applySnapshot(emptyState(), emptyCo);
    expect(first.agents.ceo.state).toBe('entering');
    // still walking in: a second snapshot must not cut the walk short either
    const second = applySnapshot(first, emptyCo);
    expect(second.agents.ceo.state).toBe('entering');
    // once the CEO is doing something else, an empty vault no longer sends it back out through the door
    const busy = { ...second, agents: { ...second.agents, ceo: { ...second.agents.ceo, state: 'talking' as const } } };
    expect(applySnapshot(busy, emptyCo).agents.ceo.state).toBe('idle_at_desk');
  });
  it('icons and targets', () => {
    expect(toolIcon('email.send')).toBe('envelope');
    expect(targetFor('shell.run')).toBe('terminal');
    expect(targetFor('vault.read')).toBeNull();
  });
  it('snapshot teams keep room, floor and parent', () => {
    const s = applySnapshot(emptyState(), { ...snap, teams: [{ id: 'dev', name: 'Dev', lead: 'dev_manager', members: [], mission: '', room: 'dev', floor: 2, parent: 'technology' }] });
    expect(s.teams[0]).toMatchObject({ room: 'dev', floor: 2, parent: 'technology' });
  });
  it('agents know their team, line of report and division (division root); the COO walks to the failing desk by desk id', () => {
    const s = applySnapshot(emptyState(), { ...snap, roles: [...snap.roles, { role: 'backend_engineer', display: 'BE', sprite: 'backend_engineer', desk: 'backend_engineer', active: true, team: 'dev', reports_to: 'dev_manager' }] });
    expect(s.agents.cmo).toMatchObject({ team: 'revenue', division: 'revenue' });
    expect(s.agents.backend_engineer).toMatchObject({ team: 'dev', reportsTo: 'dev_manager', division: 'technology' });
    expect(s.agents.ceo.division).toBe('other');   // no team in this fixture
    expect(divisionOf('board', [{ id: 'board', name: 'Board', lead: 'advisor_skeptic', members: [], mission: '' }])).toBe('board');
    expect(divisionOf(undefined, [])).toBe('other');
    const failed = applyEvent(s, ev('job.failed', 'backend_engineer', { reason: 'x' }));
    expect(failed.agents.coo.target).toBe('desk:backend_engineer');
    expect(OVERSEER).toBe('coo'); expect(VETO_ROLE).toBe('advisor_skeptic');
    const withOffices = applySnapshot(emptyState(), { ...snap, offices: { chief_executive: 'ceo', operations: 'chief_of_staff' }, teams: [...(snap.teams ?? []), { id: 'board', name: 'Board', lead: 'advisor_customer', members: [], mission: '' }] });
    expect(overseerRole(withOffices)).toBe('chief_of_staff');
    expect(vetoRole(withOffices)).toBe('advisor_customer');
    expect(overseerRole(emptyState())).toBe('coo');          // no snapshot yet: the shipped roster
    expect(vetoRole(emptyState())).toBe('advisor_skeptic');
  });
  it('plan.vetoed animates the agent that vetoed, falling back to the board skeptic', () => {
    let s = applySnapshot(emptyState(), { ...snap, roles: [...snap.roles, { role: 'advisor_skeptic', display: 'Skeptic', sprite: 'advisor_skeptic', desk: 'advisor_skeptic', active: true }] });
    s = applyEvent(s, ev('plan.vetoed', null, { findings: ['x'] }, null), 1000);
    expect(s.agents.advisor_skeptic.emote?.kind).toBe('!');
    s = applyEvent(s, ev('plan.vetoed', 'cmo', { findings: ['y'] }, null), 2000);
    expect(s.agents.cmo.emote?.kind).toBe('!');
    const hired = applyEvent(s, ev('role.hired', 'daemon', { role: 'sales_rep', display: 'Rep', desk: 'sales_1', sprite: 'sales_rep', team: 'sales', reports_to: 'cso' }, null));
    expect(hired.agents.sales_rep).toMatchObject({ desk: 'sales_1', team: 'sales', reportsTo: 'cso', state: 'entering' });
  });
});

describe('critique 7-9 reducer fixes', () => {
  it('snapshot resets stale in-flight states, keeps a still-running job, bounds surfaces; fired agents are inert; arrival resumes working', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('agent.tool_call', 'cmo', { tool: 'browser.goto' }));
    expect(s.agents.cmo.state).toBe('walking');
    s = applyEvent(s, ev('agent.tool_result', 'cmo', { tool: 'browser.goto', ok: true }));
    expect(s.agents.cmo.state).toBe('walking'); // still has a target → keeps walking
    s = applyEvent(s, ev('agent.tool_call', 'cmo', { tool: 'vault.write' }));
    s = applyEvent(s, ev('agent.tool_result', 'cmo', { tool: 'vault.write', ok: true }));
    expect(s.agents.cmo.state).toBe('working'); // no target → back to typing
    const again = applySnapshot(s, { ...snap, jobs: [] }); // job gone while disconnected
    expect(again.agents.cmo.state).toBe('idle_at_desk');
    expect(again.agents.cmo.job).toBeNull();
    const still = applySnapshot(s, snap);
    expect(still.agents.cmo.state).toBe('working');
    let f = applyEvent(s, ev('role.fired', 'daemon', { role: 'cmo' }, null));
    f = applyEvent(f, ev('agent.tool_call', 'cmo', { tool: 'browser.goto' }));
    expect(f.agents.cmo.state).toBe('leaving');
    const d = applyEvent(s, ev('vault.wrote', 'ceo', { path: 'Decisions/d1.md', sha: 'x', by: 'ceo' }, null));
    expect(d.feed.at(-1)!.text).toContain('decision recorded');
    expect(applyEvent(s, ev('vault.wrote', 'cto', { path: 'Plans/plan.md', sha: 'x', by: 'cto' }, null)).staleSnapshot).toBe(true);
    expect(applyEvent(s, ev('vault.wrote', 'daemon', { path: 'Plans/plan.md', sha: 'x', generated: true }, null)).staleSnapshot).toBeFalsy(); // generated files re-render themselves; no snapshot round trip
  });

  describe('expressions (moods, emotes, bubble kinds)', () => {
    const base = () => applySnapshot(emptyState(), snap);
    it('thinking → thought bubble with no text and a thinking face; a tool call → action bubble with a verb', () => {
      let s = applyEvent(base(), ev('agent.thinking', 'cmo', { step: 1 }), 1000);
      expect(s.agents.cmo.bubble).toEqual({ kind: 'thought', text: '', until: 5000 });
      expect(s.agents.cmo.mood).toBe('thinking');
      s = applyEvent(s, ev('agent.tool_call', 'cmo', { tool: 'browser.goto', summary: '{"url":"https://example.com/a"}' }), 2000);
      expect(s.agents.cmo.bubble).toMatchObject({ kind: 'action', text: 'opening example.com' });
      s = applyEvent(s, ev('agent.tool_result', 'cmo', { tool: 'browser.goto', ok: true }), 2500);
      expect(s.agents.cmo.bubble).toBeNull();
      s = applyEvent(s, ev('agent.tool_result', 'cmo', { tool: 'shell.run', ok: false }), 2600);
      expect(s.agents.cmo.mood).toBe('worried');
      expect(s.agents.cmo.emote?.kind).toBe('sweat');
    });
    it('speech bubbles for spoke and meeting turns; job done → happy + cheer; failed → worried + sweat, COO brings a clipboard', () => {
      let s = applyEvent(base(), ev('agent.spoke', 'cmo', { to: 'cto', text: 'hi' }), 1000);
      expect(s.agents.cmo.bubble?.kind).toBe('speech');
      s = applyEvent(s, ev('meeting.turn', 'coo', { id: 'm', text: 'ok' }), 1000);
      expect(s.agents.coo.bubble?.kind).toBe('speech');
      s = applyEvent(s, ev('job.done', 'cmo', { status: 'done' }), 2000);
      expect(s.agents.cmo.mood).toBe('happy'); expect(s.agents.cmo.emote?.kind).toBe('cheer');
      s = applyEvent(s, ev('job.started', 'cmo', {}), 3000);
      s = applyEvent(s, ev('job.failed', 'cmo', { reason: 'x' }), 4000);
      expect(s.agents.cmo.mood).toBe('worried'); expect(s.agents.cmo.emote?.kind).toBe('sweat');
      expect(s.agents.coo.emote?.kind).toBe('clipboard'); expect(s.agents.coo.target).toBe('desk:sales_2');
    });
    it('blocked → puzzled face, ? emote and a thought bubble with the reason', () => {
      const s = applyEvent(base(), ev('job.blocked', 'cmo', { reason: 'need a key' }), 1000);
      expect(s.agents.cmo.mood).toBe('puzzled'); expect(s.agents.cmo.emote?.kind).toBe('?');
      expect(s.agents.cmo.bubble).toMatchObject({ kind: 'thought', text: 'need a key' });
    });
    it('deploy.done cheers everyone; an owner message makes the CEO wave; a hire arrives with a heart', () => {
      let s = applyEvent(base(), ev('deploy.done', 'backend_engineer', { url: 'https://x.pages.dev' }, null), 1000);
      for (const r of ['ceo', 'cmo', 'coo']) { expect(s.agents[r].mood).toBe('happy'); expect(s.agents[r].emote?.kind).toBe('cheer'); }
      s = applyEvent(s, ev('proposal.created', 'owner', { kind: 'message', to: 'ceo', title: 'Build a site' }, null), 2000);
      expect(s.agents.ceo.emote?.kind).toBe('wave');
      s = applyEvent(s, ev('role.hired', 'daemon', { role: 'support', display: 'Support', desk: 'sales_1', sprite: 'support' }, null), 3000);
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
      let s = applySnapshot(emptyState(), { ...snap, roles: [...snap.roles, { role: 'qa_lead', display: 'QA Lead', sprite: 'qa_lead', desk: 'qa_lead', active: true }, { role: 'advisor_skeptic', display: 'The Skeptic', sprite: 'advisor_skeptic', desk: 'advisor_skeptic', active: true }, { role: 'research_manager', display: 'Head of Research', sprite: 'research_manager', desk: 'research_manager', active: true }] });
      s = applyEvent(s, ev('review.returned', 'qa_lead', { gate: 'team:qa.review', findings: ['no title'] }), 1000);
      expect(s.agents.cmo.mood).toBe('worried'); expect(s.agents.qa_lead.bubble).toMatchObject({ kind: 'speech', text: expect.stringContaining('no title') });
      s = applyEvent(s, ev('plan.vetoed', 'advisor_skeptic', { findings: ['x'] }, null), 1000);
      expect(s.agents.advisor_skeptic.emote?.kind).toBe('!');
      s = applyEvent(s, ev('research.delivered', 'research_manager', {}, 'job_1'), 1000);
      expect(s.agents.research_manager.emote?.kind).toBe('idea');
      s = applyEvent(s, ev('job.checkpoint', 'cmo', { in_review: 'team:qa.review' }), 1000);
      expect(s.jobs.job_1.status).toBe('in_review');
    });
  });
});

describe('sprite families', () => {
  it('derives the family from title, board membership and team leadership', () => {
    const s = applySnapshot(emptyState(), { op: 'snapshot', at: '2026-09-11T10:00:00.000Z', roles: [role({ role: 'ceo', title: 'Chief Executive Officer' }), role({ role: 'advisor_investor', team: 'board' }), role({ role: 'dev_manager', team: 'dev' }), role({ role: 'sre', team: 'dev' })], jobs: [], surfaces: [], quota: [], latestRun: null, plan: '', pendingProposals: 0, teams: [{ id: 'dev', name: 'Dev', lead: 'dev_manager', members: ['sre'], mission: '' }] });
    expect([s.agents.ceo.family, s.agents.advisor_investor.family, s.agents.dev_manager.family, s.agents.sre.family]).toEqual(['chief', 'advisor', 'manager', 'member']);
  });
});

/**
 * C1: the viewer's title bar reads `state.frames[id].seq`, and only the `browser.frame` *event* path ever wrote it.
 * A live socket frame (`net.ts` carries its own `seq`) and `__cubicle.pushFrame` both went to a module-level record
 * instead, so a stream that had just taken three frames advertised "seq 0" — a broken readout, not a test artefact.
 */
describe('withFrameSeq', () => {
  it('takes the daemon\'s own counter when the frame carried one', () => {
    const s = withFrameSeq(emptyState(), 'demo', 412);
    expect(s.frames.demo.seq).toBe(412);
    expect(withFrameSeq(s, 'demo', 413).frames.demo.seq).toBe(413);
  });
  it('advances by one for a frame pushed with no counter (`__cubicle.pushFrame`)', () => {
    let s = emptyState();
    for (let i = 0; i < 3; i++) s = withFrameSeq(s, 'demo', undefined);
    expect(s.frames.demo.seq).toBe(3);
  });
  it('counts each stream on its own and leaves the others alone', () => {
    let s = withFrameSeq(withFrameSeq(emptyState(), 'a'), 'b', 9);
    s = withFrameSeq(s, 'a');
    expect(s.frames.a.seq).toBe(2); expect(s.frames.b.seq).toBe(9);
  });
  it('keeps the stored path a browser.frame event left behind', () => {
    let s = applyEvent(emptyState(), { ts: '2026-09-11T09:00:00.000Z', type: 'browser.frame', agent: 'cmo', job: null, payload: { session: 'demo', seq: 7, path: '.cubicle/screens/demo/7.jpg' } });
    s = withFrameSeq(s, 'demo');
    expect(s.frames.demo).toEqual({ seq: 8, path: '.cubicle/screens/demo/7.jpg' });
  });
  it('does not mutate the state it was given', () => {
    const before = emptyState();
    const after = withFrameSeq(before, 'demo', 1);
    expect(before.frames).toEqual({});
    expect(after).not.toBe(before);
  });
});
