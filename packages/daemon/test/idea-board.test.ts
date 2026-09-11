import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, loadOrg, listJobs, listInbox, readJob, updateJob, readIdea, writeIdeaCard, updateIdea, listDecisions, DecisionFrontmatter, createProposal } from '@cubicle/core';
import { ideaVerdictKey, ideaVerdictBody, writeBoardSessionDecision, HEARTBEAT_STEPS, NON_WORK_TYPES, runHeartbeat, createHeartbeatJob } from '../src/index.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';
import { letTheBoardDecide } from './helpers/board-switch.js';

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sp3-board-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const facts = {
  slug: 'meal-kits', title: 'Meal kits for nurseries', score: 46, band: 'keep' as const,
  reason: '46/60 → keep (keep at 44, park at 26).', board: 'pass' as const,
  findings: ['nobody has priced delivery'], research: 'Research/meal-kits/report.md',
  estimate: 'Two weeks of one engineer.', decidesAfterHours: 0,
};

/** A card both offices have answered, so `nextIdeaForBoard` will hand it to the board. */
function scoredCard(v: Vault, title: string, inputs: { value: number; evidence: number; effort: number; fit: number }): string {
  const slug = writeIdeaCard(v, { title, source: 'discovery', evidence: ['the owner asked for it'] }, 'daemon');
  updateIdea(v, slug, { score_inputs: inputs, research: `Research/${slug}/report.md`, research_confidence: 'medium', estimate: 'Two weeks of one engineer.' }, 'daemon');
  return slug;
}

describe('the owner rules on an idea (spec §3.5)', () => {
  it('is keyed on the idea, so a resumed cycle rules on the note it already filed', () => {
    expect(ideaVerdictKey('meal-kits')).toBe('idea-verdict:meal-kits');
    expect(ideaVerdictKey('meal-kits')).not.toBe(ideaVerdictKey('nursery-pilot'));
  });

  it('shows the recommendation, the arithmetic, the board and the two numbers', () => {
    const body = ideaVerdictBody(facts);
    expect(body).toContain('[[Ideas/meal-kits]]');
    expect(body).toContain('Recommendation: **keep**');
    expect(body).toContain('46/60 → keep');
    expect(body).toContain('- nobody has priced delivery');
    expect(body).toContain('Research/meal-kits/report.md');
    expect(body).toContain('Two weeks of one engineer.');
    expect(body).toContain('`chosen: 1`');
    expect(body).not.toContain('board_decides_after_hours');            // the switch is off: no deadline line
    expect(ideaVerdictBody({ ...facts, decidesAfterHours: 12 })).toContain('after 12 h the recommendation stands');
    expect(ideaVerdictBody({ ...facts, findings: [], research: '', estimate: '' })).toContain('nothing that would sink this');
  });
});

describe('the board session record (spec §3.3)', () => {
  it('writes a Decisions/ note per idea, adopted on a pass and proposed on a return', () => {
    const now = new Date('2026-09-11T10:00:00.000Z');
    const rel = writeBoardSessionDecision(vault, 'meal-kits', 'Meal kits', 'job_b1', 'return', ['delivery is unpriced'], 'advisor_skeptic', now);
    expect(rel).toBe('Decisions/board-meal-kits.md');
    const note = vault.readNoteOrNull(rel)!;
    expect(DecisionFrontmatter.parse(note.data).status).toBe('proposed');
    expect(note.body).toContain('delivery is unpriced');
    expect(note.body).toContain('[[Ideas/meal-kits]]');
    // A rerun overwrites the same note rather than filing a second one.
    const again = writeBoardSessionDecision(vault, 'meal-kits', 'Meal kits', 'job_b2', 'pass', [], 'advisor_skeptic', now);
    expect(again).toBe(rel);
    expect(DecisionFrontmatter.parse(vault.readNoteOrNull(rel)!.data).status).toBe('adopted');
    expect(listDecisions(vault).filter((d) => d.data.id === 'board-meal-kits').length).toBe(1);
  });

  it('says "no advisor answered" rather than "the board found nothing"', () => {
    const rel = writeBoardSessionDecision(vault, 'x', 'X', 'job_b1', 'pass', [], 'advisor_skeptic', new Date(), 0);
    expect(vault.readNoteOrNull(rel)!.body).toContain('No advisor answered');
    expect(vault.readNoteOrNull(rel)!.body).not.toContain('the plan passed unreviewed');
  });

  it('reviews an idea in 30 days, not the pre-mortem\'s 7', () => {
    const rel = writeBoardSessionDecision(vault, 'y', 'Y', 'job_b1', 'pass', [], 'advisor_skeptic', new Date('2026-09-11T10:00:00.000Z'));
    expect(DecisionFrontmatter.parse(vault.readNoteOrNull(rel)!.data).review_date).toBe('2026-10-11');
  });
});

