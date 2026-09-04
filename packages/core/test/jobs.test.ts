import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, templateDir } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { listJobs, readJob, createJob, updateJob, cancelJob } from '../src/jobs.js';

let dir: string;
let vault: Vault;

/** The template exactly as an owner would copy it out of the vault. */
function jobTemplate(title: string): string {
  return readFileSync(path.join(templateDir(), 'Jobs', '_template.md'), 'utf8').replace('title: "Describe the job"', `title: "${title}"`);
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-jobs-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => {
  vault.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('owner-created job notes (spec §11)', () => {
  it('a job note whose id does not match its filename is reconciled to the filename', () => {
    vault.writeText('Jobs/mine.md', jobTemplate('Mine'), 'owner');

    const jobs = listJobs(vault);

    expect(jobs.map((j) => j.id)).toContain('mine');
    expect(readJob(vault, 'mine')?.data.title).toBe('Mine');
    expect(vault.readNote('Jobs/mine.md').data.id).toBe('mine');
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => /reconciled/.test(String((e.payload as { reason?: string }).reason)))).toBe(true);
  });

  it('readJob reconciles a mismatched id without listJobs running first', () => {
    vault.writeText('Jobs/urgent.md', jobTemplate('Urgent'), 'owner');

    expect(readJob(vault, 'urgent')?.data.id).toBe('urgent');
    expect(vault.readNote('Jobs/urgent.md').data.id).toBe('urgent');
  });

  it('a template copied verbatim (empty created/updated) still parses and gets timestamps', () => {
    vault.writeText('Jobs/blank.md', jobTemplate('Blank'), 'owner');

    const job = listJobs(vault).find((j) => j.id === 'blank')!;

    expect(job.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(job.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(vault.readNote('Jobs/blank.md').data.created)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('leaves a well-formed job note alone', () => {
    vault.writeText('Jobs/mine.md', jobTemplate('Mine'), 'owner');
    listJobs(vault);
    const sha = vault.currentSha('Jobs/mine.md');

    listJobs(vault);

    expect(vault.currentSha('Jobs/mine.md')).toBe(sha);
  });

  it('reconciling a note does not claim the owner comments as system-written', () => {
    vault.writeText('Jobs/mine.md', jobTemplate('Mine'), 'daemon'); // system baseline: no comments
    writeFileSync(vault.abs('Jobs/mine.md'), jobTemplate('Mine').replace('## Goal', '## Goal\n\n%%cubicle: hurry%%')); // owner edits in Obsidian

    listJobs(vault); // rewrites id and timestamps

    expect(vault.writtenComments('Jobs/mine.md')).toEqual([]);
    expect(vault.commentsChangedSinceWritten()).toEqual([{ path: 'Jobs/mine.md', added: ['hurry'] }]);
    expect(vault.readText('Jobs/mine.md')).toContain('%%cubicle: hurry%%');
  });
  it('skips underscore-prefixed notes in both listJobs and readJob', () => {
    vault.writeText('Jobs/_urgent.md', jobTemplate('Draft'), 'owner');
    const before = vault.currentSha('Jobs/_urgent.md');

    expect(listJobs(vault).some((j) => j.title === 'Draft')).toBe(false);
    expect(readJob(vault, '_urgent')?.data.id).toBe('job_REPLACE');
    expect(vault.currentSha('Jobs/_urgent.md')).toBe(before);
  });
  it('never rewrites the template or the generated queue note', () => {
    const before = vault.currentSha('Jobs/_template.md');

    expect(readJob(vault, '_template')?.data.id).toBe('job_REPLACE');

    expect(vault.currentSha('Jobs/_template.md')).toBe(before);
  });
});

describe('cancelJob (spec §11: a cancel is always visible)', () => {
  it('sets cancelled, logs the reason, emits job.cancelled and reports the change', () => {
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'head_of_growth', goal: 'g' }, 'cto');
    expect(cancelJob(vault, id, 'owner', 'the owner ran cubicle job cancel')).toBe(true);

    const j = readJob(vault, id)!;
    expect(j.data.status).toBe('cancelled');
    expect(j.body).toContain('cancelled (the owner ran cubicle job cancel)');
    const ev = vault.events.last('job.cancelled')!;
    expect(ev.job).toBe(id);
    expect(ev.agent).toBe('owner');
    expect(ev.payload.reason).toBe('the owner ran cubicle job cancel');
    expect(ev.payload.at_step).toBe(0);
  });

  it('carries the step the job had reached, so the office knows where it stopped', () => {
    const id = createJob(vault, { type: 'research', title: 'r', assigned: 'head_of_growth', goal: 'g' }, 'cto');
    updateJob(vault, id, { status: 'running', checkpoint_step: 3 }, 'head_of_growth');
    expect(cancelJob(vault, id, 'daemon', 'role left')).toBe(true);
    expect(vault.events.last('job.cancelled')!.payload.at_step).toBe(3);
  });

  it('leaves a finished job alone and emits nothing', () => {
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      const id = createJob(vault, { type: 'research', title: status, assigned: 'head_of_growth', goal: 'g' }, 'cto');
      updateJob(vault, id, { status }, 'coo');
      const before = vault.events.count('job.cancelled');
      expect(cancelJob(vault, id, 'daemon', 'too late')).toBe(false);
      expect(readJob(vault, id)!.data.status).toBe(status);
      expect(vault.events.count('job.cancelled')).toBe(before);
    }
  });

  it('is a no-op on a job that does not exist', () => {
    expect(cancelJob(vault, 'job_nope', 'owner', 'x')).toBe(false);
    expect(vault.events.count('job.cancelled')).toBe(0);
  });
});
