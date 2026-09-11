import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, updateJob, parseNote, stringifyNote, listJobs, wipLoad, loadGates, gatesForRisk, type JobFrontmatter } from '@cubicle/core';
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

  it('a running gate job does not inflate its parent\'s team WIP: the parent already occupies the lane (fix round 1)', () => {
    setWip('dev', { in_progress: 1, review: 2, testing: 2 });
    const a = devJob('A');
    updateJob(vault, a, { status: 'in_review', gate_index: 0 }, 'daemon'); // testing: qa.review outstanding, not in_progress
    const gateJob = createJob(vault, { type: 'qa.review', title: 'Review A', assigned: 'qa_automation', goal: 'g', team: 'dev', parent: a }, 'daemon');
    updateJob(vault, gateJob, { status: 'running' }, 'daemon'); // would read as in_progress if not excluded
    const b = devJob('B');
    // dev's in_progress limit is 1, but the only "in_progress"-shaped job is the gate job (excluded); dev has 0 real in_progress jobs.
    expect(pool.nextJob('backend_engineer')).toBe(b);
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'wip')).toBe(false);
  });

  it('a team whose note never sets wip: is never refused, however much work is running (fix round 1)', () => {
    // Teams/technology.md ships with no `wip:` at all.
    const techJob = (title: string) => createJob(vault, { type: 'custom', title, assigned: 'cto', goal: 'g', team: 'technology' }, 'ceo');
    const a = techJob('A'); const b = techJob('B'); const c = techJob('C'); const d = techJob('D');
    for (const id of [a, b, c]) updateJob(vault, id, { status: 'running' }, 'daemon');
    expect(pool.nextJob('cto')).toBe(d);
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'wip' && e.payload.team === 'technology')).toBe(false);
  });

  it('clears the warned team once its load drops under the limit, so the next full episode warns again promptly', () => {
    setWip('dev', { in_progress: 1, review: 2, testing: 2 });
    const a = devJob('A');
    updateJob(vault, a, { status: 'running' }, 'daemon');
    const b = devJob('B');
    expect(pool.nextJob('backend_engineer')).toBeNull(); // warns once, dev is full
    expect(vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'wip')).toHaveLength(1);

    updateJob(vault, a, { status: 'done' }, 'daemon'); // dev drops under the limit
    expect(pool.nextJob('backend_engineer')).toBe(b);

    updateJob(vault, b, { status: 'running' }, 'daemon'); // dev fills up again, immediately
    const c = devJob('C');
    pool.nextJob('backend_engineer'); // should warn again despite being well inside WIP_WARN_MS of the first warning
    expect(vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'wip')).toHaveLength(2);
    void c;
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

  it('a team with no wip: field reports null limits, never a fabricated default (fix round 1)', () => {
    const tech = buildSnapshot(vault).teams.find((t) => t.id === 'technology')!;
    expect(tech.wip.limits).toBeNull();
    expect(tech.wip.load).toEqual({ in_progress: 0, review: 0, testing: 0 });
  });
});

