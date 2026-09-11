import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob } from '@cubicle/core';
import { parseToolsConfig, deploySite, DEPLOY_STAGES, previousLiveSnapshot, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-deploy-')); vault = (await scaffoldVault(dir)).vault;
  vault.writeText('Brand/name.md', '---\nname: Acme\ntagline: t\nurl: ""\n---\n# Acme\n', 'owner');
  // Site/dist is a cache path (core/src/guard.ts:isCachePath): a build writes it, never the vault API.
  mkdirSync(path.join(dir, 'Site/dist'), { recursive: true });
  writeFileSync(path.join(dir, 'Site/dist/index.html'), '<!doctype html><title>v1</title>\n');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

let step = 0;
function ctxFor(roleId = 'sre'): ToolContext {
  const role = RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${roleId}.md`)).data);
  return { vault, events: vault.events, roleId, role, jobId: 'job_d', config: cfg, env: {}, workspace: '.cubicle/workspace/job_d', now: () => new Date(), idempotencyKey: `job_d:1:${++step}`, scheduler: { enqueue: (j) => createJob(vault, j, roleId) } };
}

const args = (over: Record<string, unknown> = {}) => ({ dir: 'Site/dist', stage: 'preview' as const, canary_percent: 5, metrics: [] as string[], rollback: false, ...over });

describe('deploy.site stages (owner operating model §20)', () => {
  it('the three stages are preview, canary, live', () => {
    expect(DEPLOY_STAGES).toEqual(['preview', 'canary', 'live']);
  });

  it('a preview deploy needs nothing before it and records its stage', async () => {
    const r = await deploySite.handler(args(), ctxFor());
    expect(r.ok).toBe(true);
    const ev = vault.events.query({ types: ['deploy.done'] });
    expect(ev[0].payload).toMatchObject({ stage: 'preview' });
  });

  it('canary is refused until a preview of the same project has gone out', async () => {
    const refused = await deploySite.handler(args({ stage: 'canary' }), ctxFor());
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/preview/);

    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    const ok = await deploySite.handler(args({ stage: 'canary', metrics: ['error rate', 'checkout completion'] }), ctxFor());
    expect(ok.ok).toBe(true);
    const last = vault.events.query({ types: ['deploy.done'] }).at(-1)!;
    expect(last.payload).toMatchObject({ stage: 'canary', canary_percent: 5 });
    expect(last.payload.metrics).toEqual(['error rate', 'checkout completion']);
  });

  it('live is refused until a canary has gone out, and demands the metrics it will watch', async () => {
    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    const noCanary = await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());
    expect(noCanary.ok).toBe(false);
    expect(noCanary.text).toMatch(/canary/);

    await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
    const noMetrics = await deploySite.handler(args({ stage: 'live', metrics: [] }), ctxFor());
    expect(noMetrics.ok).toBe(false);
    expect(noMetrics.text).toMatch(/metrics/);

    const live = await deploySite.handler(args({ stage: 'live', metrics: ['error rate', 'latency'] }), ctxFor());
    expect(live.ok).toBe(true);
    expect(vault.events.query({ types: ['deploy.done'] }).at(-1)!.payload).toMatchObject({ stage: 'live', metrics: ['error rate', 'latency'] });
  });

  it('every deploy keeps a snapshot, and rollback republishes the previous live one', async () => {
    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
    await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());

    writeFileSync(path.join(dir, 'Site/dist/index.html'), '<!doctype html><title>v2 broken</title>\n');
    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
    await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());

    expect(previousLiveSnapshot(vault, 'acme')).not.toBeNull();
    const back = await deploySite.handler(args({ rollback: true, stage: 'live', metrics: ['error rate'] }), ctxFor());
    expect(back.ok).toBe(true);
    expect(back.text).toMatch(/rolled back/i);
    const ev = vault.events.query({ types: ['deploy.done'] }).at(-1)!;
    expect(ev.payload).toMatchObject({ rolled_back: true, stage: 'live' });
    expect(readFileSync(path.join(dir, 'Site/dist/index.html'), 'utf8')).toContain('v1');
  });

  it('a rollback with nothing to roll back to says so instead of pretending', async () => {
    const r = await deploySite.handler(args({ rollback: true }), ctxFor());
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/no previous live deploy/i);
  });

  it('the description says the canary percentage is a mock until real infrastructure exists', () => {
    expect(deploySite.description).toMatch(/mock/i);
    expect(deploySite.description).toMatch(/preview.*canary.*live/i);
  });
});
