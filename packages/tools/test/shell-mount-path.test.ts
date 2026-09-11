import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, ciConfigPath } from '@cubicle/core';
import { parseToolsConfig, mountField, createRoleToolClient, ToolRegistry, phase5Tools, ciRun, hasDocker, hasSandboxImage, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
const SANDBOXED = hasDocker() && hasSandboxImage();

/**
 * The mount backstop in `sandboxExec` used to refuse any mount whose *full* host path contained "," or "=",
 * which meant a vault simply installed under a directory containing either character (an owner's own,
 * trusted choice — nothing to do with a caller-supplied stream slug or dir) made every `shell.run` and
 * `ci.run` call fail. `mountField` replaces that refusal with Docker's own escaping for its CSV-style
 * `--mount` value: only a literal comma (the field separator) or a `"` needs quoting; `=` never did, since
 * the key/value split happens on the first `=` only.
 */
describe('mountField (Docker --mount CSV escaping)', () => {
  it('passes an ordinary path through unquoted', () => {
    expect(mountField('src', '/home/owner/vault')).toBe('src=/home/owner/vault');
  });

  it('leaves "=" alone: the key/value split uses only the first "="', () => {
    expect(mountField('src', '/home/owner=x/vault')).toBe('src=/home/owner=x/vault');
  });

  it('quotes a path containing the field-separating comma', () => {
    expect(mountField('src', '/home/owner,inc/vault')).toBe('src="/home/owner,inc/vault"');
  });

  it('doubles an embedded double quote when the field is already quoted', () => {
    expect(mountField('dst', '/work/a"b,c')).toBe('dst="/work/a""b,c"');
  });
});

describe('sandboxExec mounts a vault whose path contains "="', () => {
  let dir: string; let vault: Vault;
  afterEach(() => { vault?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  function ctxFor(v: Vault, roleId = 'backend_engineer'): ToolContext {
    const role = RoleFrontmatter.parse(parseNote(v.readText(`Roles/${roleId}.md`)).data);
    return { vault: v, events: v.events, roleId, role, jobId: 'job_eq', config: cfg, env: {}, workspace: '.cubicle/workspace/job_eq', now: () => new Date(), scheduler: { enqueue: (j) => createJob(v, j, roleId) } };
  }

  it('shell.run succeeds instead of being refused for the "=" in the vault root', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cubicle=shell-'));
    vault = (await scaffoldVault(dir)).vault;
    expect(dir).toContain('=');
    const reg = new ToolRegistry().registerAll(phase5Tools());
    const client = await createRoleToolClient(reg.forRole(ctxFor(vault).role, cfg), ctxFor(vault));
    try {
      const r = await client.call('shell.run', { command: 'echo ok' });
      if (!SANDBOXED) {
        // No sandbox here at all: the refusal must be about Docker/bwrap, never about "," or "=" in a path.
        expect(r.ok).toBe(false);
        expect(r.text).not.toMatch(/may not contain/);
        return;
      }
      expect(r.ok).toBe(true);
      expect(r.text).toContain('ok');
    } finally { await client.close(); }
  }, 60_000);

  it('ci.run succeeds instead of being refused for the "=" in the vault root', async () => {
    // Direct handler call, like ci.test.ts: ci.run's charter permission is a separate concern (tools.yaml)
    // from the mount-path bug under test here.
    dir = mkdtempSync(path.join(tmpdir(), 'cubicle=ci-'));
    vault = (await scaffoldVault(dir)).vault;
    expect(dir).toContain('=');
    vault.writeText(ciConfigPath('checkout'), 'steps:\n  - { name: build, run: "true" }\n', 'daemon');
    const r = await ciRun.handler({ stream: 'checkout', only: [] }, ctxFor(vault));
    if (!SANDBOXED) {
      expect(r.ok).toBe(false);
      expect(r.text).not.toMatch(/may not contain/);
      return;
    }
    expect(r.ok).toBe(true);
  }, 60_000);
});
