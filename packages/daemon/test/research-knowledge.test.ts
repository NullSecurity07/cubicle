import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, updateJob, ResearchRequest, parseNote, readJob, listJobs } from '@cubicle/core';
import { captureResearchDeliveries, FOLLOW_UP_DAYS, enqueueResearchFollowUps, listResearchFollowUps } from '../src/evolution.js';

/** A fixed delivery clock: the event's own ts drives `delivered` and `due`, so it must not be the wall clock. */
const DELIVERED_AT = '2026-09-11T09:00:00.000Z';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-know-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const request = ResearchRequest.parse({
  decision: 'Ship the pricing page', decision_owner: 'cfo', question: 'Does a public price reduce signups?',
  hypothesis: 'A public price cuts signups by more than 20%', known_evidence: 'Competitors publish prices',
  unknowns: 'Price sensitivity', constraints: '', deadline: '2026-09-25', required_confidence: 'medium',
  potential_decisions: ['Publish', 'Wait'], portfolio: 'incremental', impact: 4, uncertainty: 4, cost_of_being_wrong: 4,
});

/** A research job that has been delivered: result block written, gates passed, event emitted. */
function deliver(opts: { confidence?: string; method?: string } = {}): string {
  const id = createJob(vault, { type: 'research', title: 'Pricing', assigned: 'researcher', goal: 'g', for: 'cfo', owner_role: 'cfo', research: request, research_slug: 'pricing-abc123' }, 'cfo');
  vault.updateNote(`Jobs/${id}.md`, (n) => ({ data: n.data, body: `${n.body}\n\`\`\`json\n${JSON.stringify({ status: 'done', summary: 'Publish the price; signups are unlikely to move', metrics: { confidence: opts.confidence ?? 'medium', method: opts.method ?? 'secondary + interviews' } })}\n\`\`\`\n` }), 'daemon');
  updateJob(vault, id, { status: 'done' }, 'daemon');
  vault.events.emit({ type: 'research.delivered', agent: 'researcher', job: id, payload: {}, ts: DELIVERED_AT });
  return id;
}

describe('research delivery capture (owner model §23, §40)', () => {
  it('adds an index row and opens a follow-up note with a due date, exactly once', () => {
    const id = deliver();
    const written = captureResearchDeliveries(vault, new Date('2026-09-11T09:00:00.000Z'));
    expect(written).toEqual([`Research/followups/${id}.md`]);
    expect(captureResearchDeliveries(vault, new Date('2026-09-11T10:00:00.000Z'))).toEqual([]);  // idempotent

    const index = vault.readText('Research/index.md');
    expect(index).toContain('| delivered | job | question |');
    expect(index).toContain(`[[${id}]]`);
    expect(index).toContain('Does a public price reduce signups?');
    expect(index).toContain('medium');
    expect(index).toContain('[[Research/pricing-abc123/report]]');
    expect(index).toContain('| pending |');

    const note = parseNote(vault.readText(`Research/followups/${id}.md`));
    expect(note.data).toMatchObject({ research: id, slug: 'pricing-abc123', decision_owner: 'cfo', status: 'pending' });
    expect(note.data.due).toBe('2026-09-25');                    // 2026-09-11 + 14 days
    expect(FOLLOW_UP_DAYS).toBe(14);
    expect(String(note.data.prediction)).toContain('signups are unlikely to move');
    expect(note.body).toMatch(/## What we predicted/);
    expect(note.body).toMatch(/## What actually happened/);
  });

  it('says "unstated" rather than inventing a confidence the report never gave', () => {
    const id = createJob(vault, { type: 'research', title: 'Thin', assigned: 'researcher', goal: 'g', for: 'cto', owner_role: 'cto', research: request }, 'cto');
    updateJob(vault, id, { status: 'done' }, 'daemon');
    vault.events.emit({ type: 'research.delivered', agent: 'researcher', job: id, payload: {}, ts: DELIVERED_AT });
    captureResearchDeliveries(vault, new Date('2026-09-11T09:00:00.000Z'));
    const index = vault.readText('Research/index.md');
    expect(index).toContain('unstated');
  });

  it('ignores a delivery whose job note has gone', () => {
    const id = deliver();
    vault.remove(`Jobs/${id}.md`, 'daemon');
    expect(captureResearchDeliveries(vault, new Date('2026-09-11T09:00:00.000Z'))).toEqual([]);
  });
});

describe('the follow-up measurement job (owner model §41)', () => {
  it('waits for the due date, then queues one measurement job for the research lead', () => {
    const id = deliver();
    captureResearchDeliveries(vault, new Date('2026-09-11T09:00:00.000Z'));
    expect(listResearchFollowUps(vault)).toHaveLength(1);

    expect(enqueueResearchFollowUps(vault, new Date('2026-09-20T09:00:00.000Z'))).toEqual([]);   // not due yet

    const ids = enqueueResearchFollowUps(vault, new Date('2026-09-25T09:00:00.000Z'));
    expect(ids).toHaveLength(1);
    expect(enqueueResearchFollowUps(vault, new Date('2026-09-26T09:00:00.000Z'))).toEqual([]);   // once

    const j = readJob(vault, ids[0])!.data;
    expect(j.type).toBe('research.measure');
    expect(j.assigned).toBe('research_manager');
    expect(j.for).toBe('cfo');
    expect(j.team).toBe('research');
    expect(j.links).toContain(`[[${id}]]`);
    expect(readJob(vault, ids[0])!.body).toMatch(/signups are unlikely to move/);
    expect(readJob(vault, ids[0])!.body).toMatch(/Research\/followups\//);
    expect(readJob(vault, ids[0])!.body).toMatch(/## Prediction vs reality/);
    expect(j.done_when).toMatch(/Research\/index\.md/);
  });

  it('a follow-up already measured is never re-queued', () => {
    deliver();
    captureResearchDeliveries(vault, new Date('2026-09-11T09:00:00.000Z'));
    const fu = listResearchFollowUps(vault)[0];
    vault.updateNote(fu.path, (n) => ({ data: { ...n.data, status: 'measured' }, body: n.body }), 'daemon');
    expect(enqueueResearchFollowUps(vault, new Date('2026-10-01T09:00:00.000Z'))).toEqual([]);
    expect(listJobs(vault).some((j) => j.type === 'research.measure')).toBe(false);
  });
});