describe('a gate job is exempt from the author team\'s WIP limit (fix wave item 5 / I1)', () => {
  /** `enqueueGate` gives the gate job the *author's* team, which is why this matters at all. */
  const gate = (type: string, title: string, assigned: string, parent: string) =>
    createJob(vault, { type, title, assigned, goal: 'g', team: 'dev', parent }, 'daemon');

  it('a qa.review carrying team: dev dispatches while Dev is at its in_progress limit', () => {
    setWip('dev', { in_progress: 1, review: 2, testing: 2 });
    const a = devJob('A');
    updateJob(vault, a, { status: 'running' }, 'daemon');   // Dev is full
    expect(pool.nextJob('backend_engineer')).toBeNull();
    const review = gate('qa.review', 'Review A', 'qa_lead', a);
    expect(pool.nextJob('qa_lead')).toBe(review);
  });

  it('security.review dispatches even though Teams/security.md has no members', () => {
    setWip('dev', { in_progress: 1, review: 2, testing: 2 });
    const a = devJob('A');
    updateJob(vault, a, { status: 'running' }, 'daemon');
    const sec = gate('security.review', 'Security review of A', 'ciso', a);
    expect(pool.nextJob('ciso')).toBe(sec);
  });

  it('every gate type is exempt, and no WIP warning is emitted for one', () => {
    setWip('dev', { in_progress: 1, review: 2, testing: 2 });
    const a = devJob('A');
    updateJob(vault, a, { status: 'running' }, 'daemon');
    const ids = [
      gate('qa.review', 'QA A', 'qa_lead', a),
      gate('security.review', 'Sec A', 'ciso', a),
      gate('requester.review', 'Requester A', 'product_manager', a),
      gate('research.review', 'Research A', 'research_manager', a),
      gate('coo.verify', 'Verify A', 'coo', a),
    ];
    const roles = ['qa_lead', 'ciso', 'product_manager', 'research_manager', 'coo'];
    roles.forEach((r, i) => expect(pool.nextJob(r), r).toBe(ids[i]));
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'wip')).toBe(false);
  });

  it('the exemption does not leak to ordinary Dev work, which is still refused', () => {
    setWip('dev', { in_progress: 1, review: 2, testing: 2 });
    const a = devJob('A');
    updateJob(vault, a, { status: 'running' }, 'daemon');
    gate('qa.review', 'Review A', 'qa_lead', a);
    devJob('B');
    expect(pool.nextJob('backend_engineer')).toBeNull();
  });

  it('a gate job still waits for its dependencies', () => {
    const a = devJob('A');
    const blocker = devJob('Blocker');
    const review = createJob(vault, { type: 'qa.review', title: 'Review A', assigned: 'qa_lead', goal: 'g', team: 'dev', parent: a, depends_on: [blocker] }, 'daemon');
    expect(pool.nextJob('qa_lead')).toBeNull();
    updateJob(vault, blocker, { status: 'done' }, 'daemon');
    expect(pool.nextJob('qa_lead')).toBe(review);
  });
});

describe('wipLoad does not re-list every job note per call (fix wave item 6 / I6)', () => {
  /** `listJobs` starts with exactly one `vault.list('Jobs', …)`, so counting those counts full vault scans. */
  function countJobScans<T>(fn: () => T): { result: T; scans: number } {
    const realList = vault.list.bind(vault);
    let scans = 0;
    const spy = vi.spyOn(vault, 'list').mockImplementation((dirRel: string, opts?: Parameters<Vault['list']>[1]) => {
      if (String(dirRel) === 'Jobs') scans++;
      return realList(dirRel, opts);
    });
    try { return { result: fn(), scans }; } finally { spy.mockRestore(); }
  }

  it('a snapshot over every team lists the jobs once', () => {
    setWip('dev', { in_progress: 3, review: 2, testing: 2 });
    devJob('A'); devJob('B');
    const { result, scans } = countJobScans(() => buildSnapshot(vault));
    expect(result.teams.length).toBeGreaterThanOrEqual(8);
    expect(scans).toBe(1);
  });

  it('nextJob lists the jobs once however many teams it weighs', () => {
    setWip('dev', { in_progress: 1, review: 2, testing: 2 });
    updateJob(vault, devJob('A'), { status: 'running' }, 'daemon');
    devJob('B');
    const { scans } = countJobScans(() => pool.nextJob('backend_engineer'));
    expect(scans).toBe(1);
  });

  it('the passed-in list gives the same answer as listing it again', () => {
    setWip('dev', { in_progress: 3, review: 2, testing: 2 });
    updateJob(vault, devJob('A'), { status: 'running' }, 'daemon');
    updateJob(vault, devJob('B'), { status: 'in_review', gate_index: 0 }, 'daemon');
    const gates = loadGates();
    const chainFor = (j: JobFrontmatter) => gatesForRisk(gates, j.type, j.risk);
    expect(wipLoad(vault, 'dev', chainFor, listJobs(vault))).toEqual(wipLoad(vault, 'dev', chainFor));
  });
});
