import { describe, it, expect } from 'vitest';
import { boardHeadline } from './ui/board.js';
import { applyConversation, conversationTurns, decideAcked, decideFailed, decideSent, LIVE_TURNS, pairThreadId, emptyState, applySnapshot, applyEvent, tick, toolIcon, targetFor, actionVerb, withFrameSeq, SLEEP_AFTER_MS, divisionOf, OVERSEER, VETO_ROLE, overseerRole, vetoRole, statusText, CHECKING_TEXT, WAITING_TEXT, type Snapshot } from './state.js';

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

  // Re-review finding 3: I4 gave the *wall* back after a lost `meeting.closed`, but the board room itself kept
  // the owner in the chair and the advisors standing at the table until the next session opened. Both now age
  // out on the same twenty-minute rule, off the event log, so a replay recovers at the same point a live
  // office does.
  it('lets the board room go home when the close never arrives', () => {
    let s = emptyState();
    s = applyEvent(s, { ts: '2026-09-11T10:00:00.000Z', type: 'meeting.opened', agent: 'advisor_skeptic', job: null, payload: { id: 'm1', room: 'board', participants: ['advisor_skeptic'], subject: 'idea', title: 'Meal kits' } });
    expect(s.meetings.m1).toMatchObject({ open: true, at: '2026-09-11T10:00:00.000Z' });

    // Nineteen minutes later the board is still sitting; twenty-one minutes later it is not.
    const still = applyEvent(s, { ts: '2026-09-11T10:19:00.000Z', type: 'job.done', agent: 'cto', job: 'job_x', payload: {} });
    expect(still.meetings.m1.open).toBe(true);
    const after = applyEvent(still, { ts: '2026-09-11T10:21:00.000Z', type: 'job.done', agent: 'cto', job: 'job_x', payload: {} });
    expect(after.meetings.m1.open).toBe(false);
    expect(boardHeadline(after.board, Date.parse('2026-09-11T10:21:00.000Z'))).toBeNull();

    // A meeting in any other room is not the board's business and is left alone.
    const standup = applyEvent(emptyState(), { ts: '2026-09-11T10:00:00.000Z', type: 'meeting.opened', agent: 'ceo', job: null, payload: { id: 'm2', room: 'meeting', participants: ['ceo'], agenda: 'standup' } });
    const anHourOn = applyEvent(standup, { ts: '2026-09-11T11:00:00.000Z', type: 'job.done', agent: 'cto', job: 'job_x', payload: {} });
    expect(anHourOn.meetings.m2.open).toBe(true);
  });
  // SP5 §8: two sprites at the pantry seats the map already has, and the transcript in the panel's own state.
  it('a pantry chat walks two people to the counter, collects the turns, and ages out on its own clock', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, { ts: '2026-09-12T15:00:00.000Z', type: 'meeting.opened', agent: 'cmo', job: 'job_p', payload: { id: 'mp1', room: 'pantry', participants: ['cmo', 'coo'], agenda: 'A coffee in the pantry' } });
    expect(s.agents.cmo.target).toBe('pantry');        // a room with seats: OfficeScene seats them, no Phaser change
    expect(s.agents.coo.target).toBe('pantry');
    expect(s.pantry).toMatchObject({ id: 'mp1', participants: ['cmo', 'coo'], turns: [], open: true });
    s = applyEvent(s, { ts: '2026-09-12T15:00:10.000Z', type: 'meeting.turn', agent: 'cmo', job: 'job_p', payload: { id: 'mp1', round: 1, text: 'The nurseries keep asking for a weekly box.' } });
    expect(s.pantry!.turns).toEqual([{ role: 'cmo', text: 'The nurseries keep asking for a weekly box.' }]);
    s = applyEvent(s, { ts: '2026-09-12T15:00:20.000Z', type: 'meeting.closed', agent: 'cmo', job: 'job_p', payload: { id: 'mp1', room: 'pantry', turns: 1, path: 'Pantry/2026-09-12-cmo-and-coo.md', decision: 'IDEA: Weekly meal kits for nurseries' } });
    expect(s.pantry).toMatchObject({ open: false, idea: 'Weekly meal kits for nurseries', note: 'Pantry/2026-09-12-cmo-and-coo.md' });
    expect(s.agents.cmo.target).toBeNull();
    // Half an hour on, the panel has let it go; a chat nobody closed goes at ten minutes (both off the log).
    const later = applyEvent(s, { ts: '2026-09-12T15:31:00.000Z', type: 'job.done', agent: 'cto', job: 'job_x', payload: {} });
    expect(later.pantry).toBeNull();
    const lost = applyEvent(applySnapshot(emptyState(), snap), { ts: '2026-09-12T15:00:00.000Z', type: 'meeting.opened', agent: 'cmo', job: 'job_p', payload: { id: 'mp2', room: 'pantry', participants: ['cmo', 'coo'] } });
    const elevenOn = applyEvent(lost, { ts: '2026-09-12T15:11:00.000Z', type: 'job.done', agent: 'cto', job: 'job_x', payload: {} });
    expect(elevenOn.pantry).toBeNull();
    expect(elevenOn.meetings.mp2.open).toBe(false);
    expect(elevenOn.agents.cmo.target).toBeNull();
  });

  // Ruling Q8: a trust review's return is about the outbound call it read, and the review job it rides on has
  // just finished — flipping that job back to `queued` would show a finished review re-opened on the board.
  it('a trust review that returns a call does not re-open the review job on the board', () => {
    let s = applySnapshot(emptyState(), snap);
    s = applyEvent(s, ev('job.checkpoint', 'cmo', { in_review: 'office:compliance.review' }));
    expect(s.jobs.job_1.status).toBe('in_review');
    s = applyEvent(s, ev('review.returned', 'clo', { gate: 'office:compliance.review', trust: true, proposal: 'p1', findings: ['the address is not the one the owner approved'] }), 1000);
    expect(s.jobs.job_1.status).toBe('in_review');
    expect(s.feed.at(-1)!.text).toContain('office:compliance.review returned');
    // An ordinary gate's return still re-queues the author's job, exactly as it always did.
    s = applyEvent(s, ev('review.returned', 'qa_lead', { gate: 'team:qa.review', findings: ['no title'] }), 1000);
    expect(s.jobs.job_1.status).toBe('queued');
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
    // Nor is a coffee break (SP5): the daemon opens the pantry from the first completed cycle, and on a new vault
    // that cycle completes before the owner has typed anything. Two idle people must not hide the entrance.
    const coffee = applySnapshot(emptyState(), { ...snap, brand: { name: '', tagline: '', url: '' }, jobs: [{ ...hb, id: 'job_pantry_1', type: 'pantry.chat', assigned: 'clo' }], chat: [] });
    expect(coffee.firstRun).toBe(true);
    expect(coffee.agents.ceo.state).toBe('entering');
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

/**
 * The constitution check the office used to make invisible (B1, 2026-09-13): the guardrail's `banned_tactics`
 * classifier asks a model before an outbound call, takes seconds, and wrote nothing at all while it ran — so
 * the sprite simply stopped, and a working company looked exactly like a hung one. A plain reducer, tested
 * without Phaser: the scene only reads what these two events put here.
 */
describe('the constitution check is something the owner can read', () => {
  const anAgent = snap.roles[1].role;   // read from the snapshot, never spelled out
  const checking = (tool: string) => ev('guardrail.checking', anAgent, { tool, role: anAgent, job: 'job_1' });

  it('says "checking the constitution…" from guardrail.checking until guardrail.checked', () => {
    let s = applySnapshot(emptyState(), snap);
    expect(s.agents[anAgent].checking).toBeNull();

    s = applyEvent(s, checking('mock.outbound'), 1000);
    expect(s.agents[anAgent].checking).toBe('mock.outbound');
    expect(statusText(s.agents[anAgent])).toBe(CHECKING_TEXT);
    expect(CHECKING_TEXT).toBe('checking the constitution…');
    expect(s.agents[anAgent].bubble!.text).toBe(CHECKING_TEXT);
    expect(s.agents[anAgent].mood).toBe('thinking');

    s = applyEvent(s, ev('guardrail.checked', anAgent, { tool: 'mock.outbound', verdict: 'clear', elapsed_ms: 2400 }), 3400);
    expect(s.agents[anAgent].checking).toBeNull();
    expect(s.agents[anAgent].bubble).toBeNull();
    expect(statusText(s.agents[anAgent])).toBeNull();
  });

  it('holds the line for the whole wait — a check that outlasts an ordinary bubble is still on screen', () => {
    let s = applyEvent(applySnapshot(emptyState(), snap), checking('email.send'), 1000);
    // Ten seconds in: well past the 4 s an action bubble lives, and a classifier call really does run this long.
    s = tick(s, 11_000);
    expect(statusText(s.agents[anAgent])).toBe(CHECKING_TEXT);
  });

  it('lets go when the checked never arrives — a daemon that died mid-check does not leave the office reading', () => {
    let s = applyEvent(applySnapshot(emptyState(), snap), checking('email.send'), 1000);
    s = tick(s, 1000 + 30_000);   // past the classifier's own 20 s bound, so the pair can never close now
    expect(s.agents[anAgent].checking).toBeNull();
    expect(statusText(s.agents[anAgent])).toBeNull();
  });

  it('a refusal clears the check and says why, so the two are never shown at once', () => {
    let s = applyEvent(applySnapshot(emptyState(), snap), checking('email.send'), 1000);
    s = applyEvent(s, ev('guardrail.checked', anAgent, { tool: 'email.send', verdict: 'unavailable', elapsed_ms: 20_000 }), 21_000);
    s = applyEvent(s, ev('guardrail.blocked', anAgent, { tool: 'email.send', reason: 'constitution guardrail: the banned_tactics classifier could not check this text' }), 21_000);
    expect(s.agents[anAgent].checking).toBeNull();
    expect(statusText(s.agents[anAgent])).toBeNull();
    expect(s.agents[anAgent].bubble!.text).toContain('not allowed');
    expect(s.feed[s.feed.length - 1].text).toContain('banned_tactics classifier');
  });

  it('tells the owner a deferred call is waiting, not that it was refused', () => {
    // The proposal note's own footer says nothing is wrong and it goes out next cycle. A `guardrail.blocked`
    // rendering — "not allowed", worried face, `!` over the head — would say the opposite (re-review 1).
    let s = applyEvent(applySnapshot(emptyState(), snap), checking('email.send'), 1000);
    s = applyEvent(s, ev('guardrail.deferred', anAgent, { tool: 'email.send', reason: 'the constitution guardrail could not check this call' }), 2000);
    expect(s.agents[anAgent].checking).toBeNull();
    expect(s.agents[anAgent].bubble!.text).toContain(WAITING_TEXT);
    expect(s.agents[anAgent].bubble!.text).not.toContain('not allowed');
    expect(s.agents[anAgent].mood).toBe('thinking');       // patient, not worried
    expect(s.agents[anAgent].emote).toBeNull();            // no alarm over the head
    expect(s.feed[s.feed.length - 1].text).toContain(WAITING_TEXT);
  });

  it('leaves a sprite that is not at its desk where it is, rather than seating it to read the rules', () => {
    const base = applySnapshot(emptyState(), snap);
    for (const state of ['walking', 'entering', 'leaving'] as const) {
      const s0 = { ...base, agents: { ...base.agents, [anAgent]: { ...base.agents[anAgent], state } } };
      const s1 = applyEvent(s0, checking('email.send'), 1000);
      expect(s1.agents[anAgent].state).toBe(state);
      expect(statusText(s1.agents[anAgent])).toBe(CHECKING_TEXT);   // it is still checking, it is just not sitting down
    }
    // An agent who has been fired is not checking anything: `applyEvent` ignores inactive roles outright.
    const off = { ...base, agents: { ...base.agents, [anAgent]: { ...base.agents[anAgent], active: false, state: 'offline' as const } } };
    expect(applyEvent(off, checking('email.send'), 1000).agents[anAgent].checking).toBeNull();
  });
});

/** SP8 §1: the owner decides in the office, and the dispatcher's answer moves the row. */
describe('decisions the owner makes', () => {
  const row = { id: 'p1', kind: 'spend', title: 'Pay for the domain', path: '00 Inbox/x.md', created: '2026-09-13T09:00:00.000Z', decidable: 'approve' as const };
  const withRow = () => applySnapshot(emptyState(), { ...snap, pendingProposals: 1, inbox: [row] });

  it('a sent decision is busy until the ack, and busy again until the dispatcher applies it', () => {
    let s = decideSent(withRow(), 'p1', { approved: true });
    expect(s.decisions.p1).toMatchObject({ status: 'sending', approved: true });
    s = decideAcked(s, 'p1');
    expect(s.decisions.p1.status).toBe('applying');
    s = applyEvent(s, ev('proposal.resolved', 'owner', { id: 'p1', kind: 'spend', approved: true, outcome: 'paid and recorded' }));
    expect(s.decisions.p1).toMatchObject({ status: 'done', approved: true, outcome: 'paid and recorded' });
    expect(s.inbox).toEqual([]);                                   // the row moved …
    expect(s.decided[0]).toMatchObject({ id: 'p1', approved: true, outcome: 'paid and recorded', title: 'Pay for the domain' });
    expect(s.decided[0].resolved_at).toBe('2026-09-02T00:00:00.000Z');
    expect(s.pendingProposals).toBe(0);
    expect(s.staleSnapshot).toBe(true);                            // … and the snapshot is re-read for the truth
  });

  it('a rejection carries the chosen option and reads as rejected', () => {
    let s = decideSent(withRow(), 'p1', { approved: false, chosen: 2 });
    s = applyEvent(s, ev('proposal.resolved', 'owner', { id: 'p1', kind: 'spend', approved: false, outcome: 'not this cycle' }));
    expect(s.decided[0]).toMatchObject({ approved: false, chosen: 2, outcome: 'not this cycle' });
  });

  it('a refusal is kept on the decision itself, and nothing is moved', () => {
    const s = decideFailed(decideSent(withRow(), 'p1', { approved: true }), 'p1', 'already resolved');
    expect(s.decisions.p1).toMatchObject({ status: 'error', message: 'already resolved' });
    expect(s.inbox).toHaveLength(1);
  });

  it('a resolution for a note the viewer never had still lands in the feed and changes nothing else', () => {
    const s = applyEvent(withRow(), ev('proposal.resolved', 'daemon', { id: 'other', kind: 'idea_verdict', approved: true, outcome: 'build it' }));
    expect(s.inbox).toHaveLength(1);
    expect(s.decided).toEqual([]);
    expect(s.feed.at(-1)!.text).toContain('build it');
  });
});

/** SP8 §2: the conversation index, and what a live turn does to it. */
describe('conversations', () => {
  const base = applySnapshot(emptyState(), snap);
  const at = (t: string) => `2026-09-13T${t}.000Z`;

  it('a snapshot carries the index; an older daemon without one still works', () => {
    const s = applySnapshot(emptyState(), { ...snap, conversations: [{ id: 'dm:owner-ceo', kind: 'dm' as const, title: 'You and the CEO', participants: ['owner', 'ceo'], updated: at('10:00:00'), open: false, last: null, turns: 2 }], decided: [] });
    expect(s.conversations).toHaveLength(1);
    expect(applySnapshot(s, snap).conversations).toEqual([]);
  });

  it('an opened meeting becomes a thread, its turns land on it, and closing it stops the LIVE dot', () => {
    let s = applyEvent(base, { ...ev('meeting.opened', 'ceo', { id: 'm1', room: 'board', participants: ['ceo', 'advisor_skeptic'], agenda: 'Is this worth building?' }), ts: at('09:00:00') });
    expect(s.conversations[0]).toMatchObject({ id: 'board:m1', kind: 'board', title: 'Is this worth building?', open: true, room: 'board' });
    s = applyEvent(s, { ...ev('meeting.turn', 'advisor_skeptic', { id: 'm1', round: 1, text: 'Who is the first customer?' }), ts: at('09:01:00') });
    expect(conversationTurns(s, 'board:m1')).toEqual([{ who: 'advisor_skeptic', at: at('09:01:00'), text: 'Who is the first customer?' }]);
    expect(s.conversations[0]).toMatchObject({ turns: 1, updated: at('09:01:00') });
    expect(s.conversations[0].last).toMatchObject({ who: 'advisor_skeptic', text: 'Who is the first customer?' });
    s = applyEvent(s, { ...ev('meeting.closed', 'ceo', { id: 'm1', decision: 'build it' }), ts: at('09:02:00') });
    expect(s.conversations[0].open).toBe(false);
  });

  it('the CEO speaking to the owner is the one thread the owner is in; colleagues get a thread per pair', () => {
    let s = applyEvent(base, { ...ev('agent.spoke', 'ceo', { to: 'owner', text: 'I filed the brief.' }), ts: at('10:00:00') });
    expect(s.conversations[0].id).toBe('dm:owner-ceo');
    expect(s.conversations[0].participants).toEqual(['owner', 'ceo']);
    expect(conversationTurns(s, 'dm:owner-ceo')).toHaveLength(1);
    s = applyEvent(s, { ...ev('agent.spoke', 'cmo', { to: 'coo', text: 'Can you review this?' }), ts: at('10:05:00') });
    const id = pairThreadId('cmo', 'coo');
    expect(id).toBe('agents:cmo+coo');
    expect(pairThreadId('coo', 'cmo')).toBe(id);                   // one thread per unordered pair
    expect(s.conversations[0].id).toBe(id);                        // newest first
    expect(conversationTurns(s, id)).toHaveLength(1);
  });

  it('the live buffer is bounded, and a fetched thread replaces it whole', () => {
    let s = applyEvent(base, { ...ev('meeting.opened', 'ceo', { id: 'm2', room: 'meeting', participants: ['ceo'], agenda: 'Standup' }), ts: at('11:00:00') });
    for (let i = 0; i < LIVE_TURNS + 12; i++) s = applyEvent(s, { ...ev('meeting.turn', 'ceo', { id: 'm2', round: i, text: `turn ${i}` }), ts: at('11:00:01') });
    expect(s.live['meeting:m2']).toHaveLength(LIVE_TURNS);
    expect(conversationTurns(s, 'meeting:m2')[0].text).toBe('turn 12');
    s = applyConversation(s, 'meeting:m2', [{ who: 'ceo', at: at('11:00:00'), text: 'turn 0' }]);
    expect(conversationTurns(s, 'meeting:m2')).toEqual([{ who: 'ceo', at: at('11:00:00'), text: 'turn 0' }]);
    expect(s.live['meeting:m2']).toBeUndefined();
  });
});
