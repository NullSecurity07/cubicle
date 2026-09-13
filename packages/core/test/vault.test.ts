import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, repoRoot } from '../src/template.js';
import { ENV_EXAMPLE } from '../src/env-example.js';
import { Vault } from '../src/vault.js';
import { VaultWatcher } from '../src/watcher.js';
import { OwnerOwnedPathError, isOwnerEditablePath, isCachePath } from '../src/guard.js';
import { EventLog } from '../src/events.js';
import { openMemoryDb } from '../src/db.js';
import { lastCommitHash } from '../src/git.js';

let dir: string;
let vault: Vault;

/** Put a file in the vault's git HEAD without ever writing it through the Vault (an owner-authored, committed note). */
function commitFile(rel: string, text: string): void {
  writeFileSync(path.join(dir, rel), text);
  execFileSync('git', ['add', '--', rel], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', `owner adds ${rel}`], { cwd: dir });
}

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
    for (const p of ['00 Inbox', 'Brand/name.md', 'Brand/logo.png', 'Plans/plan.md', 'Roles/ceo.md', 'Runs', 'Decisions', 'Customers/_suppression.md', 'Metrics/daily.md', 'Metrics/quota.md', 'Memory/constitution.md', 'Memory/owner_preferences.md', 'Memory/lessons.md', 'Skills', 'Experiments', 'Jobs/_template.md', 'Jobs/queue.md', 'Site', 'Meetings', 'Messages/ceo.md', '.cubicle/events', '.env.example', '.gitignore']) {
      expect(existsSync(path.join(dir, p)), p).toBe(true);
    }
    expect(await lastCommitHash(dir)).toBeTruthy();
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.cubicle/');
  });
  it('scaffolds a 64x64 Brand/logo.png placeholder', () => {
    const png = readFileSync(path.join(dir, 'Brand', 'logo.png'));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(64); // width
    expect(png.readUInt32BE(20)).toBe(64); // height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // colour type: RGBA
    expect(vault.writtenSha('Brand/logo.png')).toBeTruthy();
    expect(vault.isOwnerChanged('Brand/logo.png')).toBe(false);
  });
  it('generates .env.example from ENV_EXAMPLE, not by copying the repo root', () => {
    const written = readFileSync(path.join(dir, '.env.example'), 'utf8');
    expect(written).toBe(ENV_EXAMPLE);
    expect(written).toContain('GEMINI_API_KEY=');
    expect(vault.writtenSha('.env.example')).toBeTruthy();
  });
  it('ENV_EXAMPLE and the repo-root .env.example cannot drift', () => {
    expect(readFileSync(path.join(repoRoot(), '.env.example'), 'utf8')).toBe(ENV_EXAMPLE);
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
    const changed = vault.rescan('Site', 'backend_engineer/shell');
    expect(changed).toContain('Site/built.html');
    expect(vault.isOwnerChanged('Site/built.html')).toBe(false);
  });
  it('a generated write still emits vault.wrote, flagged generated', () => {
    const before = vault.events.count('vault.wrote');
    vault.writeText('Jobs/queue.md', '# Queue\n\n- nothing\n', 'daemon', { generated: true });
    expect(vault.events.count('vault.wrote')).toBe(before + 1);
    const ev = vault.events.last('vault.wrote')!;
    expect((ev.payload as { path: string; generated?: boolean }).path).toBe('Jobs/queue.md');
    expect((ev.payload as { generated?: boolean }).generated).toBe(true);
  });
  it('a generated file survives a cache rebuild as system-written', () => {
    vault.writeText('Metrics/quota.md', '# Quota\n\nnone yet\n', 'daemon', { generated: true });
    vault.rebuildWrittenSha();
    expect(vault.isOwnerChanged('Metrics/quota.md')).toBe(false);
  });
  it('finds %%cubicle:%% comments added while nothing was watching', () => {
    vault.writeText('Plans/plan.md', '# Plan\n\n- ship the pricing page\n', 'cto');
    expect(vault.commentsChangedSinceWritten()).toEqual([]);

    writeFileSync(path.join(dir, 'Plans/plan.md'), '# Plan\n\n- ship the pricing page %%cubicle: do X%%\n');

    expect(vault.commentsChangedSinceWritten()).toEqual([{ path: 'Plans/plan.md', added: ['do X'] }]);
  });
  it('ignores comments the system itself wrote, and untracked files it never wrote', () => {
    vault.writeText('Plans/plan.md', '# Plan\n\n- ship it %%cubicle: do X%%\n', 'cto');
    writeFileSync(path.join(dir, 'Meetings/owner-only.md'), 'notes %%cubicle: never seen%%\n');

    expect(vault.commentsChangedSinceWritten()).toEqual([]);
  });
  it('falls back to the git HEAD version for a tracked file the system never wrote', () => {
    const rel = 'Plans/owner-authored.md';
    commitFile(rel, '# Mine\n\n- a plan I typed myself\n');
    try {
      expect(vault.writtenComments(rel)).toBeNull();
      expect(vault.commentsChangedSinceWritten()).toEqual([]);

      writeFileSync(path.join(dir, rel), '# Mine\n\n- a plan I typed myself %%cubicle: make it cheaper%%\n');

      expect(vault.commentsChangedSinceWritten()).toEqual([{ path: rel, added: ['make it cheaper'] }]);
    } finally {
      rmSync(path.join(dir, rel), { force: true });
    }
  });
  it('reports only the comments absent from the committed version', () => {
    const rel = 'Plans/owner-commented.md';
    commitFile(rel, '# Mine\n\n- a plan %%cubicle: already asked%%\n');
    try {
      expect(vault.commentsChangedSinceWritten()).toEqual([]);

      writeFileSync(path.join(dir, rel), '# Mine\n\n- a plan %%cubicle: already asked%% %%cubicle: and this too%%\n');

      expect(vault.commentsChangedSinceWritten()).toEqual([{ path: rel, added: ['and this too'] }]);
    } finally {
      rmSync(path.join(dir, rel), { force: true });
    }
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

  it('a bounded window is the NEWEST rows, still oldest-first', () => {
    for (let i = 0; i < 6; i++) vault.events.emit({ type: 'daemon.warning', agent: 'ceo', payload: { where: 'windowing', message: `w${i}` } });
    const all = vault.events.query({ types: ['daemon.warning'] });
    const window = vault.events.query({ types: ['daemon.warning'], limit: 3 });
    // Every caller that passes a limit is asking what happened lately. Reading the oldest N froze those answers
    // at the first rows the vault ever recorded, on a log that only grows.
    expect(window.map((e) => e.payload.message)).toEqual(all.slice(-3).map((e) => e.payload.message));
    expect(window.map((e) => e.id)).toEqual([...window.map((e) => e.id)].sort((a, b) => a! - b!));
    expect(vault.events.query({ types: ['daemon.warning'], limit: 1 })[0].payload.message).toBe('w5');
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

  // Ruling S-7, narrowed by R-I4: `Workspace/` and `.cubicle/` are job workspaces and daemon state, never the
  // owner's; `Site/` stays owner-editable (the reconcile jobs promise "never revert owner edits under Site/",
  // and that promise is only keepable if the watcher reports them), with the scaffold's build output excluded
  // by name through isCachePath and a write made while a job's shell ran attributed to the job by the heartbeat.
  it('never attributes a Workspace/ write to the owner, reports a hand-written Site/ page, and skips build output', async () => {
    const w = new VaultWatcher(vault, { debounceMs: 300 });
    const seen: string[] = [];
    const off = vault.events.on('owner.edited', (e) => seen.push(String(e.payload.path)));
    await w.start();
    try {
      mkdirSync(path.join(dir, 'Workspace/checkout/src'), { recursive: true });
      writeFileSync(path.join(dir, 'Workspace/checkout/src/app.ts'), 'export const x = 1;\n');
      mkdirSync(path.join(dir, 'Site/dist'), { recursive: true });
      writeFileSync(path.join(dir, 'Site/index.html'), '<h1>hi</h1>\n');
      writeFileSync(path.join(dir, 'Site/dist/index.html'), '<h1>built</h1>\n');
      // …and one path that IS the owner's, written the same way in the same window: the guard is about the area,
      // not about the watcher having stopped noticing anything.
      writeFileSync(path.join(dir, 'Brand/voice.md'), '---\n---\nfriendly\n');
      await new Promise((r) => setTimeout(r, 900));
      expect(seen).toContain('Brand/voice.md');
      expect(seen.filter((rel) => rel.startsWith('Workspace/') || rel.startsWith('Site/dist/'))).toEqual([]);
      expect(seen).toContain('Site/index.html');
      expect(isOwnerEditablePath('Workspace/checkout/src/app.ts')).toBe(false);
      expect(isOwnerEditablePath('Site/index.html')).toBe(true);
      expect(isCachePath('Site/dist/index.html')).toBe(true);
      expect(isOwnerEditablePath('.cubicle/daemon.json')).toBe(false);
      expect(isOwnerEditablePath('Brand/voice.md')).toBe(true);
    } finally { off(); await w.stop(); }
  });

  // Before this the only 'error' listener was the one-shot reject inside start()'s ready race, so a chokidar
  // error after ready was an uncaught exception: a transient FS error (a file removed mid-scan, EMFILE) took
  // the whole daemon down, and it already failed a CI run as an unhandled ENOENT during teardown.
  it('survives a chokidar error after ready and reports it as a daemon.warning', async () => {
    const w = new VaultWatcher(vault, { debounceMs: 100 });
    await w.start();
    try {
      expect(w.fsWatcher).not.toBeNull();
      w.fsWatcher!.emit('error', new Error('ENOENT: lstat /tmp/cubicle-gone'));
      const warning = vault.events.query({ types: ['daemon.warning'] }).find((e) => e.payload.where === 'watcher');
      expect(warning).toBeTruthy();
      expect(String(warning!.payload.message)).toContain('ENOENT');
      // Still watching: an owner edit after the error is still reported.
      const seen: string[] = [];
      const off = vault.events.on('owner.edited', (e) => seen.push(String(e.payload.path)));
      try {
        writeFileSync(path.join(dir, 'Jobs/job_after_error.md'), '---\nid: job_after_error\n---\n');
        await new Promise((r) => setTimeout(r, 900));
        expect(seen).toContain('Jobs/job_after_error.md');
      } finally { off(); }
    } finally { await w.stop(); }
  });
});