describe('the cycle gains two steps (spec §5.1)', () => {
  it('puts discovery and the idea board before the plan is written', () => {
    expect([...HEARTBEAT_STEPS]).toEqual([
      'gather', 'reconcile_brand', 'answer_owner', 'discovery', 'ideas_board', 'meeting',
      'company_plan', 'board_premortem', 'owner_verdict', 'division_plans', 'brief', 'commit',
    ]);
  });

  it('counts a board.session as bookkeeping and discovery as real work', () => {
    expect(NON_WORK_TYPES).toContain('board.session');
    expect(NON_WORK_TYPES).toContain('board.premortem');
    expect(NON_WORK_TYPES).not.toContain('discovery');
    expect(NON_WORK_TYPES).not.toContain('finance.estimate');
  });
});

describe('the ideas_board step (spec §3.3/§3.5)', () => {
  it('sits the board on the best-scoring unjudged card, records it, and asks the owner to rule', async () => {
    const good = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });   // 54
    const weak = scoredCard(vault, 'A newsletter about spoons', { value: 2, evidence: 2, effort: 3, fit: 2 }); // 27
    const hb = createHeartbeatJob(vault, 'test');
    // The cycle blocks at company_plan; everything before it, including the board session, has run by then.
    const out = await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass' }) }, hb);
    expect(out.status).toBe('blocked');
    expect(readJob(vault, hb)!.data.checkpoint_step).toBe(HEARTBEAT_STEPS.indexOf('company_plan'));

    // One session, on the higher-scoring card, and the lower one is left for a later cycle.
    const sessions = listJobs(vault).filter((j) => j.type === 'board.session');
    expect(sessions.length).toBe(1);
    expect(sessions[0].status).toBe('done');
    expect(readIdea(vault, good)!.data.board_verdict).toBe('pass');
    expect(readIdea(vault, weak)!.data.board_verdict).toBeNull();

    // The record and the card.
    expect(readIdea(vault, good)!.data.board_decision).toBe(`Decisions/board-${good}.md`);
    expect(vault.readNoteOrNull(`Decisions/board-${good}.md`)).toBeTruthy();
    expect(readIdea(vault, good)!.body).toContain('**Passed**');

    // The owner's note: keyed on the idea, targeting the card, carrying the band it recommends.
    const verdicts = listInbox(vault).filter((n) => n.data.kind === 'idea_verdict');
    expect(verdicts.length).toBe(1);
    expect(verdicts[0].data.target).toBe(`Ideas/${good}.md`);
    expect(verdicts[0].data.band).toBe('keep');
    expect(verdicts[0].data.board_verdict).toBe('pass');
    expect(verdicts[0].body).toContain('Recommendation: **keep**');
    // Still the owner's to rule on: nothing decided the card behind their back.
    expect(readIdea(vault, good)!.data.decision).toBe('undecided');
  }, 30000);

  it('parks a card the board returned, and the recommendation on the note is what the ruling uses', async () => {
    const slug = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    const hb = createHeartbeatJob(vault, 'test');
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'return' }) }, hb);
    expect(readIdea(vault, slug)!.data.board_verdict).toBe('return');
    // 54/60 would keep, but a returned idea parks until its findings are answered (ideaBand).
    const note = listInbox(vault).find((n) => n.data.kind === 'idea_verdict')!;
    expect(note.data.band).toBe('park');
    expect(note.body).toContain('Recommendation: **park**');
    expect(readIdea(vault, slug)!.body).toContain('**Returned**');
    expect(DecisionFrontmatter.parse(vault.readNoteOrNull(`Decisions/board-${slug}.md`)!.data).status).toBe('proposed');
  }, 30000);

  it('files one note per idea however often the step is replayed', async () => {
    const slug = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    const hb = createHeartbeatJob(vault, 'test');
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass' }) }, hb);
    const first = listInbox(vault).filter((n) => n.data.kind === 'idea_verdict').map((n) => n.data.id);
    // Rewind to the step and run it again: the board's verdict is on the card, so nextIdeaForBoard skips it.
    const hb2 = createHeartbeatJob(vault, 'test again');
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass' }) }, hb2);
    expect(listInbox(vault).filter((n) => n.data.kind === 'idea_verdict').map((n) => n.data.id)).toEqual(first);
    expect(listJobs(vault).filter((j) => j.type === 'board.session').length).toBe(1);
    expect(readIdea(vault, slug)!.data.board_verdict).toBe('pass');
  }, 30000);

  it('waits for the finance office to price a new card, then reads it', async () => {
    const slug = writeIdeaCard(vault, { title: 'Meal kits for nurseries', source: 'discovery', evidence: ['the owner asked for it'] }, 'daemon');
    const org = loadOrg(vault);
    const hb = createHeartbeatJob(vault, 'test');
    const out = await runHeartbeat({ vault, llm: orgLlm() }, hb);
    // Unpriced: the step queues the estimate and blocks on it rather than sitting the board on half a dossier.
    expect(out.status).toBe('blocked');
    const estimates = listJobs(vault).filter((j) => j.type === 'finance.estimate');
    expect(estimates.length).toBe(1);
    expect(out).toEqual({ status: 'blocked', on: { kind: 'job', id: estimates[0].id } });
    expect(listJobs(vault).filter((j) => j.type === 'board.session').length).toBe(0);
    expect(org.roles[estimates[0].assigned]).toBeTruthy();

    // The finance office answers; the heartbeat resumes and the board sits.
    updateIdea(vault, slug, { score_inputs: { value: 5, evidence: 4, effort: 4, fit: 5 }, estimate: 'Two weeks of one engineer.' }, 'daemon');
    updateJob(vault, estimates[0].id, { status: 'done' }, 'daemon');
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass' }) }, hb);
    expect(listJobs(vault).filter((j) => j.type === 'board.session').length).toBe(1);
    expect(readIdea(vault, slug)!.data.board_verdict).toBe('pass');
  }, 30000);

  it('does nothing at all when no card is ready for the board', async () => {
    const hb = createHeartbeatJob(vault, 'test');
    const out = await runHeartbeat({ vault, llm: orgLlm() }, hb);
    expect(out.status).toBe('blocked');   // at company_plan, not at the board
    expect(listJobs(vault).filter((j) => j.type === 'board.session').length).toBe(0);
    expect(listInbox(vault).filter((n) => n.data.kind === 'idea_verdict').length).toBe(0);
    expect(readJob(vault, hb)!.body).toContain('no idea is ready for the board');
  }, 30000);
});

