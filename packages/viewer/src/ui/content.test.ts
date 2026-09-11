import { describe, it, expect } from 'vitest';
import { emptyState, applySnapshot, applyEvent, type Snapshot, type State } from '../state.js';
import { briefTitle, kindLabel, chatHtml, emptyHtml, segmented, feedKind, dayLabel, browserViewerView, terminalViewerView, roomView, agentView, type Ctx } from './content.js';
import { headlineFor, viewFor } from './surfaces.js';
import { planBits, briefBits, cut } from './headlines.js';

const ctx: Ctx = { frames: {}, tokenQuery: '?token=t', vaultName: 'Cubicle' };
const PLAN = `---\nupdated: "2026-09-03"\ncycle: 2\n---\n# Plan\n\n## Objective\nEstablish initial web presence and research the first organic channel.\n\n## This cycle\n- Scaffold initial static site from Brand/ (engineer.ship)\n- Research first organic acquisition channel (research)\n- [ ] Verify site deployment and review analytics setup\n\n## Next\n- Launch\n`;
const BRIEF = `---\nheartbeat: job_1\n---\n# Since you were away\n\n## What happened\n- Company initialized for first heartbeat (cycle 1).\n- Scaffolded the site.\n\n## What's next\n- Research.\n\n## What needs you\n- Approve the company name PlateReady.\n\n---\n_Facts used:_\n- ignored\n`;
const snap: Snapshot = { op: 'snapshot', at: 'now', roles: [{ role: 'ceo', display: 'CEO', sprite: 'ceo', desk: 'ceo', active: true }, { role: 'backend_engineer', display: 'Backend Engineer', sprite: 'backend_engineer', desk: 'backend_engineer', active: true }], jobs: [{ id: 'job_a', type: 'engineer.ship', title: 'Scaffold the site with a very long title that should be cut in previews', assigned: 'backend_engineer', status: 'running', priority: 3, checkpoint_step: 4, updated: '2026-09-03T04:38:00.000Z' }, { id: 'job_b', type: 'coo.verify', title: 'Verify', assigned: 'coo', status: 'done', priority: 4, checkpoint_step: 2, updated: '2026-09-03T04:39:00.000Z' }], surfaces: [], quota: [{ provider: 'gemini', model: 'gemini-3.5-flash', rpm_used: 2, rpd_used: 95, tpm_used: 0, cooling_until: null, limits: { rpm: 10, rpd: 100, tpm: 0 } }], latestRun: { path: 'Runs/2026-09-03-1016.md', body: BRIEF }, plan: PLAN, pendingProposals: 1, brand: { name: 'PlateReady', tagline: 'Meal plans for busy parents', url: '' }, inbox: [{ id: 'p1', kind: 'brand_change', title: 'Name the company: PlateReady', path: '00 Inbox/2026-09-03-1016-brand_change-idea.md', created: '2026-09-03T04:46:00.000Z' }] };
const s: State = applySnapshot(emptyState(), snap);

describe('in-world headlines stay short', () => {
  it('cut() adds an ellipsis and collapses whitespace', () => { expect(cut('a  very\nlong line here', 8)).toBe('a very…'); expect(cut('short', 10)).toBe('short'); });
  it('reads the plan objective and this-cycle bullets (checkbox bullets included)', () => {
    const p = planBits(PLAN);
    expect(p.objective).toMatch(/^Establish/);
    expect(p.items).toHaveLength(3);
    expect(p.items[2]).toMatch(/^Verify site deployment/);
  });
  it('reads brief bullets and stops at the facts footer', () => {
    const b = briefBits(BRIEF);
    expect(b.happened).toHaveLength(2);
    expect(b.needs).toEqual(['Approve the company name PlateReady.']);
  });
  it('every surface fits: head ≤ 44 chars, each line ≤ 48 chars', () => {
    for (const k of ['whiteboard', 'newsstand', 'noticeboard', 'postoffice', 'terminal', 'vault', 'workshop', 'cabin', 'billboard', 'bank']) {
      const h = headlineFor(k, s);
      expect(h.head.length, k).toBeLessThanOrEqual(44);
      for (const l of h.lines) expect(l.length, `${k}: ${l}`).toBeLessThanOrEqual(48);
    }
    expect(headlineFor('postoffice', s).badge).toBe('1');
    expect(headlineFor('noticeboard', s).short).toBe('1'); // narrow screens show the count only
    expect(headlineFor('newsstand', s).lines.at(-1)).toMatch(/^Needs you: /);
    expect(headlineFor('whiteboard', emptyState()).head).toBe('No plan yet');
  });
});

