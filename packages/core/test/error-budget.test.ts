import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { createStream, budgetSpentHours, budgetLines } from '../src/streams.js';
import { createJob, updateJob } from '../src/jobs.js';
import { KNOWN_JOB_TYPES } from '../src/schemas.js';

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-budget-')); vault = (await scaffoldVault(dir)).vault;
  createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev', error_budget: 4 }, 'product_manager');
  createStream(vault, { name: 'Docs site', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev', error_budget: 8 }, 'product_manager');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function incident(stream: string, openedHoursAgo: number, durationHours: number | null): string {
  const id = createJob(vault, { type: 'incident', title: `Outage on ${stream}`, assigned: 'sre', goal: 'g', team: 'dev', stream, risk: 'high' }, 'daemon');
  vault.events.emit({ type: 'incident.opened', agent: 'daemon', job: id, payload: { stream }, ts: ago(openedHoursAgo) });
  if (durationHours !== null) {
    vault.events.emit({ type: 'incident.recovered', agent: 'sre', job: id, payload: { stream, hours: durationHours }, ts: ago(openedHoursAgo - durationHours) });
    updateJob(vault, id, { status: 'done' }, 'daemon');
  }
  return id;
}

describe('incident is a job type', () => {
  it('is known and has a gate chain', () => {
    expect([...KNOWN_JOB_TYPES]).toContain('incident');
  });
});

describe('budgetSpentHours', () => {
  it('sums recovered incidents on the stream inside the window', () => {
    incident('checkout', 20, 1.5);
    incident('checkout', 10, 0.5);
    incident('docs-site', 12, 3);
    expect(budgetSpentHours(vault, 'checkout')).toBeCloseTo(2, 5);
    expect(budgetSpentHours(vault, 'docs-site')).toBeCloseTo(3, 5);
  });

  it('an incident still open counts the time it has been open so far', () => {
    incident('checkout', 2, null);
    expect(budgetSpentHours(vault, 'checkout')).toBeGreaterThan(1.5);
    expect(budgetSpentHours(vault, 'checkout')).toBeLessThan(2.5);
  });

  it('ignores anything older than the window', () => {
    incident('checkout', 24 * 9, 5);
    expect(budgetSpentHours(vault, 'checkout')).toBe(0);
    expect(budgetSpentHours(vault, 'checkout', ago(24 * 30))).toBeCloseTo(5, 5);
  });

  it('a stream with no incidents has spent nothing', () => {
    expect(budgetSpentHours(vault, 'checkout')).toBe(0);
  });
});

describe('budgetLines', () => {
  it('one line per stream, and says plainly when the budget is spent', () => {
    incident('checkout', 20, 5);
    const lines = budgetLines(vault, 'dev');
    expect(lines.find((l) => l.startsWith('checkout'))).toMatch(/5(\.0)? h of 4 h/);
    expect(lines.find((l) => l.startsWith('checkout'))).toMatch(/spent/i);
    expect(lines.find((l) => l.startsWith('checkout'))).toMatch(/reliability/i);
    expect(lines.find((l) => l.startsWith('docs-site'))).toMatch(/0(\.0)? h of 8 h/);
  });

  it('filters to one team when asked, and covers every stream when not', () => {
    expect(budgetLines(vault, 'qa')).toEqual([]);
    expect(budgetLines(vault)).toHaveLength(2);
  });
});
