import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, listJobs, createProposal, loadOrg } from '@cubicle/core';
import { applyReorg, applyFire, maybeEnqueuePostmortem, maybeEnqueueWeeklyReview } from '../src/evolution.js';

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
