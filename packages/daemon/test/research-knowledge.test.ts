import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, updateJob, ResearchRequest, parseNote, readJob, listJobs } from '@cubicle/core';
import { captureResearchDeliveries, FOLLOW_UP_DAYS, enqueueResearchFollowUps, listResearchFollowUps, researchMetrics, renderResearchMetrics, maybeEnqueueWeeklyReview, WEEKLY_REVIEW_EVERY } from '../src/evolution.js';

/** A fixed delivery clock: the event's own ts drives `delivered` and `due`, so it must not be the wall clock. */
const DELIVERED_AT = '2026-09-11T09:00:00.000Z';
/** The job's `created` stamp, pinned well before `DELIVERED_AT` so time-to-answer math never races the real
 *  wall clock: `createJob` stamps `created` from `nowIso()`, and once the sandbox's real clock crosses
 *  `DELIVERED_AT` on the same calendar day, a job "created" at the actual current instant would land after
 *  the fixed delivery time, going negative and getting dropped by `researchMetrics`'s `ms >= 0` guard. */
const CREATED_AT = '2026-09-10T09:00:00.000Z';

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
  vault.updateNote(`Jobs/${id}.md`, (n) => ({ data: { ...n.data, created: CREATED_AT }, body: `${n.body}\n\`\`\`json\n${JSON.stringify({ status: 'done', summary: 'Publish the price; signups are unlikely to move', metrics: { confidence: opts.confidence ?? 'medium', method: opts.method ?? 'secondary + interviews' } })}\n\`\`\`\n` }), 'daemon');
  updateJob(vault, id, { status: 'done' }, 'daemon');
  vault.events.emit({ type: 'research.delivered', agent: 'researcher', job: id, payload: {}, ts: DELIVERED_AT });
  return id;
}

describe('research delivery capture (owner model §23, §40)', () => {
  it('adds an index row and opens a follow-up note with a due date, exactly once', () => {
    const id = deliver();
    const written = captureResearchDeliveries(vault);
    expect(written).toEqual([`Research/followups/${id}.md`]);
    expect(captureResearchDeliveries(vault)).toEqual([]);  // idempotent

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
    captureResearchDeliveries(vault);
    const index = vault.readText('Research/index.md');
    expect(index).toContain('unstated');
  });

  it('ignores a delivery whose job note has gone', () => {
    const id = deliver();
    vault.remove(`Jobs/${id}.md`, 'daemon');
    expect(captureResearchDeliveries(vault)).toEqual([]);
  });
});

describe('the follow-up measurement job (owner model §41)', () => {
  it('waits for the due date, then queues one measurement job for the research lead', () => {
    const id = deliver();
    captureResearchDeliveries(vault);
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
    // I8: the metric only counts an outcome that *begins* with one of the four phrases, so the goal has to say so.
    const body = readJob(vault, ids[0])!.body;
    expect(body).toMatch(/`outcome:` must BEGIN with exactly one of/);
    for (const phrase of ['as expected', 'partly', 'not as expected', 'cannot tell yet']) expect(body).toContain(`\`${phrase}\``);
  });

  it('the sweep runs at most once a calendar day (M4)', () => {
    deliver();
    captureResearchDeliveries(vault);
    // Two ticks 30 s apart on the same day: the second does no work at all, however many notes are on disk.
    expect(enqueueResearchFollowUps(vault, new Date('2026-09-25T09:00:00.000Z'))).toHaveLength(1);
    vault.updateNote(listResearchFollowUps(vault)[0].path, (n) => ({ data: { ...n.data, due: '2026-01-01' }, body: n.body }), 'owner');
    expect(enqueueResearchFollowUps(vault, new Date('2026-09-25T09:00:30.000Z'))).toEqual([]);
    expect(enqueueResearchFollowUps(vault, new Date('2026-09-26T09:00:00.000Z'))).toEqual([]);   // next day, still measured once
  });

  it('a follow-up already measured is never re-queued', () => {
    deliver();
    captureResearchDeliveries(vault);
    const fu = listResearchFollowUps(vault)[0];
    vault.updateNote(fu.path, (n) => ({ data: { ...n.data, status: 'measured' }, body: n.body }), 'daemon');
    expect(enqueueResearchFollowUps(vault, new Date('2026-10-01T09:00:00.000Z'))).toEqual([]);
    expect(listJobs(vault).some((j) => j.type === 'research.measure')).toBe(false);
  });
});

describe('Metrics/research.md (owner model §41)', () => {
  it('counts what the vault can prove and leaves the rest null', () => {
    expect(researchMetrics(vault)).toMatchObject({ delivered: 0, medianHoursToAnswer: null, reuseRate: null, measured: 0, asExpected: 0 });
    const id = deliver();
    captureResearchDeliveries(vault);
    const m = researchMetrics(vault);
    expect(m.delivered).toBe(1);
    expect(m.measured).toBe(0);
    expect(m.medianHoursToAnswer).not.toBeNull();
    expect(m.reuseRate).toBe(0);                                     // this job cited no earlier project

    // a second project that cites an earlier one is reuse
    expect(id).toBeTruthy();
    const second = deliver();
    vault.updateNote(`Jobs/${second}.md`, (n) => ({ data: n.data, body: `${n.body}\n\nBuilt on Research/earlier-project/report.md\n` }), 'daemon');
    captureResearchDeliveries(vault);
    expect(researchMetrics(vault).reuseRate).toBeCloseTo(0.5, 5);
  });

  it('counts a measured follow-up and its verdict', () => {
    deliver();
    captureResearchDeliveries(vault);
    const fu = listResearchFollowUps(vault)[0];
    vault.updateNote(fu.path, (n) => ({ data: { ...n.data, status: 'measured', outcome: 'as expected: signups flat' }, body: n.body }), 'daemon');
    const m = researchMetrics(vault);
    expect(m.measured).toBe(1);
    expect(m.asExpected).toBe(1);
  });

  it('renders a page that says what it does not know', () => {
    const text = renderResearchMetrics({ delivered: 0, open: 2, medianHoursToAnswer: null, reused: 0, reuseRate: null, measured: 0, asExpected: 0 }, new Date('2026-09-11T09:00:00.000Z'));
    expect(text).toMatch(/^# Research metrics$/m);
    expect(text).toMatch(/not enough delivered research to say/i);
    expect(text).toMatch(/Number of reports is deliberately not a metric/i);
  });

  it('the weekly review writes the file on its cadence', async () => {
    for (let i = 0; i < WEEKLY_REVIEW_EVERY; i++) vault.events.emit({ type: 'heartbeat.completed', payload: {} });
    expect(vault.exists('Metrics/research.md')).toBe(true);          // shipped by the template
    await maybeEnqueueWeeklyReview(vault);
    expect(vault.readText('Metrics/research.md')).toMatch(/# Research metrics/);
    expect(vault.readText('Metrics/research.md')).toMatch(/Generated .*by the daemon/);
  });
});
