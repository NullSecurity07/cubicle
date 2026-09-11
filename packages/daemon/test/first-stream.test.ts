import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listStreams, readStream, createProposal, loadOrg, listJobs } from '@cubicle/core';
import { seedFirstStream, firstStreamSpec, seedFirstJobs } from '../src/first-run.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-firststream-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function idea(name: string, tagline: string, ownerNote: string): void {
  vault.writeText('Brand/name.md', `---\nname: ${name}\ntagline: ${tagline}\nurl: ""\n---\n# ${name}\n`, 'owner');
  createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'The idea', body: ownerNote }, 'owner');
}

describe('firstStreamSpec', () => {
  it('turns the brand and the owner note into a stream whose unanswered fields are questions, not TBD', () => {
    const s = firstStreamSpec({ name: 'Ledgerly', tagline: 'Books that close themselves' }, 'Small agencies waste two days a month reconciling invoices by hand.');
    expect(s.name).toBe('Ledgerly');
    expect(s.problem).toContain('reconciling invoices');
    expect(s.customers).toMatch(/\?/);
    expect(s.outcome_metric).toMatch(/\?/);
    expect(s.owner_team).toBe('dev');
    expect(`${s.problem} ${s.customers} ${s.outcome_metric}`).not.toMatch(/TBD|TODO|placeholder/i);
  });

  it('falls back to the tagline when the owner wrote no note, and never to an empty problem', () => {
    const s = firstStreamSpec({ name: 'Ledgerly', tagline: 'Books that close themselves' }, '');
    expect(s.problem).toContain('Books that close themselves');
    expect(s.problem.length).toBeGreaterThan(20);
  });
});

describe('seedFirstStream', () => {
  it('does nothing before the owner has an idea', () => {
    expect(seedFirstStream(vault)).toBeNull();
    expect(listStreams(vault)).toEqual([]);
  });

  it('creates exactly one stream from the idea, owned by the dev room', () => {
    idea('Ledgerly', 'Books that close themselves', 'Small agencies waste two days a month reconciling invoices by hand.');
    const slug = seedFirstStream(vault)!;
    expect(slug).toBe('ledgerly');
    const s = readStream(vault, slug)!;
    expect(s.data.owner_team).toBe('dev');
    expect(s.data.repo_path).toBe('Workspace/ledgerly');
    expect(s.data.problem).toContain('reconciling invoices');
  });

  it('is once-only: a second call with a stream already there adds nothing', () => {
    idea('Ledgerly', 't', 'the problem sentence');
    seedFirstStream(vault);
    expect(seedFirstStream(vault)).toBeNull();
    expect(listStreams(vault)).toHaveLength(1);
  });

  it('the three first-run jobs point at the stream', () => {
    idea('Ledgerly', 't', 'the problem sentence');
    const slug = seedFirstStream(vault)!;
    const ids = seedFirstJobs(vault, loadOrg(vault));
    expect(ids.length).toBeGreaterThan(0);
    const jobs = listJobs(vault).filter((j) => ids.includes(j.id));
    expect(jobs.every((j) => j.stream === slug)).toBe(true);
    const ship = jobs.find((j) => j.type === 'engineer.ship')!;
    expect(ship.risk).toBe('low');
  });
});

describe('the company plan names streams', () => {
  it('the CEO is told to attach a stream to every objective', async () => {
    const { HEARTBEAT_STEPS } = await import('../src/heartbeat.js');
    expect(HEARTBEAT_STEPS).toContain('company_plan');
    const src = (await import('node:fs')).readFileSync(path.resolve(__dirname, '../src/heartbeat.ts'), 'utf8');
    expect(src).toMatch(/stream: <slug>/);
    expect(src).toMatch(/Streams\//);
  });
});
