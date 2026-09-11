import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, readJob } from '@cubicle/core';
import { parseToolsConfig, schedulerRequest, missingRiskText, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-risk-sched-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function ctxFor(roleId: string): ToolContext {
  const role = RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${roleId}.md`)).data);
  return {
    vault, events: vault.events, roleId, role, jobId: 'job_parent', config: cfg, env: {},
    workspace: '.cubicle/workspace/job_parent', now: () => new Date(),
    scheduler: { enqueue: (j) => createJob(vault, j, roleId) },
  };
}

const ship = (over: Record<string, unknown> = {}) => ({
  type: 'engineer.ship', title: 'Add the card form', assigned: 'frontend_engineer',
  goal: 'Build it', priority: 3, depends_on: [], done_when: 'The form submits and the test passes.', ...over,
});

describe('scheduler.request and risk', () => {
  it('refuses an engineering job with no risk class, naming the three levels', async () => {
    const r = await schedulerRequest.handler(ship(), ctxFor('dev_manager'));
    expect(r.ok).toBe(false);
    expect(r.text).toBe(missingRiskText('engineer.ship'));
    expect(r.text).toMatch(/low/);
    expect(r.text).toMatch(/medium/);
    expect(r.text).toMatch(/high/);
  });

  it('accepts an engineering job that states its risk and stores both risk and stream', async () => {
    const r = await schedulerRequest.handler(ship({ risk: 'medium', stream: 'checkout' }), ctxFor('dev_manager'));
    expect(r.ok).toBe(true);
    const id = (r.data as { id: string }).id;
    expect(readJob(vault, id)?.data.risk).toBe('medium');
    expect(readJob(vault, id)?.data.stream).toBe('checkout');
  });

  it('a non-engineering job needs no risk and defaults to low', async () => {
    const r = await schedulerRequest.handler({ type: 'custom', title: 'Write the weekly pack', assigned: 'frontend_engineer', goal: 'g', priority: 3, depends_on: [], done_when: 'It is written.' }, ctxFor('dev_manager'));
    expect(r.ok).toBe(true);
    expect(readJob(vault, (r.data as { id: string }).id)?.data.risk).toBe('low');
  });

  it('the tool description tells the model when each level applies', () => {
    expect(schedulerRequest.description).toMatch(/destructive migrations/);
    expect(schedulerRequest.description).toMatch(/engineer\.ship/);
  });
});
