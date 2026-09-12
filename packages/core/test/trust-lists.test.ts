import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import type { Vault } from '../src/vault.js';
import { loadOrg } from '../src/org.js';
import { loadGates, gatesFor, gatesForRisk, criteriaFor, gateAssignee } from '../src/gates.js';
import { KNOWN_JOB_TYPES, JobFrontmatter } from '../src/schemas.js';
import { createJob, readJob, listJobs, GATE_JOB_TYPES, stageOf } from '../src/jobs.js';

const GATES_YAML = path.resolve(__dirname, '../../../config/gates.yaml');
const table = loadGates(GATES_YAML);

let dir: string; let vault: Vault;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sp5-lists-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('the two job types SP5 adds (spec §5, §6)', () => {
  it('are known, and every list that already knew office:security.review knows the compliance gate too', () => {
    expect(KNOWN_JOB_TYPES).toContain('office:compliance.review');
    expect(KNOWN_JOB_TYPES).toContain('pantry.chat');
    // A gate job is the reviewer's work, not the author team's: exempt from WIP, and out of the heartbeat's work count.
    expect(GATE_JOB_TYPES).toContain('office:compliance.review');
    expect(GATE_JOB_TYPES).toContain('office:security.review');
    // Nothing was removed to make room.
    for (const t of ['engineer.ship', 'finance.runway', 'discovery', 'qa.review']) expect(KNOWN_JOB_TYPES).toContain(t);
  });

  it('a compliance review parks its subject in the review lane, like the security one', () => {
    expect(stageOf({ status: 'in_review', gate_index: 0, depends_on: [] }, ['office:compliance.review'])).toBe('review');
  });

  it('neither type inherits `custom`\'s chain, so a finished one is done rather than in_review', () => {
    expect(gatesFor(table, 'office:compliance.review')).toEqual([]);
    expect(gatesFor(table, 'pantry.chat')).toEqual([]);
    expect(gatesForRisk(table, 'pantry.chat', 'low')).toEqual([]);
    // `custom` is what an unlisted type would have inherited.
    expect(gatesFor(table, 'custom')).not.toEqual([]);
  });

  it('the compliance gate carries the five questions that make an outbound action defensible', () => {
    const c = criteriaFor(table, 'office:compliance.review');
    expect(c).toMatch(/true/i);
    expect(c).toMatch(/agreed|consent/i);
    expect(c).toMatch(/banned/i);
    expect(c).toMatch(/unsubscribe|refund|rollback/i);
    expect(c).toMatch(/public/i);
    expect(c).toMatch(/pass or return/i);
  });

  it('it resolves through the compliance office, so re-staffing the seat moves the gate', () => {
    const org = loadOrg(vault);
    expect(gateAssignee('office:compliance.review', {}, org)).toBe(org.offices?.compliance ?? 'clo');
    expect(gateAssignee('office:compliance.review', {}, { ...org, offices: { ...org.offices, compliance: 'coo' } })).toBe('coo');
    // With no org at all it still lands on the office's default seat, never on a role called "compliance".
    expect(gateAssignee('office:compliance.review', {})).toBe('clo');
  });

  it('gates.yaml lists both, so gen-docs stays complete', () => {
    const raw = readFileSync(GATES_YAML, 'utf8');
    expect(raw).toMatch(/^\s+office:compliance\.review:/m);
    expect(raw).toMatch(/^\s+pantry\.chat:/m);
  });
});

describe('the three job fields SP5 adds (spec §3, §6)', () => {
  it('validate as optional strings and survive a round trip through createJob', () => {
    expect(JobFrontmatter.parse({ id: 'job_x', type: 'custom', title: 't', assigned: 'cmo', created: '', updated: '' }).trust_key).toBeUndefined();
    const review = createJob(vault, {
      id: 'job_trust_1', type: 'office:compliance.review', title: 'Compliance review: email.send', assigned: 'clo',
      goal: 'g', trust_key: 'job_1:1:3', trust_proposal: 'prop_1',
    }, 'daemon');
    const r = readJob(vault, review)!.data;
    expect(r.trust_key).toBe('job_1:1:3');
    expect(r.trust_proposal).toBe('prop_1');
    expect(r.pantry_with).toBeUndefined();
    const chat = createJob(vault, { id: 'job_pantry_1', type: 'pantry.chat', title: 'Pantry: CLO and CMO', assigned: 'clo', goal: 'g', pantry_with: 'cmo' }, 'daemon');
    expect(readJob(vault, chat)!.data.pantry_with).toBe('cmo');
    // Still readable by `listJobs`, which is what would have broken had the schema rejected them.
    expect(listJobs(vault).map((j) => j.id)).toContain('job_trust_1');
  });
});
