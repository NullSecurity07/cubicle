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
    expect(await applyReorg(vault, reorg('teams:\n  engineering: { lead: cto, members: [tech_lead, engineer] }\n  operations: { lead: coo, members: [qa] }\n'))).toMatch(/^applied/);
    const org = loadOrg(vault);
    expect(org.teams.operations.members).toEqual(['qa']); expect(org.roles.qa.team).toBe('operations'); expect(org.roles.qa.reports_to).toBe('coo');
    expect(vault.events.count('org.changed')).toBe(1);
    expect(await applyReorg(vault, reorg('teams:\n  engineering: { lead: nobody, members: [] }\n'))).toMatch(/lead/);
    expect(await applyReorg(vault, reorg('teams:\n  engineering: { lead: cto, members: [engineer] }\n  growth: { lead: head_of_growth, members: [engineer] }\n'))).toMatch(/two teams/);
    expect(await applyReorg(vault, reorg('teams:\n  engineering: { lead: cto, members: [tech_lead, engineer, qa, critic, coo, research_analyst] }\n'))).toMatch(/max_team_size/);
  });

  it('refuses to move a role away from a team it still leads when that team is left unlisted', async () => {
    const before = loadOrg(vault);
    expect(await applyReorg(vault, reorg('teams:\n  operations: { lead: coo, members: [qa, cto] }\n'))).toMatch(/lose its lead/);
    const after = loadOrg(vault);
    expect(after.teams).toEqual(before.teams);
    expect(after.roles.cto).toEqual(before.roles.cto);
    expect(after.roles.qa).toEqual(before.roles.qa);
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
    // Engineering listed without tech_lead or engineer, and neither is added to any other listed team: they'd
    // belong to no team at all.
    expect(await applyReorg(vault, reorg('teams:\n  engineering: { lead: cto, members: [] }\n'))).toMatch(/would belong to no team/);
    expect(loadOrg(vault).teams).toEqual(before.teams);
    expect(vault.events.count('org.changed')).toBe(0);
  });
});

describe('hiring joins a team (spec §9.5, F2)', () => {
  it('a hire whose charter has team: joins Teams/<team>.md members so its lead can schedule it', async () => {
    const devopsCharter = readFileSync(path.join(root, 'vault-template/Roles/_hireable/devops.md'), 'utf8');
    const j1 = createJob(vault, { type: 'custom', title: 'a', assigned: 'cto', goal: 'g' }, 'ceo');
    const j2 = createJob(vault, { type: 'custom', title: 'b', assigned: 'cto', goal: 'g' }, 'ceo');
    updateJob(vault, j1, { status: 'failed' }, 'daemon'); updateJob(vault, j2, { status: 'failed' }, 'daemon');
    const p = createProposal(vault, { kind: 'hire', from: 'ceo', title: 'Hire DevOps', body: `[[${j1}]] [[${j2}]]\n\`\`\`markdown\n${devopsCharter}\`\`\`` }, 'ceo');
    expect(await applyHire(vault, findInboxById(vault, p.id)!)).toMatch(/^hired devops/);
    const org = loadOrg(vault);
    expect(org.teams.engineering.members).toContain('devops');
    expect(org.roles.devops.team).toBe('engineering');
    expect(can(org, 'cto', 'schedule', 'devops')).toBe(true);
  });
});

describe('firing a lead (spec §2)', () => {
  it('reassigns the open subtree to the manager and promotes the manager to lead', async () => {
    const j = createJob(vault, { type: 'engineer.ship', title: 'x', assigned: 'engineer', goal: 'g', team: 'engineering', owner_role: 'cto' }, 'cto');
    const { path: p } = createProposal(vault, { kind: 'fire', from: 'ceo', title: 'Fire CTO', body: 'role: cto', target: 'Roles/cto.md' }, 'ceo');
    const n = vault.readNoteOrNull(p)!;
    expect(await applyFire(vault, { path: p, data: n.data as never, body: n.body })).toMatch(/^fired/);
    expect(readJob(vault, j)!.data.owner_role).toBe('ceo');
    expect(loadOrg(vault).teams.engineering.lead).toBe('ceo');
    expect(vault.events.count('org.changed')).toBe(1);
  });

  it('reassigns a fired role\'s queued gate jobs to its manager instead of cancelling them, stranding the parent (F1)', async () => {
    const parent = createJob(vault, { type: 'engineer.ship', title: 'Ship it', assigned: 'engineer', goal: 'g', team: 'engineering', owner_role: 'cto' }, 'cto');
    vault.updateNote(`Jobs/${parent}.md`, (n) => ({ data: { ...n.data, status: 'in_review' }, body: n.body }), 'daemon');
    const gate = createJob(vault, { type: 'qa.review', title: 'Review: Ship it', assigned: 'qa', goal: 'g', team: 'engineering', owner_role: 'cto', parent }, 'daemon');
    const { path: p } = createProposal(vault, { kind: 'fire', from: 'ceo', title: 'Fire QA', body: 'role: qa', target: 'Roles/qa.md' }, 'ceo');
    const n = vault.readNoteOrNull(p)!;
    expect(await applyFire(vault, { path: p, data: n.data as never, body: n.body })).toMatch(/^fired/);
    const after = readJob(vault, gate)!.data;
    expect(after.status).toBe('queued'); // not cancelled
    expect(after.assigned).toBe('cto'); // qa's lead
    expect(readJob(vault, parent)!.data.status).toBe('in_review'); // still awaiting its gate, not stranded
  });
});

describe('postmortem and weekly review triggers (spec §3, §4)', () => {
  it('two failures of one type since the last heartbeat file one research job for the CTO', () => {
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'hb' } });
    const a = createJob(vault, { type: 'engineer.ship', title: 'a', assigned: 'engineer', goal: 'g' }, 'cto');
    const b = createJob(vault, { type: 'engineer.ship', title: 'b', assigned: 'engineer', goal: 'g' }, 'cto');
    vault.events.emit({ type: 'job.failed', agent: 'engineer', job: a, payload: { reason: 'x' } });
    expect(maybeEnqueuePostmortem(vault)).toBeNull();
    vault.events.emit({ type: 'job.failed', agent: 'engineer', job: b, payload: { reason: 'y' } });
    const id = maybeEnqueuePostmortem(vault)!;
    expect(readJob(vault, id)!.data).toMatchObject({ type: 'research', assigned: 'research_analyst', for: 'cto' });
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
