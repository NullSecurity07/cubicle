import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, ciConfigPath, latestCiRecord } from '@cubicle/core';
import { parseToolsConfig, ciRun, ToolRegistry, phase5Tools, phase3Tools, hasDocker, hasSandboxImage, commandPublishes, type ToolContext } from '../src/index.js';

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

/**
 * Whether a real sandbox exists here. Without one `sandboxExec` refuses (the scaffolded vault leaves
 * `shell_local_fallback: false`), so the cases below assert the refusal shape instead of a pipeline result —
 * the same branch phase5.test.ts and critique56.test.ts take.
 */
const SANDBOXED = hasDocker() && hasSandboxImage();

/** `true` and `false` exist in every sandbox mode, so these steps run identically under Docker and bwrap. */
const GREEN = 'steps:\n  - { name: build, run: "true" }\n  - { name: test, run: "true" }\n';
const RED = 'steps:\n  - { name: build, run: "true" }\n  - { name: test, run: "false" }\n';
const ADVISORY = 'steps:\n  - { name: test, run: "true" }\n  - { name: security-scan, run: "false", allow_failure: true }\n';

/** No Docker image and no opted-in local shell: sandboxExec refuses before the first step runs, and says so. */
function expectNoSandbox(r: { ok: boolean; text: string }): void {
  expect(r.ok).toBe(false);
  expect(r.text).toMatch(/blocked:/);
  expect(r.text).toMatch(/never ran/);
}

describe('ci.run', () => {
  it('refuses a stream with no cubicle-ci.yaml and says where to put one', async () => {
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Workspace/checkout/cubicle-ci.yaml');
  });

  it('runs every step, writes a green record and emits ci.completed', async () => {
    vault.writeText(ciConfigPath('checkout'), GREEN, 'daemon');
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    if (!SANDBOXED) return expectNoSandbox(r);
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
    if (!SANDBOXED) return expectNoSandbox(r);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/test/);
    const rec = latestCiRecord(vault, 'checkout')!.record;
    expect(rec.green).toBe(false);
    expect(rec.steps.find((s) => s.name === 'test')!.ok).toBe(false);
  }, 120_000);

  it('allow_failure keeps the run green and still records the failure', async () => {
    vault.writeText(ciConfigPath('checkout'), ADVISORY, 'daemon');
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    if (!SANDBOXED) return expectNoSandbox(r);
    expect(r.ok).toBe(true);
    const rec = latestCiRecord(vault, 'checkout')!.record;
    expect(rec.green).toBe(true);
    expect(rec.steps.find((s) => s.name === 'security-scan')!.ok).toBe(false);
    expect(r.text).toMatch(/security-scan/);
  }, 120_000);

  it('`only` runs the named steps and nothing else', async () => {
    vault.writeText(ciConfigPath('checkout'), RED, 'daemon');
    const r = await ciRun.handler({ stream: 'checkout', only: ['build'] }, ctxFor());
    if (!SANDBOXED) return expectNoSandbox(r);
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

  it('refuses a slug that is not a slug, before it can become a path or a mount', async () => {
    // `Workspace/x,src=/etc` is a directory an agent can create with vault.write, and Docker parses
    // `--mount type=bind,src=…,dst=…` as CSV, so a comma in the slug would inject mount keys.
    for (const bad of ['x,src=/etc', '../../Memory', 'check out', 'Checkout', '', 'a'.repeat(49), '-lead', 'x/../y']) {
      const r = await ciRun.handler({ stream: bad, only: [] }, ctxFor());
      expect(r.ok, bad).toBe(false);
      expect(r.text, bad).toContain('is not a stream slug');
      expect(r.text, bad).not.toContain('Unsafe vault path');   // a refusal a model can act on, not a thrown path error
    }
    expect(vault.events.query({ types: ['ci.completed'] })).toHaveLength(0);
  });

  it('a CI record cannot be forged through the vault write API', () => {
    expect(() => vault.writeText('Workspace/checkout/.cubicle-ci/forged.json', '{"green":true}', 'backend_engineer')).toThrow(/cache path/);
  });
});

describe('a CI step that publishes gets the same secret scan as shell.run (fix wave item 9 / I4)', () => {
  const AWS = 'AKIAIOSFODNN7EXAMPLE';
  const PUSH = 'steps:\n  - { name: build, run: "true" }\n  - { name: publish, run: "git push origin main" }\n';

  const seed = (slug: string, yaml: string) => {
    vault.writeText(ciConfigPath(slug), yaml, 'backend_engineer');
    vault.writeText(`Workspace/${slug}/src/app.js`, 'export const v = 1;\n', 'backend_engineer');
  };

  it('refuses before the step runs when a key is in the tree, and says which step and why', async () => {
    seed('checkout', PUSH);
    vault.writeText('Workspace/checkout/src/keys.js', `export const k = "${AWS}";\n`, 'backend_engineer');
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/publish/);
    expect(r.text).toMatch(/REFUSED before it ran/);
    expect(r.text).toMatch(/AWS access key id/);
    expect(r.text).toMatch(/\.env/);   // the advice a model can act on
  });

  it('records the refusal as a red CI record, so the ship gate sees it', async () => {
    seed('checkout', PUSH);
    vault.writeText('Workspace/checkout/src/keys.js', `export const k = "${AWS}";\n`, 'backend_engineer');
    await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    const rec = latestCiRecord(vault, 'checkout')!;
    expect(rec.record.green).toBe(false);
    expect(rec.record.steps.at(-1)!.name).toBe('publish');
    expect(rec.record.steps.at(-1)!.ok).toBe(false);
    const blocked = vault.events.query({ types: ['guardrail.blocked'] });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].payload).toMatchObject({ tool: 'ci.run', step: 'publish' });
  });

  it('allow_failure does not make a leaking publish advisory', async () => {
    seed('checkout', 'steps:\n  - { name: publish, run: "git push", allow_failure: true }\n');
    vault.writeText('Workspace/checkout/src/keys.js', `export const k = "${AWS}";\n`, 'backend_engineer');
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    expect(r.ok).toBe(false);
    expect(latestCiRecord(vault, 'checkout')!.record.green).toBe(false);
  });

  it('a publishing step with a clean tree is not refused by the scan', async () => {
    seed('checkout', PUSH);
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    // Whatever the sandbox does with it, the guardrail is not what stopped it.
    expect(r.text).not.toMatch(/REFUSED before it ran/);
    expect(vault.events.query({ types: ['guardrail.blocked'] })).toHaveLength(0);
  });

  it('a pipeline that publishes nothing is never scanned, even with a key in the tree', async () => {
    seed('checkout', GREEN);
    vault.writeText('Workspace/checkout/src/keys.js', `export const k = "${AWS}";\n`, 'backend_engineer');
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor());
    expect(r.text).not.toMatch(/REFUSED before it ran/);
    expect(vault.events.query({ types: ['guardrail.blocked'] })).toHaveLength(0);
  });

  it('the matcher is the same one shell.run uses — a disguised push is caught too', async () => {
    for (const cmd of ['/usr/bin/git push', 'sh -c "git push origin main"', 'true && git push']) {
      expect(commandPublishes(cmd), cmd).toBe(true);
    }
    seed('disguised', `steps:\n  - { name: publish, run: 'sh -c "git push origin main"' }\n`);
    vault.writeText('Workspace/disguised/src/keys.js', `export const k = "${AWS}";\n`, 'backend_engineer');
    const r = await ciRun.handler({ stream: 'disguised', only: [] }, ctxFor());
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/REFUSED before it ran/);
  });
});
