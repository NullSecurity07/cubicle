import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, listJobs, createProposal, findInboxById, updateJob, loadOrg, can } from '@cubicle/core';
import { applyReorg, applyHire, applyFire, maybeEnqueuePostmortem, maybeEnqueueWeeklyReview } from '../src/evolution.js';

const root = path.resolve(__dirname, '../../..');
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-orgev-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
const reorg = (yaml: string) => { const { path: p } = createProposal(vault, { kind: 'reorg', from: 'ceo', title: 'r', body: '```yaml\n' + yaml + '```\n' }, 'ceo'); const n = vault.readNoteOrNull(p)!; return { path: p, data: n.data as never, body: n.body }; };

describe('reorg (spec §2)', () => {
  it('moves a role between teams and refuses orphaning, double membership and oversized teams', async () => {
    expect(await applyReorg(vault, reorg('teams:\n  qa: { lead: qa_lead, members: [qa_exploratory, qa_performance, qa_security, qa_release] }\n  research: { lead: research_manager, members: [researcher, research_analyst, data_scientist, intelligence_analyst, research_engineer, qa_automation] }\n'))).toMatch(/^applied/);
    const org = loadOrg(vault);
    expect(org.teams.research.members).toContain('qa_automation'); expect(org.teams.qa.members).not.toContain('qa_automation');
    expect(org.roles.qa_automation.team).toBe('research'); expect(org.roles.qa_automation.reports_to).toBe('research_manager');
    expect(vault.events.count('org.changed')).toBe(1);
    expect(await applyReorg(vault, reorg('teams:\n  qa: { lead: nobody, members: [] }\n'))).toMatch(/lead/);
    expect(await applyReorg(vault, reorg('teams:\n  qa: { lead: qa_lead, members: [qa_automation] }\n  research: { lead: research_manager, members: [qa_automation] }\n'))).toMatch(/two teams/);
    expect(await applyReorg(vault, reorg('teams:\n  qa: { lead: qa_lead, members: [qa_automation, qa_exploratory, qa_performance, qa_security, qa_release, researcher, research_analyst, data_scientist] }\n'))).toMatch(/max_team_size/);
  });

  it('refuses to move a role away from a team it still leads when that team is left unlisted', async () => {
    const before = loadOrg(vault);
    expect(await applyReorg(vault, reorg('teams:\n  research: { lead: research_manager, members: [researcher, research_analyst, data_scientist, intelligence_analyst, research_engineer, qa_lead] }\n'))).toMatch(/lose its lead/);
    const after = loadOrg(vault);
    expect(after.teams).toEqual(before.teams);
    expect(after.roles.qa_lead).toEqual(before.roles.qa_lead);
    expect(after.roles.research_manager).toEqual(before.roles.research_manager);
    expect(vault.events.count('org.changed')).toBe(0);
  });

  it('refuses malformed reorg yaml through the same refusal path (not a dispatch error)', async () => {
    const before = loadOrg(vault);
    expect(await applyReorg(vault, reorg('teams: [unclosed\n'))).toMatch(/does not parse/);
    expect(loadOrg(vault).teams).toEqual(before.teams);
    expect(vault.events.count('org.changed')).toBe(0);
  });

  it('refuses a reorg that leaves an active non-CEO role in no team (F6)', async () => {
    const before = loadOrg(vault);
    // The QA room listed with no members, and none of the five testers is added to any other listed team:
    // they'd belong to no team at all.
    expect(await applyReorg(vault, reorg('teams:\n  qa: { lead: qa_lead, members: [] }\n'))).toMatch(/would belong to no team/);
    expect(loadOrg(vault).teams).toEqual(before.teams);
    expect(vault.events.count('org.changed')).toBe(0);
  });
});

