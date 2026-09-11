import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, readJob, listJobs } from '@cubicle/core';
import { maybeEnqueueIntelligence, INTELLIGENCE_KINDS, intelligenceGoal, intelligencePath } from '../src/evolution.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-intel-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
const heartbeat = () => vault.events.emit({ type: 'heartbeat.completed', payload: {} });

describe('continuous intelligence (owner model §14–17)', () => {
  it('queues nothing before the first heartbeat', () => {
    expect(maybeEnqueueIntelligence(vault)).toEqual([]);
  });

  it('queues one cheap job per kind after a heartbeat, and exactly once per calendar day', () => {
    heartbeat();
    const ids = maybeEnqueueIntelligence(vault, new Date('2026-09-11T09:00:00.000Z'));
    expect(ids).toHaveLength(4);
    expect(maybeEnqueueIntelligence(vault, new Date('2026-09-11T10:00:00.000Z'))).toEqual([]);   // idempotent within the day

    const jobs = ids.map((id) => readJob(vault, id)!.data);
    expect(jobs.map((j) => j.type)).toEqual(['intelligence', 'intelligence', 'intelligence', 'intelligence']);
    expect(jobs.every((j) => j.assigned === 'intelligence_analyst')).toBe(true);
    expect(jobs.every((j) => j.model_tier === 'cheap')).toBe(true);
    expect(jobs.every((j) => j.team === 'research')).toBe(true);
    expect(jobs.every((j) => j.for === 'research_manager')).toBe(true);
    for (const kind of INTELLIGENCE_KINDS) {
      const j = jobs.find((x) => x.title.toLowerCase().includes(kind))!;
      expect(j.done_when).toContain(`Research/intelligence/2026-09-11-c001-${kind}.md`);
      expect(readJob(vault, j.id)!.body).toContain(`Research/intelligence/2026-09-11-c001-${kind}.md`);
    }

    // A second heartbeat the same day changes nothing: the sweeps are daily, not per cycle.
    heartbeat();
    expect(maybeEnqueueIntelligence(vault, new Date('2026-09-11T20:00:00.000Z'))).toEqual([]);
    // The next day only queues once the open sweeps are out of the way (I5) — a backed-up analyst
    // must not accumulate one queue of sweeps per day.
    expect(maybeEnqueueIntelligence(vault, new Date('2026-09-12T09:00:00.000Z'))).toEqual([]);
    for (const j of listJobs(vault).filter((x) => x.type === 'intelligence')) vault.updateNote(`Jobs/${j.id}.md`, (n) => ({ data: { ...n.data, status: 'done' }, body: n.body }), 'daemon');
    expect(maybeEnqueueIntelligence(vault, new Date('2026-09-12T09:00:00.000Z'))).toHaveLength(4);
    expect(listJobs(vault).filter((j) => j.type === 'intelligence')).toHaveLength(8);
  });

  it('two cycles on one date write two files, and the second names the first as its previous (C3)', () => {
    heartbeat();
    const day1 = maybeEnqueueIntelligence(vault, new Date('2026-09-11T09:00:00.000Z'));
    const first = intelligencePath('competitive', '2026-09-11', 1);
    expect(readJob(vault, day1.find((id) => readJob(vault, id)!.data.title.startsWith('Competitive'))!)!.body).toContain(first);
    // The sweep lands, the analyst clears the queue, and three more heartbeats happen the same day.
    vault.writeText(first, '# competitive', 'intelligence_analyst');
    for (const j of listJobs(vault).filter((x) => x.type === 'intelligence')) vault.updateNote(`Jobs/${j.id}.md`, (n) => ({ data: { ...n.data, status: 'done' }, body: n.body }), 'daemon');
    heartbeat(); heartbeat(); heartbeat();
    // Same date, later cycle: a *different* file, and the first one is what it reports changes against.
    const later = maybeEnqueueIntelligence(vault, new Date('2026-09-11T21:00:00.000Z'));
    expect(later).toEqual([]);   // already swept today
    // Force the day to roll over: the second file is distinct and names the first.
    const day2 = maybeEnqueueIntelligence(vault, new Date('2026-09-12T09:00:00.000Z'));
    const second = readJob(vault, day2.find((id) => readJob(vault, id)!.data.title.startsWith('Competitive'))!)!;
    const path2 = intelligencePath('competitive', '2026-09-12', 4);
    expect(path2).not.toBe(first);
    expect(second.data.done_when).toContain(path2);
    expect(second.body).toContain(`the previous sweep, ${first}`);
    expect(vault.exists(first)).toBe(true);   // nothing overwrote day one
  });

  it('intelligencePath and the goal sort a same-day pair by cycle, newest last', () => {
    const c1 = intelligencePath('market', '2026-09-11', 1);
    const c12 = intelligencePath('market', '2026-09-11', 12);
    expect(c1).toBe('Research/intelligence/2026-09-11-c001-market.md');
    expect([c12, c1].sort()).toEqual([c1, c12]);   // zero-padded, so a plain sort is chronological
  });

  it('falls back to the research lead when there is no intelligence analyst', () => {
    vault.remove('Roles/intelligence_analyst.md', 'daemon');
    heartbeat();
    const ids = maybeEnqueueIntelligence(vault);
    expect(ids).toHaveLength(4);
    expect(readJob(vault, ids[0])!.data.assigned).toBe('research_manager');
  });

  it('the goal states the meaningful-change rule and names the previous file when there is one', () => {
    const first = intelligenceGoal('competitive', intelligencePath('competitive', '2026-09-11', 1), null);
    expect(first).toMatch(/Research\/intelligence\/2026-09-11-c001-competitive\.md/);
    expect(first).toMatch(/Detect meaningful change, not collect everything/);
    expect(first).toMatch(/## Noise ignored/);
    expect(first).toMatch(/Ideas\/<slug>\.md/);
    expect(first).toMatch(/no previous competitive file/i);
    const later = intelligenceGoal('competitive', intelligencePath('competitive', '2026-09-12', 2), 'Research/intelligence/2026-09-11-c001-competitive.md');
    expect(later).toMatch(/Research\/intelligence\/2026-09-11-c001-competitive\.md/);
    expect(later).toMatch(/Research\/intelligence\/2026-09-12-c002-competitive\.md/);
    expect(later).toMatch(/changed since/i);
  });
});
