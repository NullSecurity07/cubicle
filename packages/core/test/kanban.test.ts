import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { TeamFrontmatter } from '../src/schemas.js';
import { createJob, updateJob, stageOf, stageMap, wipLoad, KANBAN_STAGES, WIP_STAGES, GATE_JOB_TYPES } from '../src/jobs.js';
import { loadOrg } from '../src/org.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-kanban-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const SHIP = ['team:qa.review', 'office:operations.verify'];
const job = (over: Partial<{ status: string; gate_index: number; depends_on: string[] }>) =>
  ({ status: 'queued', gate_index: 0, depends_on: [], ...over } as Parameters<typeof stageOf>[0]);

describe('stageOf (owner operating model §7)', () => {
  it('maps the seven lanes from status, dependencies and the outstanding gate', () => {
    expect(stageOf(job({ status: 'queued' }), SHIP, false)).toBe('backlog');
    expect(stageOf(job({ status: 'queued' }), SHIP, true)).toBe('ready');
    expect(stageOf(job({ status: 'running' }), SHIP)).toBe('in_progress');
    expect(stageOf(job({ status: 'blocked' }), SHIP)).toBe('in_progress');
    expect(stageOf(job({ status: 'in_review', gate_index: 0 }), SHIP)).toBe('testing');        // team:qa.review outstanding
    expect(stageOf(job({ status: 'in_review', gate_index: 1 }), SHIP)).toBe('ready_for_release'); // office:operations.verify outstanding
    expect(stageOf(job({ status: 'in_review', gate_index: 0 }), ['office:security.review', ...SHIP])).toBe('review');
    expect(stageOf(job({ status: 'done' }), SHIP)).toBe('done');
    expect(stageOf(job({ status: 'failed' }), SHIP)).toBe('done');       // off the board
    expect(stageOf(job({ status: 'cancelled' }), SHIP)).toBe('done');
    expect(KANBAN_STAGES).toEqual(['backlog', 'ready', 'in_progress', 'review', 'testing', 'ready_for_release', 'done']);
    expect(WIP_STAGES).toEqual(['in_progress', 'review', 'testing']);
  });

  it('an in_review job past the end of its chain reads as review, never undefined', () => {
    expect(stageOf(job({ status: 'in_review', gate_index: 9 }), SHIP)).toBe('review');
  });
});

describe('stageMap and wipLoad', () => {
  it('counts only the named team and only the three limited lanes', () => {
    const chainFor = () => SHIP;
    const a = createJob(vault, { type: 'engineer.ship', title: 'A', assigned: 'backend_engineer', goal: 'g', team: 'dev' }, 'dev_manager');
    const b = createJob(vault, { type: 'engineer.ship', title: 'B', assigned: 'frontend_engineer', goal: 'g', team: 'dev' }, 'dev_manager');
    const c = createJob(vault, { type: 'engineer.ship', title: 'C', assigned: 'qa_automation', goal: 'g', team: 'qa' }, 'qa_lead');
    updateJob(vault, a, { status: 'running' }, 'daemon');
    updateJob(vault, b, { status: 'in_review', gate_index: 0 }, 'daemon');
    updateJob(vault, c, { status: 'running' }, 'daemon');

    const stages = stageMap(vault, chainFor);
    expect(stages.get(a)).toBe('in_progress');
    expect(stages.get(b)).toBe('testing');

    expect(wipLoad(vault, 'dev', chainFor)).toEqual({ in_progress: 1, review: 0, testing: 1 });
    expect(wipLoad(vault, 'qa', chainFor)).toEqual({ in_progress: 1, review: 0, testing: 0 });
  });

  it('a running gate job does not inflate its parent\'s team WIP on top of the parent (fix round 1)', () => {
    const chainFor = () => SHIP;
    const parent = createJob(vault, { type: 'engineer.ship', title: 'A', assigned: 'backend_engineer', goal: 'g', team: 'dev' }, 'dev_manager');
    updateJob(vault, parent, { status: 'in_review', gate_index: 0 }, 'daemon'); // testing: team:qa.review outstanding
    // The gate job itself: type team:qa.review, inherits the parent's team, and is running (someone is doing the review).
    const gateJob = createJob(vault, { type: 'team:qa.review', title: 'Review A', assigned: 'qa_automation', goal: 'g', team: 'dev', parent }, 'daemon');
    updateJob(vault, gateJob, { status: 'running' }, 'daemon');

    expect(GATE_JOB_TYPES).toContain('team:qa.review');
    expect(GATE_JOB_TYPES).toContain('qa.review');   // and the pre-office name, so an old gate job stays exempt
    // The parent counts once, in testing; the running gate job (also team: dev) must not add a second in_progress.
    expect(wipLoad(vault, 'dev', chainFor)).toEqual({ in_progress: 0, review: 0, testing: 1 });
  });

  it('an unmet dependency keeps a queued job in backlog, not ready', () => {
    const first = createJob(vault, { type: 'custom', title: 'First', assigned: 'backend_engineer', goal: 'g', team: 'dev' }, 'dev_manager');
    const second = createJob(vault, { type: 'custom', title: 'Second', assigned: 'backend_engineer', goal: 'g', team: 'dev', depends_on: [first] }, 'dev_manager');
    expect(stageMap(vault, () => [])?.get(second)).toBe('backlog');
    updateJob(vault, first, { status: 'done' }, 'daemon');
    expect(stageMap(vault, () => [])?.get(second)).toBe('ready');
  });
});

describe('Teams/<id>.md wip limits', () => {
  it('is undefined (unlimited) with no wip: on the note, and is read off the shipped dev and qa notes when set (fix round 1)', () => {
    expect(TeamFrontmatter.parse({ id: 't', name: 'T', lead: 'ceo' }).wip).toBeUndefined();
    const org = loadOrg(vault);
    expect(org.teams.dev.wip).toEqual({ in_progress: 3, review: 2, testing: 2 });
    expect(org.teams.qa.wip?.testing).toBeGreaterThanOrEqual(1);
    // Most teams ship with no wip: at all (technology, executive, sales, security, research, board, revenue,
    // operations) — they are not on Kanban limits, so the dispatcher must never refuse them for being "full".
    expect(org.teams.technology.wip).toBeUndefined();
  });
});
