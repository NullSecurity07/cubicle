import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, loadOrg, listJobs, createProposal } from '@cubicle/core';
import { seedFirstJobs, FIRST_JOB_TITLES } from '../src/index.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-firstrun-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the first-run seeds pick people by office and capability', () => {
  it('the build seed goes to someone in the engineering division who can deploy, the channel seed to someone who can send mail', () => {
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'A meal-prep site' }, 'owner');
    const ids = seedFirstJobs(vault, loadOrg(vault));
    expect(ids).toHaveLength(3);
    const jobs = listJobs(vault);
    const byTitle = (t: string) => jobs.find((j) => j.title === t)!;
    expect(byTitle(FIRST_JOB_TITLES[0]).assigned).toBe('backend_engineer');
    expect(byTitle(FIRST_JOB_TITLES[0]).owner_role).toBe('dev_manager');
    expect(byTitle(FIRST_JOB_TITLES[1]).assigned).toBe('research_manager');
    expect(byTitle(FIRST_JOB_TITLES[1]).for).toBe('cmo');
    expect(byTitle(FIRST_JOB_TITLES[2]).assigned).toBe('cmo');
  });

  it('with the engineering room gone the build seed falls back to the office holder', () => {
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'idea', body: 'A meal-prep site' }, 'owner');
    const org = loadOrg(vault);
    const thin = { ...org, teams: Object.fromEntries(Object.entries(org.teams).filter(([id]) => id !== 'dev' && id !== 'qa')) };
    const ids = seedFirstJobs(vault, thin);
    expect(listJobs(vault).find((j) => j.id === ids[0])!.assigned).toBe('cto');
  });
});
