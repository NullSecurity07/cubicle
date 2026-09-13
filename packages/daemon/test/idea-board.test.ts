import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, loadOrg, listJobs, listInbox, readJob, updateJob, readIdea, writeIdeaCard, updateIdea, listDecisions, DecisionFrontmatter, createProposal, PRESSURE_UNANSWERED } from '@cubicle/core';
import { ideaVerdictKey, ideaVerdictBody, writeBoardSessionDecision, HEARTBEAT_STEPS, NON_WORK_TYPES, PLAN_WAIT_BUDGET_MS, runHeartbeat, createHeartbeatJob, runBoardSession, chairPrompt, CHAIR_IDEA_TOKENS, BOARD_JOB_CHAIR_SECTION } from '../src/index.js';
import { estimateJobId, researchJobId } from '../src/discovery.js';
import { orgLlm } from '../../../scripts/lib/org-llm.js';
import { letTheBoardDecide } from './helpers/board-switch.js';
import { adoptFounderBrief } from './helpers/brief.js';

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sp3-board-'));
  vault = (await scaffoldVault(dir)).vault;
  // Ruling S-1: without an adopted brief the planning steps log "waiting for the founder brief" and the cycle
  // runs to the end. These cases assert on where the cycle *stops* (at `company_plan`), so they need one.
  adoptFounderBrief(vault);
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
    // The order, not the indices: the list has taken an insertion since (`money` at 1), and pinning positions
    // makes every later step's number a thing that has to be edited rather than a thing that is checked.
    expect([...HEARTBEAT_STEPS]).toEqual(expect.arrayContaining([
      'gather', 'reconcile_brand', 'answer_owner', 'discovery', 'ideas_board', 'meeting',
      'company_plan', 'board_premortem', 'owner_verdict', 'division_plans', 'brief', 'commit',
    ]));
    const at = (s: string) => HEARTBEAT_STEPS.indexOf(s as (typeof HEARTBEAT_STEPS)[number]);
    expect(at('gather')).toBeLessThan(at('discovery'));
    expect(at('discovery')).toBeLessThan(at('ideas_board'));
    expect(at('ideas_board')).toBeLessThan(at('company_plan'));
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

  it('files one job, one decision note and one verdict note when the same cycle re-enters the step', async () => {
    const slug = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    const hb = createHeartbeatJob(vault, 'test');
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass' }) }, hb);
    const first = listInbox(vault).filter((n) => n.data.kind === 'idea_verdict').map((n) => n.data.id);
    expect(first.length).toBe(1);

    // The real replay this step's deterministic ids exist for: a kill after the session ran and before the card
    // was stamped. Rewind the same heartbeat to `ideas_board`, undo the stamp, and run it again.
    updateIdea(vault, slug, { board_verdict: null, board_decision: '' }, 'daemon');
    updateJob(vault, hb, { status: 'queued', checkpoint_step: HEARTBEAT_STEPS.indexOf('ideas_board'), blocked_on: undefined }, 'daemon');
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass' }) }, hb);

    expect(listInbox(vault).filter((n) => n.data.kind === 'idea_verdict').map((n) => n.data.id)).toEqual(first);
    expect(listJobs(vault).filter((j) => j.type === 'board.session').length).toBe(1);
    expect(listDecisions(vault).filter((d) => d.data.id === `board-${slug}`).length).toBe(1);
    expect(readIdea(vault, slug)!.data.board_verdict).toBe('pass');

    // And a later cycle does not sit the board on a card that already has a verdict.
    const hb2 = createHeartbeatJob(vault, 'test again');
    const llm = orgLlm({ ideaVerdict: 'pass' });
    await runHeartbeat({ vault, llm }, hb2);
    expect(listJobs(vault).filter((j) => j.type === 'board.session').length).toBe(1);
    expect(llm.calls.advisor_skeptic).toBeUndefined();
  }, 30000);

  it('re-files a verdict note a kill lost between the card stamp and the proposal, without sitting the board again', async () => {
    // The stranded state: the board judged the card (verdict + decision note on file) but no owner note exists.
    const slug = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    updateIdea(vault, slug, { board_verdict: 'pass', board_decision: `Decisions/board-${slug}.md` }, 'daemon', {
      heading: '## The board',
      content: '**Passed** — 3 advisors, 2026-09-11.\n\n- nobody has priced delivery',
    });
    expect(listInbox(vault).filter((n) => n.data.kind === 'idea_verdict').length).toBe(0);

    const llm = orgLlm({ ideaVerdict: 'pass' });
    const hb = createHeartbeatJob(vault, 'test');
    await runHeartbeat({ vault, llm }, hb);

    const notes = listInbox(vault).filter((n) => n.data.kind === 'idea_verdict');
    expect(notes.length).toBe(1);
    expect(notes[0].data.target).toBe(`Ideas/${slug}.md`);
    expect(notes[0].data.band).toBe('keep');
    expect(notes[0].data.board_verdict).toBe('pass');
    // The findings come off the card, because the cache the kill took is exactly what is not available.
    expect(notes[0].body).toContain('- nobody has priced delivery');
    // The board did not sit again: no session job, no advisor call, no second decision note.
    expect(listJobs(vault).filter((j) => j.type === 'board.session').length).toBe(0);
    expect(llm.calls.advisor_skeptic).toBeUndefined();
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'ideas_board' && /re-filed the missing verdict note/.test(String(e.payload.message)))).toBe(true);

    // Idempotent: a second cycle finds the note and does nothing.
    await runHeartbeat({ vault, llm: orgLlm() }, createHeartbeatJob(vault, 'again'));
    expect(listInbox(vault).filter((n) => n.data.kind === 'idea_verdict').map((n) => n.data.id)).toEqual(notes.map((n) => n.data.id));
  }, 30000);

  it('spends at most four model calls on the board: one turn per advisor and one chair merge', async () => {
    scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    scoredCard(vault, 'A newsletter about spoons', { value: 4, evidence: 4, effort: 4, fit: 4 });
    const llm = orgLlm({ ideaVerdict: 'pass' });
    await runHeartbeat({ vault, llm }, createHeartbeatJob(vault, 'test'));
    const org = loadOrg(vault);
    const advisors = [...new Set([org.teams.board!.lead, ...org.teams.board!.members])].filter((r) => org.roles[r]).slice(0, 3);
    // Each advisor speaks once; the board lead also chairs the merge, so it is called one extra time.
    for (const a of advisors) expect(llm.calls[a]).toBe(a === org.teams.board!.lead ? 2 : 1);
    expect(advisors.reduce((n, a) => n + llm.calls[a], 0)).toBeLessThanOrEqual(4);
  }, 30000);

  it('stays parked on the step when it gives up on an estimate, so a kill during the session resumes at the board', async () => {
    scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    // Researched but unpriced: this one is worth waiting for, because a price is all it needs to be scored.
    const unpriced = writeIdeaCard(vault, { title: 'Something nobody has priced', source: 'discovery' }, 'daemon');
    updateIdea(vault, unpriced, { score_inputs: { evidence: 4, fit: 4 } }, 'research_manager');
    const hb = createHeartbeatJob(vault, 'test');
    const inner = orgLlm({ ideaVerdict: 'pass' });
    // What the checkpoint said each time an advisor spoke: while the board sits, the step must not yet be past.
    const stepWhileSitting: number[] = [];
    const llm = {
      ...inner,
      async chat(req: Parameters<typeof inner.chat>[0], chat: Parameters<typeof inner.chat>[1]) {
        if (/this idea|quarter on this/.test(String(chat.messages.at(-1)?.content ?? ''))) stepWhileSitting.push(readJob(vault, hb)!.data.checkpoint_step);
        return inner.chat(req, chat);
      },
    };
    let clock = new Date();
    expect((await runHeartbeat({ vault, llm, now: () => clock }, hb)).status).toBe('blocked');
    expect(listJobs(vault).filter((j) => j.type === 'finance.estimate').length).toBe(1);

    // Nobody prices it. Past the budget, the step gives up and sits the board on what it has.
    clock = new Date(clock.getTime() + PLAN_WAIT_BUDGET_MS + 60_000);
    await runHeartbeat({ vault, llm, now: () => clock }, hb);
    expect(listJobs(vault).filter((j) => j.type === 'board.session').length).toBe(1);
    expect(stepWhileSitting.length).toBeGreaterThan(0);
    expect(Math.max(...stepWhileSitting)).toBeLessThanOrEqual(HEARTBEAT_STEPS.indexOf('ideas_board'));
    expect(readJob(vault, hb)!.body).toContain('the board chooses from what is priced');
  }, 30000);

  // I2, the other side of it: a card with no research half cannot be scored however fast the finance office
  // answers, so the cycle must not spend an hour of its plan latency waiting for its price.
  it('does not hold the cycle for the price of a card whose research half is missing', async () => {
    scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    const bare = writeIdeaCard(vault, { title: 'Something nobody has looked into', source: 'intelligence:competitive' }, 'daemon');
    const hb = createHeartbeatJob(vault, 'test');
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass' }) }, hb);
    // Both jobs are queued — the estimate and the research half — and neither was waited on.
    expect(listJobs(vault).filter((j) => j.type === 'finance.estimate').map((j) => j.id)).toContain(estimateJobId(bare));
    expect(listJobs(vault).filter((j) => j.type === 'research').map((j) => j.id)).toContain(researchJobId(bare));
    // The board still sat this cycle, on the card that was ready.
    expect(listJobs(vault).filter((j) => j.type === 'board.session').length).toBe(1);
    expect(readJob(vault, hb)!.body).not.toContain('estimate(s) still open');
  }, 30000);

  it('says the idea passed unreviewed when no advisor could answer', async () => {
    const slug = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    await runHeartbeat({ vault, llm: orgLlm({ boardSilent: true }) }, createHeartbeatJob(vault, 'test'));

    expect(readIdea(vault, slug)!.data.board_verdict).toBe('pass');   // mergeBoardVerdict fails open; it must not stall
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'ideas_board' && /No advisor answered/.test(String(e.payload.reason)))).toBe(true);
    const note = vault.readNoteOrNull(`Decisions/board-${slug}.md`)!;
    expect(note.body).toContain('the idea passed unreviewed');
    expect(note.body).not.toContain('the plan passed unreviewed');
    expect(note.body).not.toContain('likely to sink a quarter');      // not a clean bill of health
  }, 30000);

  it('waits for the finance office to price a new card, then reads it', async () => {
    const slug = writeIdeaCard(vault, { title: 'Meal kits for nurseries', source: 'discovery', evidence: ['the owner asked for it'] }, 'daemon');
    // The research office has answered; only the price is missing, so this estimate is worth waiting for.
    updateIdea(vault, slug, { score_inputs: { evidence: 4, fit: 5 } }, 'research_manager');
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
    updateIdea(vault, slug, { score_inputs: { value: 5, effort: 4 }, estimate: 'Two weeks of one engineer.' }, 'cfo');
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

describe('the board pressure-tests an idea, on a budget (spec §2, §3)', () => {
  it('a scripted pass writes the verdict word and the rubric onto the card and into the owner\'s note', async () => {
    const slug = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass' }) }, createHeartbeatJob(vault, 'test'));
    const card = readIdea(vault, slug)!;
    expect(card.data.board_verdict).toBe('pass');
    expect(card.data.board_pressure).toBe('STRONG');
    expect(card.data.board_rubric).toEqual({ core_assumption: 2, fatal_flaws: 1, pain: 2, founder_fit: 1, why_now: 1 });
    expect(card.body).toContain('**Pressure test:** STRONG. Rubric 7/10 —');
    const note = listInbox(vault).find((n) => n.data.kind === 'idea_verdict')!;
    expect(note.body).toContain('- Pressure test: STRONG · rubric 7/10 —');

    // And the three parts of the owner's output shape that no bullet can carry reach the owner (ruling H3):
    // on the card, in the note they rule on, and in the decision note that outlives both.
    for (const text of [card.body, note.body, vault.readText(card.data.board_decision)]) {
      expect(text).toContain('#### Core Assumption');
      expect(text).toContain('#### Problem Validation');
      expect(text).toContain('#### Founder-Market Fit');
      expect(text).toContain('A painkiller: they already pay a caterer every term.');
    }
    // Demoted on the way in, so the card still has exactly its eight `## ` sections (spec §7).
    expect(card.body.match(/^## /gm)).toHaveLength(8);

    // And the board's own job note carries both halves: the three advisors' notes, and the merge they were
    // hired for. It is the one place an owner goes to read what the board actually said.
    const job = readJob(vault, listJobs(vault).find((j) => j.type === 'board.session')!.id)!;
    expect(job.body).toContain('## Advisors');
    expect(job.body).toContain(BOARD_JOB_CHAIR_SECTION);
    expect(job.body).toContain('#### Founder-Market Fit');
    expect(job.body).toContain('A painkiller: they already pay a caterer every term.');
  }, 30000);

  it('a pivot returns the card and leads the owner with the wedge', async () => {
    const slug = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'return' }) }, createHeartbeatJob(vault, 'test'));
    const card = readIdea(vault, slug)!;
    expect(card.data.board_verdict).toBe('return');
    expect(card.data.board_pressure).toBe('PIVOT REQUIRED');
    expect(card.body).toContain('**Returned**');
    const note = listInbox(vault).find((n) => n.data.kind === 'idea_verdict')!;
    expect(note.data.band).toBe('park');                       // a returned idea still parks, unchanged
    expect(note.body).toContain('The wedge to attack instead: the one nursery chain');
  }, 30000);

  it('the session costs three advisors and one chair, and one more only when the chair hedges', async () => {
    const org = loadOrg(vault);
    const subject = { kind: 'idea' as const, text: '# Meal kits', title: 'Meal kits', slug: 'meal-kits' };
    const scripted = (answers: string[]): { chat: () => Promise<unknown>; promptBudget: () => number } => {
      let n = 0;
      return { chat: async () => ({ content: answers[Math.min(n++, answers.length - 1)], toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [] }), promptBudget: () => 6000 };
    };
    const good = 'VERDICT: STRONG\nRUBRIC: core assumption 2, fatal flaws 2, pain 2, founder fit 2, why now 2\n- watch the margin';
    const clean = await runBoardSession({ vault, llm: scripted([good, good, good, good]) as never }, org, subject);
    expect(clean.calls).toBe(clean.advisors.length + 1);
    expect(clean.reasked).toBe(false);
    expect(clean.verdict).toBe('pass');

    // A hedge costs exactly one more call, and never two.
    let n = 0;
    const hedging = { chat: async () => ({ content: n++ === 3 ? 'VERDICT: STRONG\nIt has potential, but the margins worry me.' : good, toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] }), promptBudget: () => 6000 };
    const re = await runBoardSession({ vault, llm: hedging as never }, org, subject);
    expect(re.calls).toBe(re.advisors.length + 2);
    expect(re.reasked).toBe(true);
    expect(re.verdict).toBe('pass');
    expect(re.chairLost).toBeNull();

    // A chair that will not decide twice running returns the idea rather than passing it by default.
    const stubborn = await runBoardSession({ vault, llm: scripted(['x', 'x', 'x', 'VERDICT: MAYBE', 'VERDICT: it depends']) as never }, org, subject);
    expect(stubborn.calls).toBe(stubborn.advisors.length + 2);
    expect(stubborn.verdict).toBe('return');
    expect(stubborn.findings[0]).toBe(PRESSURE_UNANSWERED);
    expect(stubborn.chairLost).toBeNull();
  }, 30000);

  it('the idea chair is given room for the whole shape, and the plan chair is not touched (ruling H4)', async () => {
    const org = loadOrg(vault);
    const caps: number[] = [];
    const llm = {
      chat: async (_r: unknown, chat: { messages: { content: string }[]; maxTokens?: number }) => {
        if (/Merge them into ONE verdict/.test(String(chat.messages[1]?.content ?? ''))) caps.push(chat.maxTokens ?? 0);
        return { content: 'VERDICT: STRONG\nRUBRIC: core assumption 2, fatal flaws 2, pain 2, founder fit 2, why now 2', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] };
      },
      promptBudget: () => 6000,
    };
    await runBoardSession({ vault, llm: llm as never }, org, { kind: 'idea', text: '# Meal kits', title: 'Meal kits', slug: 'meal-kits' });
    await runBoardSession({ vault, llm: llm as never }, org, '# Plan\n\n- ship it');
    // The idea chair is asked for three machine lines and five headed parts; the plan chair for one line and
    // four bullets, in the 600 it has always had. One extra call is never bought by the bigger answer.
    expect(caps).toEqual([CHAIR_IDEA_TOKENS, 600]);

    // And the wedge is asked for before the five parts, so the end of a long answer is never where it sits.
    const format = chairPrompt({ kind: 'idea', text: '# Meal kits', title: 'Meal kits', slug: 'meal-kits' }, 't');
    expect(format.indexOf('WEDGE:')).toBeLessThan(format.indexOf('## Core Assumption'));
    expect(format.indexOf('RUBRIC:')).toBeLessThan(format.indexOf('WEDGE:'));
  }, 30000);

  // The three ways a re-asked chair can end, driven through the scripted org model so the whole step — card,
  // decision note, warning and the owner's note — is exercised, not just `runBoardSession`'s return value.
  it('a hedge answered properly the second time is the verdict the owner reads', async () => {
    const slug = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass', ideaChair: 'hedge-then-good' }) }, createHeartbeatJob(vault, 'test'));
    const card = readIdea(vault, slug)!;
    expect(card.data.board_verdict).toBe('pass');
    expect(card.data.board_pressure).toBe('STRONG');
    // The re-ask repeats the whole format, so the second answer keeps its rubric and its flaws — the extra call
    // buys a verdict with the same evidence behind it as a first-time answer, not a bare word.
    expect(card.data.board_rubric).toEqual({ core_assumption: 2, fatal_flaws: 1, pain: 2, founder_fit: 1, why_now: 1 });
    expect(card.body).toContain('**Pressure test:** STRONG. Rubric 7/10 —');
    expect(card.body).toContain('- watch the free tier');
    expect(vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'ideas_board')).toEqual([]);
  }, 30000);

  it('a chair that will not decide twice returns the idea, and says so on the card', async () => {
    const slug = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass', ideaChair: 'hedge-then-refusal' }) }, createHeartbeatJob(vault, 'test'));
    const card = readIdea(vault, slug)!;
    expect(card.data.board_verdict).toBe('return');
    expect(card.data.board_pressure).toBe('');
    expect(card.body).toContain(PRESSURE_UNANSWERED);
    const note = listInbox(vault).find((n) => n.data.kind === 'idea_verdict')!;
    expect(note.body).toContain(PRESSURE_UNANSWERED);
  }, 30000);

  it('a chair whose second call finds no model passes the idea unreviewed, and the warning says why (Decision 6)', async () => {
    const slug = scoredCard(vault, 'Meal kits for nurseries', { value: 5, evidence: 4, effort: 4, fit: 5 });
    await runHeartbeat({ vault, llm: orgLlm({ ideaVerdict: 'pass', ideaChair: 'hedge-then-silence' }) }, createHeartbeatJob(vault, 'test'));
    const card = readIdea(vault, slug)!;
    // Silence is not a refusal, so the idea is not returned unjudged; it falls open exactly as it does when no
    // model answers from the start, and the owner is told rather than shown a clean bill of health.
    expect(card.data.board_verdict).toBe('pass');
    expect(card.data.board_pressure).toBe('');
    expect(card.body).not.toContain(PRESSURE_UNANSWERED);
    const warned = vault.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'ideas_board');
    expect(warned).toHaveLength(1);
    expect(String(warned[0].payload.reason)).toContain('the second call had no model');
    expect(String(warned[0].payload.reason)).toContain('banned phrase');
    const decision = listDecisions(vault).find((d) => d.data.id === `board-${slug}`)!;
    expect(decision.body).toContain('the second call had no model');
  }, 30000);
});
