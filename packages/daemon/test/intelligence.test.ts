import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, readJob, listJobs } from '@cubicle/core';
import { maybeEnqueueIntelligence, INTELLIGENCE_KINDS, intelligenceGoal } from '../src/evolution.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-intel-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });
const heartbeat = () => vault.events.emit({ type: 'heartbeat.completed', payload: {} });

describe('continuous intelligence (owner model §14–17)', () => {
  it('queues nothing before the first heartbeat', () => {
    expect(maybeEnqueueIntelligence(vault)).toEqual([]);
  });

  it('queues one cheap job per kind after a heartbeat, and exactly once per cycle', () => {
    heartbeat();
    const ids = maybeEnqueueIntelligence(vault, new Date('2026-09-11T09:00:00.000Z'));
    expect(ids).toHaveLength(4);
    expect(maybeEnqueueIntelligence(vault, new Date('2026-09-11T10:00:00.000Z'))).toEqual([]);   // idempotent within the cycle

    const jobs = ids.map((id) => readJob(vault, id)!.data);
    expect(jobs.map((j) => j.type)).toEqual(['intelligence', 'intelligence', 'intelligence', 'intelligence']);
    expect(jobs.every((j) => j.assigned === 'intelligence_analyst')).toBe(true);
    expect(jobs.every((j) => j.model_tier === 'cheap')).toBe(true);
    expect(jobs.every((j) => j.team === 'research')).toBe(true);
    expect(jobs.every((j) => j.for === 'research_manager')).toBe(true);
    for (const kind of INTELLIGENCE_KINDS) {
      const j = jobs.find((x) => x.title.toLowerCase().includes(kind))!;
      expect(j.done_when).toContain(`Research/intelligence/2026-09-11-${kind}.md`);
    }

    heartbeat();
    expect(maybeEnqueueIntelligence(vault, new Date('2026-09-12T09:00:00.000Z'))).toHaveLength(4);   // next cycle, four more
    expect(listJobs(vault).filter((j) => j.type === 'intelligence')).toHaveLength(8);
  });

  it('falls back to the research lead when there is no intelligence analyst', () => {
    vault.remove('Roles/intelligence_analyst.md', 'daemon');
    heartbeat();
    const ids = maybeEnqueueIntelligence(vault);
    expect(ids).toHaveLength(4);
    expect(readJob(vault, ids[0])!.data.assigned).toBe('research_manager');
  });

  it('the goal states the meaningful-change rule and names the previous file when there is one', () => {
    const first = intelligenceGoal('competitive', '2026-09-11', null);
    expect(first).toMatch(/Research\/intelligence\/2026-09-11-competitive\.md/);
    expect(first).toMatch(/Detect meaningful change, not collect everything/);
    expect(first).toMatch(/## Noise ignored/);
    expect(first).toMatch(/Ideas\/<slug>\.md/);
    expect(first).toMatch(/no previous competitive file/i);
    const later = intelligenceGoal('competitive', '2026-09-12', 'Research/intelligence/2026-09-11-competitive.md');
    expect(later).toMatch(/Research\/intelligence\/2026-09-11-competitive\.md/);
    expect(later).toMatch(/changed since/i);
  });
});