describe('hiring joins a team (spec §9.5, F2)', () => {
  it('a hire whose charter has team: joins Teams/<team>.md members so its lead can schedule it', async () => {
    // The Sales room is the only one with free member desks: the dev room's seven seats are all taken (B10).
    const supportCharter = readFileSync(path.join(root, 'vault-template/Roles/_hireable/support.md'), 'utf8');
    const j1 = createJob(vault, { type: 'custom', title: 'a', assigned: 'cso', goal: 'g' }, 'ceo');
    const j2 = createJob(vault, { type: 'custom', title: 'b', assigned: 'cso', goal: 'g' }, 'ceo');
    updateJob(vault, j1, { status: 'failed' }, 'daemon'); updateJob(vault, j2, { status: 'failed' }, 'daemon');
    const p = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'Hire Support', body: `[[${j1}]] [[${j2}]]\n\`\`\`markdown\n${supportCharter}\`\`\`` }, 'ceo');
    expect(await applyHire(vault, findInboxById(vault, p.id)!)).toMatch(/^hired support/);
    const org = loadOrg(vault);
    expect(org.teams.sales.members).toContain('support');
    expect(org.roles.support.team).toBe('sales');
    expect(can(org, 'cso', 'schedule', 'support')).toBe(true);
  });
});

describe('firing a lead (spec §2)', () => {
  it('reassigns the open subtree to the manager and promotes the manager to lead', async () => {
    const j = createJob(vault, { type: 'engineer.ship', title: 'x', assigned: 'backend_engineer', goal: 'g', team: 'technology', owner_role: 'cto' }, 'cto');
    const { path: p } = createProposal(vault, { kind: 'fire', from: 'ceo', title: 'Fire CTO', body: 'role: cto', target: 'Roles/cto.md' }, 'ceo');
    const n = vault.readNoteOrNull(p)!;
    expect(await applyFire(vault, { path: p, data: n.data as never, body: n.body })).toMatch(/^fired/);
    expect(readJob(vault, j)!.data.owner_role).toBe('ceo');
    expect(loadOrg(vault).teams.technology.lead).toBe('ceo');
    expect(vault.events.count('org.changed')).toBe(1);
  });

  it('reassigns a fired role\'s queued gate jobs to its manager instead of cancelling them, stranding the parent (F1)', async () => {
    const parent = createJob(vault, { type: 'engineer.ship', title: 'Ship it', assigned: 'backend_engineer', goal: 'g', team: 'dev', owner_role: 'dev_manager' }, 'dev_manager');
    vault.updateNote(`Jobs/${parent}.md`, (n) => ({ data: { ...n.data, status: 'in_review' }, body: n.body }), 'daemon');
    const gate = createJob(vault, { type: 'team:qa.review', title: 'Review: Ship it', assigned: 'qa_lead', goal: 'g', team: 'dev', owner_role: 'dev_manager', parent }, 'daemon');
    const { path: p } = createProposal(vault, { kind: 'fire', from: 'ceo', title: 'Fire the QA lead', body: 'role: qa_lead', target: 'Roles/qa_lead.md' }, 'ceo');
    const n = vault.readNoteOrNull(p)!;
    expect(await applyFire(vault, { path: p, data: n.data as never, body: n.body })).toMatch(/^fired/);
    const after = readJob(vault, gate)!.data;
    expect(after.status).toBe('queued'); // not cancelled
    expect(after.assigned).toBe('cto'); // the qa lead's own manager
    expect(readJob(vault, parent)!.data.status).toBe('in_review'); // still awaiting its gate, not stranded
  });

  it('reassigns a fired role\'s queued work job to a team-mate whose tools cover it, not the manager', async () => {
    // The Dev room already ships several engineers with overlapping tool families, so a fired specialist's work
    // has somewhere to go: the backend engineer's charter covers every family the full-stack engineer's has
    // (shell.*, git.*, browser.*, deploy.*, …), while the dev manager's does not.
    const ship = createJob(vault, { type: 'engineer.ship', title: 'Ship it', assigned: 'fullstack_engineer', goal: 'g', team: 'dev', owner_role: 'dev_manager' }, 'dev_manager');
    const dependent = createJob(vault, { type: 'custom', title: 'depends on ship', assigned: 'frontend_engineer', goal: 'g', depends_on: [ship] }, 'dev_manager');
    const { path: p } = createProposal(vault, { kind: 'fire', from: 'ceo', title: 'Fire the full-stack engineer', body: 'role: fullstack_engineer', target: 'Roles/fullstack_engineer.md' }, 'ceo');
    const n = vault.readNoteOrNull(p)!;
    expect(await applyFire(vault, { path: p, data: n.data as never, body: n.body })).toMatch(/^fired/);
    const after = readJob(vault, ship)!.data;
    expect(after.status).toBe('queued'); // not cancelled
    expect(after.assigned).toBe('backend_engineer'); // not the manager (dev_manager), which lacks the tools
    expect(readJob(vault, dependent)!.data.status).toBe('queued'); // untouched — its dependency is still alive
  });

  it('cancels a fired role\'s work job when no team-mate\'s tools cover it, and blocks anything depending on it', async () => {
    // Nobody else in the Dev room carries stripe.* or proposal.*, so no team-mate's tools cover the backend engineer.
    const ship = createJob(vault, { type: 'engineer.ship', title: 'Ship it', assigned: 'backend_engineer', goal: 'g', team: 'dev', owner_role: 'dev_manager' }, 'dev_manager');
    const dependent = createJob(vault, { type: 'custom', title: 'depends on ship', assigned: 'dev_manager', goal: 'g', depends_on: [ship] }, 'dev_manager');
    const { path: p } = createProposal(vault, { kind: 'fire', from: 'ceo', title: 'Fire the backend engineer', body: 'role: backend_engineer', target: 'Roles/backend_engineer.md' }, 'ceo');
    const n = vault.readNoteOrNull(p)!;
    expect(await applyFire(vault, { path: p, data: n.data as never, body: n.body })).toMatch(/^fired/);
    expect(readJob(vault, ship)!.data.status).toBe('cancelled');
    const after = readJob(vault, dependent)!.data;
    expect(after.status).toBe('blocked');
    expect(after.blocked_on).toMatchObject({ kind: 'owner', id: ship });
  });
});

