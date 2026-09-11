import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { JobFrontmatter, RISK_LEVELS, RISK_GUIDANCE, ENGINEERING_JOB_TYPES } from '../src/schemas.js';
import { createJob, readJob } from '../src/jobs.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-risk-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('risk on jobs (owner operating model §27)', () => {
  it('three levels, low by default, every level has guidance an agent can act on', () => {
    expect(RISK_LEVELS).toEqual(['low', 'medium', 'high']);
    expect(JobFrontmatter.parse({ id: 'j', type: 'custom', title: 't', assigned: 'ceo', created: '', updated: '' }).risk).toBe('low');
    for (const lvl of RISK_LEVELS) expect(RISK_GUIDANCE[lvl].length).toBeGreaterThan(20);
    expect(RISK_GUIDANCE.high).toMatch(/auth/i);
    expect(RISK_GUIDANCE.medium).toMatch(/integration/i);
    expect(RISK_GUIDANCE.low).toMatch(/text|UI/i);
  });

  it('engineer.ship is an engineering type and must state its risk', () => {
    expect([...ENGINEERING_JOB_TYPES]).toContain('engineer.ship');
  });

  it('createJob stores the risk and readJob returns it', () => {
    const id = createJob(vault, { type: 'engineer.ship', title: 'Rotate the session key', assigned: 'backend_engineer', goal: 'g', risk: 'high' }, 'dev_manager');
    expect(readJob(vault, id)?.data.risk).toBe('high');
    const plain = createJob(vault, { type: 'custom', title: 'Fix a typo', assigned: 'backend_engineer', goal: 'g' }, 'dev_manager');
    expect(readJob(vault, plain)?.data.risk).toBe('low');
  });

  it('an unknown risk value fails the note rather than defaulting silently', () => {
    const parsed = JobFrontmatter.safeParse({ id: 'j', type: 'custom', title: 't', assigned: 'ceo', created: '', updated: '', risk: 'catastrophic' });
    expect(parsed.success).toBe(false);
  });
});
