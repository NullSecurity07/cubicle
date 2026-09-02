import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { normalizeRel, assertWritable, UnsafePathError, OwnerOwnedPathError, isValidRoleId, isSecretPath } from '../src/guard.js';
import { VaultWatcher } from '../src/watcher.js';

let dir: string; let vault: Vault; let outside: string;
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sec-'));
  outside = mkdtempSync(path.join(tmpdir(), 'cubicle-outside-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

describe('path hardening', () => {
  it('normalises and rejects traversal', () => {
    expect(normalizeRel('./Brand/x.md')).toBe('Brand/x.md');
    expect(normalizeRel('Brand\\x.md')).toBe('Brand/x.md');
    expect(normalizeRel('/Brand//x.md')).toBe('Brand/x.md');
    expect(normalizeRel('Memory/x/../lessons.md')).toBe('Memory/lessons.md');
    for (const bad of ['Memory/../../etc/passwd', '../x', '..', 'a/../../b', 'C:/x', 'a\0b']) expect(() => normalizeRel(bad), bad).toThrow(UnsafePathError);
  });
  it('guard sees through dot segments', () => {
    expect(() => assertWritable('Memory/../Brand/name.md', 'cto')).toThrow(OwnerOwnedPathError);
    expect(() => assertWritable('Memory/x/../constitution.md', 'cto')).toThrow(OwnerOwnedPathError);
    expect(() => assertWritable('./Brand/x.md', 'cto')).toThrow(OwnerOwnedPathError);
    expect(() => assertWritable('Brand\\x.md', 'cto')).toThrow(OwnerOwnedPathError);
  });
  it('agents cannot rewrite the constitution or brand via the vault API', () => {
    const before = vault.readText('Memory/constitution.md');
    expect(() => vault.writeText('Memory/../Memory/constitution.md', 'max_emails_per_day: 99999', 'cto')).toThrow(OwnerOwnedPathError);
    expect(() => vault.writeText('Memory/x/../constitution.md', 'x', 'cto')).toThrow(OwnerOwnedPathError);
    expect(() => vault.writeText('../outside.md', 'x', 'cto')).toThrow(UnsafePathError);
    expect(vault.readText('Memory/constitution.md')).toBe(before);
    expect(vault.constitution().max_emails_per_day).toBe(20);
  });
  it('symlinks that escape the vault are refused', () => {
    symlinkSync(outside, path.join(dir, 'Skills', 'escape'));
    expect(() => vault.writeText('Skills/escape/x.md', 'x', 'engineer')).toThrow(/symlink/);
    expect(() => vault.abs('Skills/escape/x.md')).toThrow(/symlink/);
  });
  it('validates role ids and secret paths', () => {
    expect(isValidRoleId('growth')).toBe(true);
    expect(isValidRoleId('../Brand/voice')).toBe(false);
    expect(isValidRoleId('Growth Team')).toBe(false);
    expect(isSecretPath('.env')).toBe(true);
    expect(isSecretPath('.env.local')).toBe(true);
    expect(isSecretPath('.git/config')).toBe(true);
    expect(isSecretPath('Plans/plan.md')).toBe(false);
  });
});

describe('ids and note safety', () => {
  it('createJob never clobbers an existing note and deterministic ids are idempotent', async () => {
    const { createJob, readJob } = await import('../src/jobs.js');
    const a = createJob(vault, { id: 'job_fixed', type: 'custom', title: 'first', assigned: 'coo', goal: 'g' }, 'cto');
    const b = createJob(vault, { id: 'job_fixed', type: 'custom', title: 'second', assigned: 'coo', goal: 'g' }, 'cto');
    expect(a).toBe(b);
    expect(readJob(vault, 'job_fixed')!.data.title).toBe('first');
  });
  it('updateNote refuses a note with malformed frontmatter', () => {
    writeFileSync(path.join(dir, 'Jobs/broken.md'), '---\n: : not yaml [\n---\nbody\n');
    expect(() => vault.updateNote('Jobs/broken.md', (n) => n, 'daemon')).toThrow(/malformed/);
    expect(readFileSync(path.join(dir, 'Jobs/broken.md'), 'utf8')).toContain('not yaml');
  });
  it('system moves and deletes are tombstoned so the watcher stays quiet', async () => {
    vault.writeText('Plans/tmp.md', 'x', 'daemon');
    const w = new VaultWatcher(vault, { debounceMs: 200 });
    const seen: string[] = [];
    const off = vault.events.on('owner.edited', (e) => seen.push(String(e.payload.path)));
    await w.start();
    try {
      vault.move('Plans/tmp.md', 'Plans/archive/tmp.md', 'daemon');
      vault.remove('Plans/archive/tmp.md', 'daemon');
      await new Promise((r) => setTimeout(r, 700));
      expect(seen).toEqual([]);
    } finally { off(); await w.stop(); }
  });
});
