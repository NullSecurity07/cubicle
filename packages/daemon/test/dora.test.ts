import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, updateJob, createStream } from '@cubicle/core';
import { computeDora, renderEngineering, writeEngineeringMetrics } from '../src/evolution.js';

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-dora-')); vault = (await scaffoldVault(dir)).vault;
  createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev', error_budget: 4 }, 'product_manager');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const at = (h: number) => new Date(Date.parse('2026-09-14T12:00:00.000Z') - h * 3600_000).toISOString();
const SINCE = at(24 * 7);
const UNTIL = at(0);

/** A ship queued `queuedAgo` hours ago and deployed live `deployedAgo` hours ago. */
function shipped(queuedAgo: number, deployedAgo: number, rolledBack = false): string {
  const id = createJob(vault, { type: 'engineer.ship', title: `Ship ${queuedAgo}`, assigned: 'backend_engineer', goal: 'g', team: 'dev', stream: 'checkout', risk: 'low' }, 'dev_manager');
  // createJob emitted job.queued at "now"; restate it at the fixture time.
  vault.db.prepare('DELETE FROM events WHERE type = ? AND job = ?').run('job.queued', id);
  vault.events.emit({ type: 'job.queued', agent: 'dev_manager', job: id, payload: { type: 'engineer.ship' }, ts: at(queuedAgo) });
  vault.events.emit({ type: 'deploy.done', agent: 'backend_engineer', job: id, payload: { project: 'acme', stage: 'live', rolled_back: rolledBack, stream: 'checkout' }, ts: at(deployedAgo) });
  updateJob(vault, id, { status: 'done' }, 'daemon');
  return id;
}

function incident(openedAgo: number, hours: number): void {
  const id = createJob(vault, { type: 'incident', title: 'Outage', assigned: 'sre', goal: 'g', team: 'dev', stream: 'checkout', risk: 'high' }, 'daemon');
  vault.events.emit({ type: 'incident.opened', agent: 'daemon', job: id, payload: { stream: 'checkout' }, ts: at(openedAgo) });
  vault.events.emit({ type: 'incident.recovered', agent: 'sre', job: id, payload: { stream: 'checkout', hours }, ts: at(openedAgo - hours) });
}

describe('computeDora (operating model §31)', () => {
  it('lead time is the median job.queued → deploy.done, in hours', () => {
    shipped(30, 26);   // 4 h
    shipped(50, 40);   // 10 h
    shipped(20, 14);   // 6 h
    expect(computeDora(vault, SINCE, UNTIL).lead_time_h).toBeCloseTo(6, 5);
  });

  it('deployment frequency counts live deploys over the window, normalised to a week', () => {
    shipped(30, 26); shipped(50, 40);
    const d = computeDora(vault, SINCE, UNTIL);
    expect(d.deploys).toBe(2);
    expect(d.window_days).toBeCloseTo(7, 1);
    expect(d.deploys_per_week).toBeCloseTo(2, 1);
  });

  it('change failure rate counts rollbacks and returned ships against deploys', () => {
    shipped(30, 26);
    shipped(50, 40, true);           // rolled back
    const id = createJob(vault, { type: 'engineer.ship', title: 'Returned', assigned: 'backend_engineer', goal: 'g', team: 'dev', stream: 'checkout', risk: 'low' }, 'dev_manager');
    vault.events.emit({ type: 'review.returned', agent: 'qa_lead', job: id, payload: { gate: 'team:qa.review', findings: ['x'] }, ts: at(20) });
    const d = computeDora(vault, SINCE, UNTIL);
    expect(d.deploys).toBe(2);
    expect(d.failures).toBe(2);
    expect(d.change_failure_rate).toBeCloseTo(1, 5);
  });

  it('time to restore is the median incident open → recovered', () => {
    incident(40, 2); incident(30, 4); incident(20, 3);
    expect(computeDora(vault, SINCE, UNTIL).time_to_restore_h).toBeCloseTo(3, 1);
  });

  it('an empty window reports null rather than a made-up zero', () => {
    const d = computeDora(vault, SINCE, UNTIL);
    expect(d.lead_time_h).toBeNull();
    expect(d.change_failure_rate).toBeNull();
    expect(d.time_to_restore_h).toBeNull();
    expect(d.deploys_per_week).toBe(0);
  });
});

describe('Metrics/engineering.md', () => {
  it('renders the four with their definitions and the metrics §31 forbids', () => {
    const d = computeDora(vault, SINCE, UNTIL);
    const md = renderEngineering(d, UNTIL, ['checkout: 0.0 h of 4 h error budget used']);
    expect(md).toMatch(/Lead time/);
    expect(md).toMatch(/Deployment frequency/);
    expect(md).toMatch(/Change failure rate/);
    expect(md).toMatch(/Time to restore/);
    expect(md).toMatch(/lines of code/i);
    expect(md).toMatch(/tickets closed/i);
    expect(md).toMatch(/checkout: 0\.0 h of 4 h/);
    expect(md).toMatch(/not enough data/i);
  });

  it('writeEngineeringMetrics writes the sheet as a generated file', () => {
    shipped(30, 26);
    const d = writeEngineeringMetrics(vault, new Date(UNTIL));
    expect(d.deploys).toBe(1);
    expect(vault.readText('Metrics/engineering.md')).toMatch(/Deployment frequency/);
    const wrote = vault.events.query({ types: ['vault.wrote'] }).filter((e) => e.payload.path === 'Metrics/engineering.md');
    expect(wrote.at(-1)!.payload.generated).toBe(true);
  });

  it('the shipped template is already a readable sheet, not an empty file', () => {
    const tpl = vault.readText('Metrics/engineering.md');
    expect(tpl).toMatch(/Lead time/);
    expect(tpl).toMatch(/§31/);
  });
});