describe('postmortem and weekly review triggers (spec §3, §4)', () => {
  it('two failures of one type since the last heartbeat file one research job for the CTO', () => {
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'hb' } });
    const a = createJob(vault, { type: 'engineer.ship', title: 'a', assigned: 'backend_engineer', goal: 'g' }, 'dev_manager');
    const b = createJob(vault, { type: 'engineer.ship', title: 'b', assigned: 'backend_engineer', goal: 'g' }, 'dev_manager');
    vault.events.emit({ type: 'job.failed', agent: 'backend_engineer', job: a, payload: { reason: 'x' } });
    expect(maybeEnqueuePostmortem(vault)).toBeNull();
    vault.events.emit({ type: 'job.failed', agent: 'backend_engineer', job: b, payload: { reason: 'y' } });
    const id = maybeEnqueuePostmortem(vault)!;
    expect(readJob(vault, id)!.data).toMatchObject({ type: 'research', assigned: 'research_manager', for: 'cto' });
    expect(readJob(vault, id)!.data.title).toMatch(/^Postmortem: engineer\.ship/);
    expect(maybeEnqueuePostmortem(vault)).toBeNull(); // once
  });
  it('every 7 heartbeats the weekly_review process is expanded once', async () => {
    for (let i = 0; i < 7; i++) vault.events.emit({ type: 'heartbeat.completed', payload: { id: `hb${i}` } });
    const ids = await maybeEnqueueWeeklyReview(vault, async () => 'meet_1');
    expect(ids.length).toBeGreaterThan(0);
    expect(listJobs(vault).filter((j) => j.title.startsWith('Weekly review pack'))).toHaveLength(1);
    expect(await maybeEnqueueWeeklyReview(vault, async () => 'meet_2')).toEqual([]);
  });
});