describe('drawer and document views', () => {
  it('plan and brief open as documents with copy text and an Obsidian link', () => {
    const v = viewFor('whiteboard', s, ctx);
    expect(v.mode).toBe('doc'); expect(v.copy).toBe(PLAN); expect(v.link).toContain('obsidian://open?vault=Cubicle&file=Plans%2Fplan');
    expect(viewFor('newsstand', s, ctx).title).toBe(briefTitle('Runs/2026-09-03-1016.md'));
  });
  it('post office lists pending proposals as rows with a kind chip and an Obsidian link', () => {
    const v = viewFor('postoffice', s, ctx);
    expect(v.mode).toBe('drawer');
    expect(v.html).toContain('Name the company: PlateReady');
    expect(v.html).toContain(kindLabel('brand_change'));
    expect(v.html).toContain('obsidian://open?vault=Cubicle&amp;file=00%20Inbox%2F2026-09-03-1016-brand_change-idea');
    expect(viewFor('postoffice', emptyState(), ctx).html).toContain('Nothing waiting for you');
  });
  it('queue and vault rows open job documents; job docs link to the note', () => {
    expect(viewFor('noticeboard', s, ctx).html).toContain('data-open="job:job_a"');
    const vault = viewFor('vault', s, ctx);
    expect(vault.html).toContain('data-open="job:job_b"');
    const job = viewFor('job:job_a', s, ctx);
    expect(job.mode).toBe('doc'); expect(job.link).toContain('Jobs%2Fjob_a');
    expect(viewFor('job:nope', s, ctx).html).toContain('not in the current snapshot');
  });
  it('bank shows a runway meter that turns hot near the limit', () => { expect(viewFor('bank', s, ctx).html).toContain('meter hot'); });
  it('newsstand lists the decision feed under the brief', () => {
    const withFeed: State = { ...s, feed: [{ ts: '2026-09-03T11:00:00.000Z', text: 'guardrail: max_emails_per_day' }, { ts: '2026-09-03T12:00:00.000Z', text: 'decision recorded: pricing (ceo)' }] };
    const v = viewFor('newsstand', withFeed, ctx);
    expect(v.html).toContain('decision recorded: pricing (ceo)');
    expect(v.html).toContain('guardrail: max_emails_per_day');
    expect(v.html.indexOf('decision recorded')).toBeLessThan(v.html.indexOf('guardrail:')); // newest first
    expect(viewFor('newsstand', s, ctx).html).toContain('Nothing decided yet');
  });
  it('the newsstand headline falls back to the feed before the first brief', () => {
    const noBrief: State = { ...s, latestRun: null, feed: [{ ts: '2026-09-03T12:00:00.000Z', text: 'proposal: Name the company' }] };
    expect(headlineFor('newsstand', noBrief).lines[0]).toContain('Name the company');
  });
  it('bank shows total calls today across providers', () => {
    const two: State = applySnapshot(emptyState(), { ...snap, quota: [
      { provider: 'gemini', model: 'a', rpm_used: 0, rpd_used: 7, tpm_used: 0, cooling_until: null, limits: { rpm: 10, rpd: 100, tpm: 0 } },
      { provider: 'groq', model: 'b', rpm_used: 0, rpd_used: 5, tpm_used: 0, cooling_until: null, limits: { rpm: 10, rpd: 50, tpm: 0 } },
    ] });
    expect(viewFor('bank', two, ctx).html).toContain('12 calls today');
    expect(headlineFor('bank', two).head).toBe('12 calls today');
  });
  it('escapes user-controlled text everywhere', () => {
    const evil = applySnapshot(emptyState(), { ...snap, inbox: [{ id: 'x', kind: 'spend', title: '<img src=x onerror=1>', path: '00 Inbox/x.md', created: 'now' }], jobs: [{ ...snap.jobs[0], title: '<script>alert(1)</script>' }] });
    for (const k of ['postoffice', 'noticeboard', 'vault', 'job:job_a']) expect(viewFor(k, evil, ctx).html).not.toMatch(/<script|<img src=x/);
  });
  it('the CEO thread shows both sides and pins the brief', () => {
    const t = { ...s, chat: [{ ts: '2026-09-03T04:37:00.000Z', from: 'you' as const, text: 'A meal-planning site' }, { ts: '2026-09-03T04:46:00.000Z', from: 'ceo' as const, text: 'Got it. I proposed **PlateReady**.' }] };
    const html = chatHtml(t);
    expect(html).toContain('<b>PlateReady</b>'); // inline markdown in bubbles
    expect(html).toContain('class="msg me"'); expect(html).toContain('class="msg ceo"'); expect(html).toContain('details class="pinned"');
    expect(viewFor('cabin', s, ctx).mode).toBe('chat');
    expect(viewFor('cabin', s, ctx).sub).toContain('PlateReady');
    expect(chatHtml(s)).toContain('surprise me');
  });
  it('cabin asks the first-run question when the company has no name and no chat', () => {
    const v = viewFor('cabin', emptyState(), ctx);
    expect(v.html).toContain('What company will you start today?');
    expect(v.html).toContain('data-action="surprise-me"');
  });
  it('the cabin wall shows the latest brief when there is one, else the first-run question', () => {
    expect(headlineFor('cabin', s).head).toBe(headlineFor('newsstand', s).head);
    expect(headlineFor('cabin', emptyState()).head).toBe('What company will you start today?');
  });
});

