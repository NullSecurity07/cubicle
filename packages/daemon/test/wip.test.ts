import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, updateJob, parseNote, stringifyNote } from '@cubicle/core';
import { WorkerPool, WIP_WARN_MS } from '../src/workers.js';
import { buildSnapshot } from '../src/ws.js';

let dir: string; let vault: Vault; let pool: WorkerPool;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-wip-')); vault = (await scaffoldVault(dir)).vault;
  pool = new WorkerPool(vault, { harness: {} as never, heartbeat: {} as never, maxConcurrent: 8 });
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function devJob(title: string, assigned = 'backend_engineer'): string {
  return createJob(vault, { type: 'engineer.ship', title, assigned, goal: 'g', team: 'dev', stream: 'checkout', risk: 'low' }, 'dev_manager');
}

function setWip(team: string, wip: Record<string, number>): void {
  const rel = `Teams/${team}.md`;
  const n = parseNote(vault.readText(rel));
  vault.writeText(rel, stringifyNote({ ...n.data, wip }, n.body), 'daemon');
}

describe('nextJob respects the team WIP limit (operating model §7)', () => {
  it('hands out work up to the limit and then stops', () => {
    setWip('dev', { in_progress: 2, review: 2, testing: 2 });
    const a = devJob('A'); const b = devJob('B'); const c = devJob('C');
    updateJob(vault, a, { status: 'running' }, 'daemon');
    updateJob(vault, b, { status: 'running' }, 'daemon');
    expect(pool.nextJob('backend_engineer')).toBeNull();
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'wip')).toBe(true);

    updateJob(vault, a, { status: 'done' }, 'daemon');
    expect(pool.nextJob('backend_engineer')).toBe(c);
  });

  it('the warning names the team, the limit and the load so the brief can explain the pause', () => {
    setWip('dev', { in_progress: 1, review: 2, testing: 2 });
    updateJob(vault, devJob('A'), { status: 'running' }, 'daemon');
    devJob('B');
    pool.nextJob('backend_engineer');
    const w = vault.events.query({ types: ['daemon.warning'] }).find((e) => e.payload.where === 'wip')!;
    expect(w.payload).toMatchObject({ team: 'dev', stage: 'in_progress', limit: 1 });
    expect((w.payload.load as Record<string, number>).in_progress).toBe(1);
  });

  it('warns at most once per team per window, however often the worker loops', () => {
    setWip('dev', { in_progress: 1, review: 2, testing: 2 });
    updateJob(vault, devJob('A'), { status: 'running' }, 'daemon');
    devJob('B');
    for (let i = 0; i < 5; i++) pool.nextJob('backend_engineer');
    expect(vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'wip')).toHaveLength(1);
    expect(WIP_WARN_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('another team is unaffected, and a job with no team is never blocked', () => {
    setWip('dev', { in_progress: 1, review: 2, testing: 2 });
    updateJob(vault, devJob('A'), { status: 'running' }, 'daemon');
    const q = createJob(vault, { type: 'qa.review', title: 'Review A', assigned: 'qa_lead', goal: 'g', team: 'qa' }, 'daemon');
    expect(pool.nextJob('qa_lead')).toBe(q);
    const loose = createJob(vault, { type: 'custom', title: 'Loose', assigned: 'coo', goal: 'g' }, 'ceo');
    expect(pool.nextJob('coo')).toBe(loose);
  });

  it('the review and testing lanes do not stop new work — only in_progress does', () => {
    setWip('dev', { in_progress: 3, review: 1, testing: 1 });
    updateJob(vault, devJob('A'), { status: 'in_review', gate_index: 0 }, 'daemon');   // testing
    const b = devJob('B');
    expect(pool.nextJob('backend_engineer')).toBe(b);
  });
});

describe('the snapshot carries the lane load', () => {
  it('every team reports its limits and its current load', () => {
    setWip('dev', { in_progress: 3, review: 2, testing: 2 });
    updateJob(vault, devJob('A'), { status: 'running' }, 'daemon');
    updateJob(vault, devJob('B'), { status: 'in_review', gate_index: 0 }, 'daemon');
    const dev = buildSnapshot(vault).teams.find((t) => t.id === 'dev')!;
    expect(dev.wip.limits).toEqual({ in_progress: 3, review: 2, testing: 2 });
    expect(dev.wip.load).toEqual({ in_progress: 1, review: 0, testing: 1 });
    const qa = buildSnapshot(vault).teams.find((t) => t.id === 'qa')!;
    expect(qa.wip.load).toEqual({ in_progress: 0, review: 0, testing: 0 });
  });
});
