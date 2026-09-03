import { describe, it, expect } from 'vitest';
import { emptyState, applySnapshot, type Snapshot, type State } from '../state.js';
import { viewFor, briefTitle, kindLabel, chatHtml, type Ctx } from './content.js';
import { headlineFor, planBits, briefBits, cut } from '../world/headlines.js';

const ctx: Ctx = { frames: {}, tokenQuery: '?token=t', vaultName: 'Cubicle' };
const PLAN = `---\nupdated: "2026-09-03"\ncycle: 2\n---\n# Plan\n\n## Objective\nEstablish initial web presence and research the first organic channel.\n\n## This cycle\n- Scaffold initial static site from Brand/ (engineer.ship)\n- Research first organic acquisition channel (research)\n- [ ] Verify site deployment and review analytics setup\n\n## Next\n- Launch\n`;
const BRIEF = `---\nheartbeat: job_1\n---\n# Since you were away\n\n## What happened\n- Company initialized for first heartbeat (cycle 1).\n- Scaffolded the site.\n\n## What's next\n- Research.\n\n## What needs you\n- Approve the company name PlateReady.\n\n---\n_Facts used:_\n- ignored\n`;
const snap: Snapshot = { op: 'snapshot', at: 'now', roles: [{ role: 'ceo', display: 'CEO', sprite: 'ceo', desk: 'ceo_cabin', active: true }, { role: 'engineer', display: 'Engineer', sprite: 'engineer', desk: 'cubicle_1', active: true }], jobs: [{ id: 'job_a', type: 'engineer.ship', title: 'Scaffold the site with a very long title that should be cut in previews', assigned: 'engineer', status: 'running', priority: 3, checkpoint_step: 4, updated: '2026-09-03T04:38:00.000Z' }, { id: 'job_b', type: 'coo.verify', title: 'Verify', assigned: 'coo', status: 'done', priority: 4, checkpoint_step: 2, updated: '2026-09-03T04:39:00.000Z' }], surfaces: [], quota: [{ provider: 'gemini', model: 'gemini-3.5-flash', rpm_used: 2, rpd_used: 95, tpm_used: 0, cooling_until: null, limits: { rpm: 10, rpd: 100, tpm: 0 } }], latestRun: { path: 'Runs/2026-09-03-1016.md', body: BRIEF }, plan: PLAN, pendingProposals: 1, brand: { name: 'PlateReady', tagline: 'Meal plans for busy parents', url: '' }, inbox: [{ id: 'p1', kind: 'brand_change', title: 'Name the company: PlateReady', path: '00 Inbox/2026-09-03-1016-brand_change-idea.md', created: '2026-09-03T04:46:00.000Z' }] };
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
  const withTeams = applySnapshot(emptyState(), { ...snap, roles: [...snap.roles, { role: 'cto', display: 'CTO', sprite: 'cto', desk: 'cubicle_1', active: true }], teams: [{ id: 'engineering', name: 'Engineering', lead: 'cto', members: ['engineer'], mission: 'Ship.' }], jobs: [{ ...snap.jobs[0], team: 'engineering' } as never] });
  it('the Org drawer lists teams with lead and members as openable rows, with open-job counts (acceptance test 11)', () => {
    const v = viewFor('org', withTeams, ctx);
    expect(v.mode).toBe('drawer');
    expect(v.html).toContain('Engineering'); expect(v.html).toContain('data-open="agent:cto"'); expect(v.html).toContain('data-open="agent:engineer"');
    expect(v.html).toMatch(/1 open/);
    expect(viewFor('org', emptyState(), ctx).html).toContain('No teams yet');
  });
  it('queue rows are grouped by team and the in_review chip exists', () => {
    const s2 = applySnapshot(emptyState(), { ...withTeams as never, jobs: [{ ...snap.jobs[0], team: 'engineering', status: 'in_review' } as never] } as never);
    const html = viewFor('noticeboard', s2, ctx).html;
    expect(html).toContain('Engineering'); expect(html).toContain('chip in_review');
  });
});
