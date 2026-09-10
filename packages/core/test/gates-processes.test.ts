import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { parseGates, loadGates, gatesFor, criteriaFor, gateAssignee } from '../src/gates.js';
import { readProcess, expandProcess, MAX_PROCESS_STEPS } from '../src/processes.js';
import { readJob } from '../src/jobs.js';

let dir: string; let vault: Vault;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-gates-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('gates (spec §3)', () => {
  it('parses the table, falls back to custom, and names the assignee per gate', () => {
    const t = parseGates('gates:\n  engineer.ship: [qa.review, coo.verify]\n  custom: [coo.verify]\ncriteria:\n  engineer.ship: "ok"\n');
    expect(gatesFor(t, 'engineer.ship')).toEqual(['qa.review', 'coo.verify']);
    expect(gatesFor(t, 'made.up')).toEqual(['coo.verify']);
    expect(criteriaFor(t, 'engineer.ship')).toBe('ok');
    expect(gateAssignee('qa.review', {})).toBe('qa'); expect(gateAssignee('coo.verify', {})).toBe('coo');
    expect(gateAssignee('requester.review', { for: 'cto' })).toBe('cto'); expect(gateAssignee('requester.review', { owner_role: 'cfo' })).toBe('cfo');
    expect(gatesFor(loadGates(), 'research')).toEqual(['requester.review']);
  });
  it('requester.review and ceo.heartbeat have explicit (empty) gate entries in config/gates.yaml, not the custom fallback (F7)', () => {
    const t = loadGates();
    expect(gatesFor(t, 'requester.review')).toEqual([]);
    expect(gatesFor(t, 'ceo.heartbeat')).toEqual([]);
  });
});

describe('processes (spec §3)', () => {
  it('reads a process and expands it into a depends_on chain with titles filled in', () => {
    const p = readProcess(vault, 'feature')!;
    expect(p.steps.length).toBeGreaterThanOrEqual(3); expect(p.steps.length).toBeLessThanOrEqual(MAX_PROCESS_STEPS);
    const ids = expandProcess(vault, 'feature', 'pricing page', { parent: 'job_hb', by: 'ceo', owner_role: 'ceo' });
    expect(ids).toHaveLength(p.steps.length);
    const jobs = ids.map((id) => readJob(vault, id)!.data);
    expect(jobs[0].depends_on).toEqual([]); expect(jobs[1].depends_on).toEqual([ids[0]]); expect(jobs[2].depends_on).toEqual([ids[1]]);
    expect(jobs[0].title).toBe('Research: pricing page'); expect(jobs[0].for).toBe('cto'); expect(jobs[0].parent).toBe('job_hb');
    expect(jobs.every((j) => j.owner_role === 'ceo')).toBe(true);
    expect(readProcess(vault, 'nope')).toBeNull();
    expect(() => expandProcess(vault, 'nope', 'x', { parent: 'p', by: 'ceo', owner_role: 'ceo' })).toThrow(/unknown process/);
  });
  it('refuses to expand a process step naming an unknown or inactive role (F1)', () => {
    vault.writeText('Processes/broken.md', '---\nname: broken\nsteps:\n  - { role: nope, type: custom, title: "X" }\n---\nbroken process\n', 'daemon');
    expect(() => expandProcess(vault, 'broken', 'x', { parent: 'p', by: 'ceo', owner_role: 'ceo' })).toThrow(/unknown or inactive role nope in process broken/);
  });
  it('a process omitting `parent` threads its idempotency marker through `links` only (F9)', () => {
    const ids = expandProcess(vault, 'opportunity', 'a new idea', { by: 'ceo', owner_role: 'ceo', marker: 'weekly-7' });
    for (const id of ids) {
      const j = readJob(vault, id)!.data;
      expect(j.parent).toBeUndefined();
      expect(j.links).toContain('[[weekly-7]]');
    }
  });
});
