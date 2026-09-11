import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createJob, readJob, updateJob, createProposal, findInboxById, createStream,
  writeCiRecord, ciConfigPath, JobResult, loadGates, gatesForRisk, type JobFrontmatter,
} from '@cubicle/core';
import { shipRefusal, approvedThreatModel } from '../src/loop.js';

const root = path.resolve(__dirname, '../../..');
const gates = loadGates(path.join(root, 'config/gates.yaml'));
let dir: string; let vault: Vault;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-shipgate-')); vault = (await scaffoldVault(dir)).vault;
  createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: '72 % to 82 %', owner_team: 'dev' }, 'product_manager');
  vault.writeText(ciConfigPath('checkout'), 'steps:\n  - { name: test, run: "true" }\n', 'daemon');
  vault.writeText('Workspace/checkout/src/app.js', 'export const v = 1;\n', 'backend_engineer');
  const early = new Date('2026-09-11T09:00:00.000Z');
  utimesSync(path.join(dir, 'Workspace/checkout/src/app.js'), early, early);
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function ship(over: Partial<JobFrontmatter> = {}): JobFrontmatter {
  const id = createJob(vault, { type: 'engineer.ship', title: 'Card form', assigned: 'backend_engineer', goal: 'g', team: 'dev', stream: 'checkout', risk: over.risk ?? 'low' }, 'dev_manager');
  if (Object.keys(over).length) updateJob(vault, id, over, 'daemon');
  return readJob(vault, id)!.data;
}

function green(): void {
  writeCiRecord(vault, 'checkout', { stream: 'checkout', started: '2026-09-11T09:59:00.000Z', finished: '2026-09-11T10:00:00.000Z', green: true, commit: null, steps: [{ name: 'test', code: 0, ok: true, duration_ms: 5, output: 'ok' }] }, 'backend_engineer');
}

const done = JobResult.parse({ status: 'done', summary: 'shipped' });

describe('shipRefusal — the CI gate (operating model §17)', () => {
  it('refuses a ship with no CI record and names ci.run', () => {
    const r = shipRefusal(vault, ship(), done);
    expect(r).toMatch(/ci\.run/);
    expect(r).toMatch(/checkout/);
  });

  it('accepts a ship with a green record newer than the source', () => {
    green();
    expect(shipRefusal(vault, ship(), done)).toBeNull();
  });

  it('refuses again once a source file is touched after the green run', () => {
    green();
    const later = new Date('2026-09-11T11:00:00.000Z');
    utimesSync(path.join(dir, 'Workspace/checkout/src/app.js'), later, later);
    expect(shipRefusal(vault, ship(), done)).toMatch(/app\.js/);
  });

  it('a ship with no stream is told to name one rather than skipping the gate', () => {
    const j = ship();
    const noStream = { ...j, stream: undefined };
    expect(shipRefusal(vault, noStream, done)).toMatch(/stream/i);
  });

  it('only applies to a successful ship — a failed or blocked one may always finish', () => {
    expect(shipRefusal(vault, ship(), JobResult.parse({ status: 'failed', summary: 'could not build' }))).toBeNull();
    expect(shipRefusal(vault, ship(), JobResult.parse({ status: 'blocked', summary: 'need a key' }))).toBeNull();
  });

  it('only applies to engineering job types', () => {
    const id = createJob(vault, { type: 'custom', title: 'Write the pack', assigned: 'coo', goal: 'g' }, 'ceo');
    expect(shipRefusal(vault, readJob(vault, id)!.data, done)).toBeNull();
  });
});

describe('shipRefusal — the high-risk threat model (§27)', () => {
  it('a high-risk ship with green CI is still refused until the owner approves a threat model', () => {
    green();
    const j = ship({ risk: 'high' });
    const r = shipRefusal(vault, j, done);
    expect(r).toMatch(/threat_model/);
    expect(r).toMatch(/proposal\.create/);
    expect(approvedThreatModel(vault, j.id)).toBe(false);
  });

  it('an approved threat model for this job clears it', () => {
    green();
    const j = ship({ risk: 'high' });
    const { id } = createProposal(vault, { kind: 'threat_model', from: 'backend_engineer', title: 'Threat model: session keys', body: 'Assets, entry points, what an attacker would try, what stops them.', job: j.id }, 'backend_engineer');
    vault.updateNote(findInboxById(vault, id)!.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
    expect(approvedThreatModel(vault, j.id)).toBe(true);
    expect(shipRefusal(vault, j, done)).toBeNull();
  });

  it('a threat model approved for a different job does not count', () => {
    green();
    const other = ship({ risk: 'high' });
    const mine = ship({ risk: 'high' });
    const { id } = createProposal(vault, { kind: 'threat_model', from: 'backend_engineer', title: 'Threat model', body: 'b', job: other.id }, 'backend_engineer');
    vault.updateNote(findInboxById(vault, id)!.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
    expect(approvedThreatModel(vault, mine.id)).toBe(false);
  });

  it('medium risk needs no threat model — the security gate is the control there', () => {
    green();
    expect(shipRefusal(vault, ship({ risk: 'medium' }), done)).toBeNull();
    expect(gatesForRisk(gates, 'engineer.ship', 'medium')).toEqual(['security.review', 'qa.review', 'coo.verify']);
  });
});