describe('org view (spec §6)', () => {
  const teamSnap: Snapshot = { ...snap, roles: [...snap.roles, { role: 'dev_manager', display: 'Dev Manager', sprite: 'dev_manager', desk: 'dev_manager', active: true }], teams: [{ id: 'dev', name: 'Dev', lead: 'dev_manager', members: ['backend_engineer'], mission: 'Ship.' }], jobs: [{ ...snap.jobs[0], team: 'dev' }] };
  const withTeams = applySnapshot(emptyState(), teamSnap);
  it('the Org drawer lists teams with lead and members as openable rows, with open-job counts (acceptance test 11)', () => {
    const v = viewFor('org', withTeams, ctx);
    expect(v.mode).toBe('drawer');
    expect(v.html).toContain('Dev'); expect(v.html).toContain('data-open="agent:dev_manager"'); expect(v.html).toContain('data-open="agent:backend_engineer"');
    expect(v.html).toMatch(/1 open/);
    expect(viewFor('org', emptyState(), ctx).html).toContain('No teams yet');
  });
  it('queue rows are grouped by team and the in_review chip exists', () => {
    const s2 = applySnapshot(emptyState(), { ...teamSnap, jobs: [{ ...snap.jobs[0], team: 'dev', status: 'in_review' }] });
    const html = viewFor('noticeboard', s2, ctx).html;
    expect(html).toContain('Dev'); expect(html).toContain('chip in_review');
  });
});

