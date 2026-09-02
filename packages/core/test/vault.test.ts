import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { VaultWatcher } from '../src/watcher.js';
import { OwnerOwnedPathError } from '../src/guard.js';
import { EventLog } from '../src/events.js';
import { openMemoryDb } from '../src/db.js';
import { lastCommitHash } from '../src/git.js';

let dir: string;
let vault: Vault;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-vault-'));
  const res = await scaffoldVault(dir);
  vault = res.vault;
});
afterAll(() => {
  vault.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('scaffoldVault', () => {
  it('creates the vault tree, .cubicle, and an initial commit', async () => {
    for (const p of ['00 Inbox', 'Brand/name.md', 'Plans/plan.md', 'Roles/ceo.md', 'Runs', 'Decisions', 'Customers/_suppression.md', 'Metrics/daily.md', 'Metrics/quota.md', 'Memory/constitution.md', 'Memory/owner_preferences.md', 'Memory/lessons.md', 'Skills', 'Experiments', 'Jobs/_template.md', 'Jobs/queue.md', 'Site', 'Meetings', 'Messages/ceo.md', '.cubicle/events', '.env.example', '.gitignore']) {
      expect(existsSync(path.join(dir, p)), p).toBe(true);
    }
    expect(await lastCommitHash(dir)).toBeTruthy();
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.cubicle/');
  });
  it('records template files as written by init', () => {
    expect(vault.writtenSha('Roles/ceo.md')).toBeTruthy();
    expect(vault.isOwnerChanged('Roles/ceo.md')).toBe(false);
  });
  it('refuses to scaffold over an existing vault', async () => {
    await expect(scaffoldVault(dir)).rejects.toThrow(/already exists/);
  });
  it('parses the constitution yaml block', () => {
    const c = vault.constitution();
    expect(c.max_emails_per_day).toBe(20);
    expect(c.never_modify).toContain('Brand/');
    expect(c.pii_local_only).toBe(false);
  });
});

describe('Vault writes', () => {
  it('writes atomically, records sha, emits vault.wrote', () => {
    const before = vault.events.count('vault.wrote');
    const sha = vault.writeNote('Jobs/job_test.md', { id: 'job_test', status: 'queued' }, '## Goal\nx', 'cto');
    expect(vault.writtenSha('Jobs/job_test.md')).toBe(sha);
    expect(vault.isOwnerChanged('Jobs/job_test.md')).toBe(false);
    expect(vault.events.count('vault.wrote')).toBe(before + 1);
    const tmpLeft = readdirSync(path.join(dir, 'Jobs')).filter((f) => f.includes('.tmp-'));
    expect(tmpLeft).toEqual([]);
    const jsonl = readdirSync(path.join(dir, '.cubicle', 'events')).filter((f) => f.endsWith('.jsonl'));
    expect(jsonl.length).toBeGreaterThan(0);
  });
  it('blocks agent writes to owner-owned paths', () => {
    expect(() => vault.writeText('Brand/name.md', 'x', 'ceo')).toThrow(OwnerOwnedPathError);
    expect(() => vault.writeText('Memory/constitution.md', 'x', 'cto')).toThrow(OwnerOwnedPathError);
    expect(() => vault.writeText('Brand/name.md', readFileSync(path.join(dir, 'Brand/name.md'), 'utf8'), 'daemon')).not.toThrow();
  });
  it('detects owner changes by sha', () => {
    writeFileSync(path.join(dir, 'Jobs/job_test.md'), '---\nid: job_test\n---\nowner edited\n');
    expect(vault.isOwnerChanged('Jobs/job_test.md')).toBe(true);
    writeFileSync(path.join(dir, 'Site/owner.html'), '<h1>mine</h1>');
    expect(vault.isOwnerChanged('Site/owner.html')).toBe(true);
  });
  it('rescan records out-of-band writes', () => {
    writeFileSync(path.join(dir, 'Site/built.html'), '<p>from shell</p>');
    const changed = vault.rescan('Site', 'engineer/shell');
    expect(changed).toContain('Site/built.html');
    expect(vault.isOwnerChanged('Site/built.html')).toBe(false);
  });
  it('rebuilds written_sha from events', () => {
    const n = vault.rebuildWrittenSha();
    expect(n).toBeGreaterThan(5);
    expect(vault.writtenSha('Site/built.html')).toBeTruthy();
  });
});

describe('EventLog', () => {
  it('queries by type and rebuilds from jsonl', () => {
    const evs = vault.events.query({ types: ['vault.wrote'] });
    expect(evs.length).toBeGreaterThan(0);
    expect(evs[0].id).toBeTypeOf('number');
    const db = openMemoryDb();
    const n = EventLog.rebuildFromJsonl(db, path.join(dir, '.cubicle', 'events'));
    expect(n).toBe(vault.events.count());
  });
});

describe('VaultWatcher', () => {
  it('suppresses agent writes and reports owner edits', async () => {
    const w = new VaultWatcher(vault, { debounceMs: 300 });
    const seen: string[] = [];
    const off = vault.events.on('owner.edited', (e) => seen.push(String(e.payload.path)));
    await w.start();
    try {
      vault.writeNote('Jobs/job_agent.md', { id: 'job_agent' }, 'agent wrote', 'cto');
      await new Promise((r) => setTimeout(r, 900));
      expect(seen).toEqual([]);
      writeFileSync(path.join(dir, 'Jobs/job_owner.md'), '---\nid: job_owner\nstatus: cancelled\n---\n');
      await new Promise((r) => setTimeout(r, 900));
      expect(seen).toContain('Jobs/job_owner.md');
      const ev = vault.events.last('owner.edited');
      expect(ev?.payload.wakes_heartbeat).toBe(true);
      // owner edit followed by an agent write inside the debounce window still wakes the heartbeat
      seen.length = 0;
      writeFileSync(path.join(dir, 'Jobs/job_agent.md'), '---\nid: job_agent\nstatus: cancelled\n---\nowner\n');
      await new Promise((r) => setTimeout(r, 60));
      vault.writeNote('Jobs/job_agent.md', { id: 'job_agent', status: 'cancelled' }, 'agent again', 'cto');
      await new Promise((r) => setTimeout(r, 900));
      expect(seen).toContain('Jobs/job_agent.md');
    } finally {
      off();
      await w.stop();
    }
  });
});