/**
 * An idea the board has already judged and filed a note for, parked at `owner_verdict` — the step where the
 * heartbeat closes a verdict the owner never came back to. The card carries the board's verdict so this cycle's
 * `ideas_board` has nothing left to sit on, and the note carries the band the board recommended, because that
 * stamped band — not a recomputation — is what stands when the deadline elapses.
 */
function verdictWaiting(v: Vault, id: string, createdAgoMs: number): { slug: string; hb: string } {
  const slug = writeIdeaCard(v, { title: 'Meal kits for nurseries', source: 'discovery' }, 'daemon');
  updateIdea(v, slug, { score_inputs: { value: 5, evidence: 4, effort: 4, fit: 5 }, board_verdict: 'pass' }, 'daemon');
  const { path: rel } = createProposal(v, {
    id, kind: 'idea_verdict', from: 'ceo', to: 'owner', target: `Ideas/${slug}.md`,
    title: 'Keep, park or scrap: Meal kits', body: 'Recommendation: **keep**.',
  }, 'ceo');
  v.updateNote(rel, (n) => ({ data: { ...n.data, created: new Date(Date.now() - createdAgoMs).toISOString(), board_verdict: 'pass', band: 'keep' }, body: n.body }), 'daemon');
  const hb = createHeartbeatJob(v, 'test');
  updateJob(v, hb, { checkpoint_step: HEARTBEAT_STEPS.indexOf('owner_verdict') }, 'daemon');
  return { slug, hb };
}

describe('an unattended night rules on ideas too (spec §3.5)', () => {
  it('lets the recommendation on the note stand once board_decides_after_hours has elapsed', async () => {
    letTheBoardDecide(vault, 0.0001);
    const { slug, hb } = verdictWaiting(vault, 'prop_idea_1', 3600_000);
    await runHeartbeat({ vault, llm: orgLlm() }, hb);

    const note = listInbox(vault).find((n) => n.data.kind === 'idea_verdict')!;
    expect(note.data.approved).toBe(true);
    expect(note.data.decided_by).toBe('board');
    expect(note.data.resolved_at).toBeTruthy();
    const card = readIdea(vault, slug)!;
    expect(card.data.decision).toBe('keep');
    expect(card.data.decided_by).toBe('board');
    expect(card.data.status).toBe('accepted');
    expect(card.body).toContain('board_decides_after_hours');
    expect(vault.events.query({ types: ['proposal.resolved'] }).some((e) => e.payload.kind === 'idea_verdict')).toBe(true);
  }, 30000);

  it('leaves the note alone while the switch is off, however long the owner takes', async () => {
    const { slug, hb } = verdictWaiting(vault, 'prop_idea_2', 30 * 24 * 3600_000);
    await runHeartbeat({ vault, llm: orgLlm() }, hb);

    const note = listInbox(vault).find((n) => n.data.kind === 'idea_verdict')!;
    expect(note.data.approved).toBeNull();
    expect(note.data.resolved_at).toBeNull();
    expect(readIdea(vault, slug)!.data.decision).toBe('undecided');
  }, 30000);
});
