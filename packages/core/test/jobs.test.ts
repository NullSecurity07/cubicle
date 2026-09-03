import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, templateDir } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { listJobs, readJob } from '../src/jobs.js';

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