describe('tower views (plan 3)', () => {
  const towerSnap: Snapshot = { ...snap, roles: [
    { role: 'ceo', display: 'CEO', sprite: 'ceo', desk: 'ceo', active: true, title: 'Chief Executive Officer' },
    { role: 'cto', display: 'CTO', sprite: 'cto', desk: 'cto', active: true, title: 'Chief Technology Officer' },
    { role: 'dev_manager', display: 'Dev Manager', sprite: 'dev_manager', desk: 'dev_manager', active: true, title: 'Engineering Manager' },
    { role: 'backend_engineer', display: 'Backend', sprite: 'backend_engineer', desk: 'backend_engineer', active: true, title: 'Backend Engineer' },
    { role: 'cmo', display: 'CMO', sprite: 'cmo', desk: 'cmo', active: true, title: 'Chief Marketing Officer' },
  ], teams: [
    { id: 'technology', name: 'Technology', lead: 'cto', members: [], mission: 'Build.', room: 'cto_office', floor: 4 },
    { id: 'dev', name: 'Dev', lead: 'dev_manager', members: ['backend_engineer'], mission: 'Ship.', room: 'dev', floor: 2, parent: 'technology' },
    { id: 'revenue', name: 'Revenue', lead: 'cmo', members: [], mission: 'Sell.', room: 'cmo_office', floor: 4 },
  ], jobs: [
    { id: 'j_open', type: 'engineer.ship', title: 'Build site', assigned: 'backend_engineer', status: 'running', priority: 3, checkpoint_step: 4, updated: '2026-09-11T08:00:00.000Z', team: 'dev' },
    { id: 'j_rev', type: 'engineer.ship', title: 'Fix header', assigned: 'backend_engineer', status: 'in_review', priority: 3, checkpoint_step: 9, updated: '2026-09-11T08:05:00.000Z', team: 'dev' },
    { id: 'j_done', type: 'growth.post', title: 'Launch post', assigned: 'cmo', status: 'done', priority: 4, checkpoint_step: 3, updated: '2026-09-11T07:00:00.000Z', team: 'revenue' },
  ] };
  const tower = applySnapshot(emptyState(), towerSnap);
  const tctx: Ctx = { ...ctx, floorLabels: { 1: 'Executive', 2: 'Departments', 3: 'Assurance', 4: 'Leadership' } };

  it('empty states carry a pixel icon, a title and a hint', () => {
    const h = emptyHtml('envelope', 'Nothing waiting for you', 'Proposals appear here.');
    expect(h).toContain('<svg'); expect(h).toContain('<b>Nothing waiting for you</b>'); expect(h).toContain('Proposals appear here.');
    for (const k of ['postoffice', 'noticeboard', 'bank', 'terminal', 'billboard', 'org']) expect(viewFor(k, emptyState(), ctx).html, k).toContain('<svg');
  });
  it('segmented controls: first segment selected, others hidden, counts shown', () => {
    const h = segmented([{ id: 'needs', label: 'Needs you', count: 2, html: '<p>a</p>' }, { id: 'mail', label: 'Mail', html: '<p>b</p>' }]);
    expect(h).toContain('role="tablist"');
    expect(h).toContain('data-seg="needs" aria-selected="true"');
    expect(h).toContain('data-seg="mail" aria-selected="false"');
    expect(h).toContain('<span class="n">2</span>');
    expect(h).toContain('data-pane="mail" hidden');
    expect(h).not.toContain('data-pane="needs" hidden');
  });
  it('the post office splits Needs you from Mail and keeps the Obsidian link', () => {
    const v = viewFor('postoffice', s, ctx);
    expect(v.html).toContain('data-seg="needs"'); expect(v.html).toContain('data-seg="mail"');
    expect(v.html).toContain('Name the company: PlateReady');
    expect(v.icon).toBe('envelope');
  });
  it('the queue has Open / In review / Done segments grouped by team', () => {
    const v = viewFor('noticeboard', tower, ctx);
    expect(v.html).toContain('data-seg="open"'); expect(v.html).toContain('data-seg="review"'); expect(v.html).toContain('data-seg="done"');
    const open = v.html.slice(v.html.indexOf('data-pane="open"'), v.html.indexOf('data-pane="review"'));
    expect(open).toContain('Build site'); expect(open).not.toContain('Fix header'); expect(open).toContain('Dev');
    const done = v.html.slice(v.html.indexOf('data-pane="done"'));
    expect(done).toContain('Launch post'); expect(done).toContain('Revenue');
    expect(v.sub).toBe('1 open · 1 in review');
  });
  it('the feed groups rows by day with a kind dot', () => {
    const withFeed: State = { ...s, feed: [{ ts: '2026-09-02T11:00:00.000Z', text: 'guardrail: max_emails_per_day' }, { ts: '2026-09-03T12:00:00.000Z', text: 'deployed https://x.pages.dev' }] };
    const html = viewFor('newsstand', withFeed, ctx).html;
    expect(html).toContain('class="dot bad"'); expect(html).toContain('class="dot ok"');
    expect((html.match(/class="day"/g) ?? []).length).toBe(2);
    expect(feedKind('proposal: Name the company')).toBe('warn');
    expect(feedKind('decision recorded: pricing (ceo)')).toBe('info');
    expect(feedKind('hired sales_1')).toBe('ok');
    expect(feedKind('spend rejected: too much')).toBe('bad');
    // dayLabel compares calendar days in the viewer's own local timezone (as a real viewer sees "Today"), so the
    // fixtures below are built from local-time components (`new Date(y, m, d, h)`), not UTC 'Z' strings: a fixed
    // instant's local calendar day shifts with the host's timezone, which made this test flaky depending on where
    // it ran. Constructing both `ts` and `now` from the same local wall-clock keeps the "Today"/"Yesterday" math
    // correct in every zone (round-tripping through `toISOString()` preserves the instant, not the wall-clock).
    const localNoon = (day: number): string => new Date(2026, 8, day, 12).toISOString();
    const localNow = new Date(2026, 8, 3, 20);
    expect(dayLabel(localNoon(3), localNow)).toBe('Today');
    expect(dayLabel(localNoon(2), localNow)).toBe('Yesterday');
  });
  it('the org sheet groups by division (floor), then team, with a Locate button per role', () => {
    const v = viewFor('org', tower, tctx);
    const lead = v.html.indexOf('Leadership'), dept = v.html.indexOf('Departments');
    expect(lead).toBeGreaterThan(-1); expect(dept).toBeGreaterThan(lead);         // F4 first, F2 below
    expect(v.html.indexOf('Technology')).toBeLessThan(v.html.indexOf('Dev'));      // parent before child
    expect(v.html).toContain('data-open="agent:backend_engineer"');
    expect(v.html).toContain('data-locate="agent:backend_engineer"');
    expect(v.html).toMatch(/2 open/);                                              // dev: running + in_review
    expect(viewFor('org', tower, ctx).html).toContain('Floor 4');                  // no labels supplied → numbered
  });
  it('the bank shows stat tiles and a meter per model with the cooling time', () => {
    const cooling = applySnapshot(emptyState(), { ...snap, quota: [{ provider: 'gemini', model: 'gemini-3.5-flash', rpm_used: 2, rpd_used: 95, tpm_used: 0, cooling_until: '2026-09-03T14:02:00.000Z', limits: { rpm: 10, rpd: 100, tpm: 0 } }] });
    const html = viewFor('bank', cooling, ctx).html;
    expect(html).toContain('class="stat"'); expect(html).toContain('95 calls today'); expect(html).toContain('<span class="v">1</span><span class="l">cooling</span>');
    expect(html).toContain('meter hot'); expect(html).toContain('cooling until'); expect(viewFor('bank', cooling, ctx).icon).toBe('chart');
  });
  it('the browser viewer shows LIVE from the surface state, the frame in place, and the ended footer', () => {
    let st = applyEvent(tower, { ts: '2026-09-11T09:00:00.000Z', type: 'browser.session_started', agent: 'cmo', job: null, payload: { session: 'demo' } });
    st = applyEvent(st, { ts: '2026-09-11T09:00:01.000Z', type: 'agent.tool_call', agent: 'cmo', job: null, payload: { tool: 'browser.goto', summary: '{"url":"https://example.com/pricing"}', step: 1 } });
    st = applyEvent(st, { ts: '2026-09-11T09:00:02.000Z', type: 'browser.frame', agent: 'cmo', job: null, payload: { session: 'demo', seq: 412, path: '.cubicle/screens/demo/412.jpg' } });
    const live = viewFor('billboard', st, { ...ctx, frames: { demo: 'data:image/jpeg;base64,xx' }, fps: { demo: 4.8 } });
    expect(live.mode).toBe('viewer'); expect(live.live).toBe(true);
    expect(live.html).toContain('class="badge live"'); expect(live.html).toContain('CMO'); expect(live.html).toContain('example.com');
    expect(live.html).toContain('seq 412'); expect(live.html).toContain('4.8 fps');
    expect(live.html).toContain('<img data-key="frame"'); expect(live.html).toContain('src="data:image/jpeg;base64,xx"');
    expect(live.html).not.toContain('Session ended');
    const ended = viewFor('billboard', applyEvent(st, { ts: '2026-09-11T09:02:00.000Z', type: 'browser.session_ended', agent: 'cmo', job: null, payload: { session: 'demo' } }), ctx);
    expect(ended.html).toContain('class="badge ended"'); expect(ended.html).toContain('Session ended'); expect(ended.html).not.toContain('class="badge live"');
    expect(ended.html).toContain('/screens/demo/412.jpg');                         // last frame from the daemon's store
    expect(browserViewerView(emptyState(), ctx).html).toContain('<svg');
    // The stylesheet sizes the two viewers differently (a fixed 16:10 panel pillarboxed the stream); the view says
    // which one it is, empty state included, so an empty billboard is not sized like a terminal.
    expect(live.viewer).toBe('browser');
    expect(browserViewerView(emptyState(), ctx).viewer).toBe('browser');
  });
  it('the terminal viewer colours prompt lines and shows a caret only while a shell job runs', () => {
    let st = applyEvent(tower, { ts: '2026-09-11T09:00:00.000Z', type: 'shell.output', agent: 'backend_engineer', job: 'j_open', payload: { text: '$ npm run build\n> astro build\ndone in 412ms' } });
    const idle = terminalViewerView(st);
    expect(idle.mode).toBe('viewer'); expect(idle.html).toContain('<pre class="term" data-key="term"');
    expect(idle.html).toContain('<span class="line prompt">$ npm run build</span>'); expect(idle.html).toContain('<span class="line">done in 412ms</span>');
    expect(idle.html).not.toContain('class="caret"');
    st = applyEvent(st, { ts: '2026-09-11T09:00:01.000Z', type: 'agent.tool_call', agent: 'backend_engineer', job: 'j_open', payload: { tool: 'shell.run', summary: 'npm test', step: 2 } });
    st = applyEvent(st, { ts: '2026-09-11T09:00:01.000Z', type: 'job.started', agent: 'backend_engineer', job: 'j_open', payload: { type: 'engineer.ship', title: 'Build site' } });
    expect(terminalViewerView(st).html).toContain('class="caret"');
    expect(terminalViewerView(emptyState()).html).toContain('<svg');
    expect(idle.viewer).toBe('terminal');
    expect(terminalViewerView(emptyState()).viewer).toBe('terminal');
  });
  it('rooms without a surface open a roster sheet; the CEO office is the cabin', () => {
    const v = viewFor('dev', tower, ctx);
    expect(v.mode).toBe('drawer'); expect(v.title).toBe('Dev');
    expect(v.html).toContain('data-open="agent:dev_manager"'); expect(v.html).toContain('data-open="agent:backend_engineer"');
    expect(roomView('pantry', tower).title).toBe('Pantry');
    expect(roomView('pantry', tower).html).toContain('Nobody here right now');
    const inPantry = { ...tower, agents: { ...tower.agents, cmo: { ...tower.agents.cmo, target: 'pantry' } } };
    expect(roomView('pantry', inPantry).html).toContain('data-open="agent:cmo"');
    expect(viewFor('ceo_office', tower, ctx).mode).toBe('chat');
  });
  it('the agent sheet is pure: state line, team, reports-to, current job, charter link, Locate', () => {
    const v = agentView('backend_engineer', { ...tower, agents: { ...tower.agents, backend_engineer: { ...tower.agents.backend_engineer, job: 'j_open', state: 'working', tool: 'terminal' } } }, ctx);
    expect(v.mode).toBe('drawer'); expect(v.title).toBe('Backend');
    expect(v.sub).toContain('working'); expect(v.sub).toContain('Dev'); expect(v.sub).toContain('reports to Dev Manager');
    expect(v.html).toContain('data-open="job:j_open"'); expect(v.html).toContain('data-locate="agent:backend_engineer"');
    expect(v.html).toContain('obsidian://open?vault=Cubicle&amp;file=Roles%2Fbackend_engineer');
    expect(viewFor('agent:nobody', tower, ctx).html).toContain('<svg');
  });
  it('escapes user text in the new views too', () => {
    const evil = applySnapshot(emptyState(), { ...towerSnap, jobs: [{ ...towerSnap.jobs[0], title: '<script>alert(1)</script>' }], teams: [{ ...towerSnap.teams![0], name: '<img src=x onerror=1>' }] });
    for (const k of ['noticeboard', 'org', 'dev', 'agent:backend_engineer']) expect(viewFor(k, evil, ctx).html, k).not.toMatch(/<script|<img src=x/);
    const st = applyEvent(evil, { ts: 'now', type: 'shell.output', agent: 'backend_engineer', job: null, payload: { text: '<script>x</script>' } });
    expect(terminalViewerView(st).html).not.toContain('<script>');
  });
});
