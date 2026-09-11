import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, ciConfigPath, latestCiRecord } from '@cubicle/core';
import { parseToolsConfig, ciRun, ToolRegistry, phase5Tools, phase3Tools, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-cirun-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function ctxFor(roleId = 'backend_engineer'): ToolContext {
  const role = RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${roleId}.md`)).data);
  return {
    vault, events: vault.events, roleId, role, jobId: 'job_ci', config: cfg, env: {},
    workspace: '.cubicle/workspace/job_ci', now: () => new Date(),
    scheduler: { enqueue: (j) => createJob(vault, j, roleId) },
  };
}

/** `true` and `false` exist in every sandbox mode, so these steps run identically under Docker and bwrap. */
const GREEN = 'steps:\n  - { name: build, run: "true" }\n  - { name: test, run: "true" }\n';
const RED = 'steps:\n  - { name: build, run: "true" }\n  - { name: test, run: "false" }\n';
const ADVISORY = 'steps:\n  - { name: test, run: "true" }\n  - { name: security-scan, run: "false", allow_failure: true }\n';

describe('ci.run', () => {
  it('refuses a stream with no cubicle-ci.yaml and says where to put one', async () => {
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Workspace/checkout/cubicle-ci.yaml');
  });

  it('runs every step, writes a green record and emits ci.completed', async () => {
    vault.writeText(ciConfigPath('checkout'), GREEN, 'daemon');
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    expect(r.ok).toBe(true);
    const rec = latestCiRecord(vault, 'checkout')!;
    expect(rec.record.green).toBe(true);
    expect(rec.record.steps.map((s) => s.name)).toEqual(['build', 'test']);
    expect(rec.path).toMatch(/^Workspace\/checkout\/\.cubicle-ci\/.*\.json$/);
    const ev = vault.events.query({ types: ['ci.completed'] });
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ stream: 'checkout', green: true });
  }, 120_000);

  it('stops at the first blocking failure and records it red', async () => {
    vault.writeText(ciConfigPath('checkout'), RED, 'daemon');
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/test/);
    const rec = latestCiRecord(vault, 'checkout')!.record;
    expect(rec.green).toBe(false);
    expect(rec.steps.find((s) => s.name === 'test')!.ok).toBe(false);
  }, 120_000);

  it('allow_failure keeps the run green and still records the failure', async () => {
    vault.writeText(ciConfigPath('checkout'), ADVISORY, 'daemon');
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    expect(r.ok).toBe(true);
    const rec = latestCiRecord(vault, 'checkout')!.record;
    expect(rec.green).toBe(true);
    expect(rec.steps.find((s) => s.name === 'security-scan')!.ok).toBe(false);
    expect(r.text).toMatch(/security-scan/);
  }, 120_000);

  it('`only` runs the named steps and nothing else', async () => {
    vault.writeText(ciConfigPath('checkout'), RED, 'daemon');
    const r = await ciRun.handler({ stream: 'checkout', only: ['build'] }, ctxFor());
    expect(r.ok).toBe(true);
    expect(latestCiRecord(vault, 'checkout')!.record.steps.map((s) => s.name)).toEqual(['build']);
  }, 120_000);

  it('an unknown name in `only` is refused rather than silently running nothing', async () => {
    vault.writeText(ciConfigPath('checkout'), GREEN, 'daemon');
    const r = await ciRun.handler({ stream: 'checkout', only: ['typecheck'] }, ctxFor());
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/typecheck/);
    expect(r.text).toMatch(/build, test/);
  });

  it('is registered in phase 5 and reaches an engineer through the charter filter', () => {
    const reg = new ToolRegistry().registerAll([...phase3Tools(), ...phase5Tools()]);
    expect(reg.names()).toContain('ci.run');
    const role = RoleFrontmatter.parse(parseNote(vault.readText('Roles/backend_engineer.md')).data);
    expect(reg.forRole({ ...role, tools: ['ci.run'] }, cfg).map((t) => t.name)).toEqual(['ci.run']);
    const cmo = RoleFrontmatter.parse(parseNote(vault.readText('Roles/cmo.md')).data);
    expect(reg.forRole({ ...cmo, tools: ['ci.run'] }, cfg)).toEqual([]);   // tools.yaml restricts ci.run to the engineering roster
  });

  it('a CI record cannot be forged through the vault write API', () => {
    expect(() => vault.writeText('Workspace/checkout/.cubicle-ci/forged.json', '{"green":true}', 'backend_engineer')).toThrow(/cache path/);
  });
});
