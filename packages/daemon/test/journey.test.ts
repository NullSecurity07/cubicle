/**
 * The whole owner journey, once, on a real daemon — from "surprise me" to a plan the divisions are working on.
 *
 * **Why this file exists.** Three live runs, three sets of defects, and not one of them was caught by a unit
 * test: the suite had a case for every link and nothing that walked the chain. P8-14 (a decision taken in the
 * office woke nothing) passed every `ownerDecide` test there was. P8-15 (eighteen jobs for an idea the board had
 * not judged) passed every seeding test there was. R3's findings are the same shape again. Each was only visible
 * to somebody sitting in front of the office doing the next obvious thing — so that is what this does.
 *
 * **The rules it plays by.**
 * - Everything the owner does goes through the two ops the office sends: `chat` and `decide`. Nothing here
 *   flips an `approved:` flag or calls a heartbeat step directly. A test that edited the vault to move the story
 *   on would have proved the story and not the surfaces, which is precisely how D1 survived. The **one** raw
 *   write is promoting a sweep card with `decision: keep` (ruling W3-5): the Decisions sheet has no row for a
 *   card nobody has been asked about, so Obsidian is the surface, and the ruling's own instruction says so.
 * - Every assertion is something the owner could read: a note in the vault, a row in the snapshot, a file that
 *   exists. Nothing asserts on a cache file or an internal call.
 * - The model is `orgLlm` (`scripts/lib/org-llm.ts`), scripted for every prompt this journey reaches. Where a
 *   prompt had no answer it was given one there rather than here, so `scripts/test-kill9.ts` and the other
 *   suites that share the fixture reach the same company.
 *
 * **The cadence is off on purpose.** `maxElapsedHours`/`jobsCompletedN`/`startupAwayHours` are all out of reach
 * (as in `third-run-fixes.test.ts`), so every heartbeat in this vault is one the owner's own action asked for,
 * plus the ones `planUntilFannedOut` pokes for at the end. That is what makes "a heartbeat runs *because* the
 * owner decided" an assertion rather than a coincidence, and it keeps `board_decides_after_hours` from quietly
 * ruling on the plan verdict before the owner gets to.
 *
 * **Rulings in flight.** W3-1..W3-7 were implemented on other branches. W3-1, W3-3 and W3-7 are on this one and
 * are asserted outright; anything still in flight is feature-detected — the assertion takes the ruling's path when
 * the behaviour is there and the current path when it is not, and `inFlight` says at the end which it took, so a
 * green journey cannot quietly mean "it routed around the ruling".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  scaffoldVault, Vault, listJobs, listInbox, listStreams, listIdeas, findInboxById, parseNote, readJob,
  interviewPhase, ceoAnswersFrom, INTERVIEW_QUESTIONS, INTERVIEW_PATH, FOUNDER_BRIEF, BRAND_NAME_PATH,
  PRESSURE_TEST_SECTION, briefSectionBody, briefFromProposalBody, checkFounderBrief, briefCheckContext,
  readPressureVerdict, unkeptIdeasNamedIn, GATE_JOB_TYPES, checkPlan, planObjectives, readIdea,
  BOARD_IDEA_SOURCE, productFixes,
} from '@cubicle/core';
import {
  Daemon, defaultConfig, buildSnapshot, completeIdeaLines, FIRST_JOB_TITLES, WAITING_FOR_BRIEF,
  BOARD_DIALOGUE_ROUNDS, BOARD_DIALOGUE_MAX_CALLS, BOARD_QUESTIONS_TITLE_RE, BOARD_OPEN_QUESTIONS,
  type Snapshot,
} from '../src/index.js';
import { orgLlm, THREE_IDEAS, SIX_CEO_ANSWERS } from '../../../scripts/lib/org-llm.js';
import { letTheBoardDecide, planUntilFannedOut } from './helpers/board-switch.js';
import { noLocalModel } from './helpers/no-local-model.js';
import { TEST_MS, eventProgress, waitForProgress, loadScale } from './helpers/load.js';

const root = path.resolve(__dirname, '../../..');

/**
 * The whole journey's model budget.
 *
 * **Measured: 106 calls**, on 2026-09-13, for the whole story from "surprise me" to work on the board. Where they
 * go: act 1's surprise ask and self-interview; act 2's discovery job, the brief's board session (≤ 17), the
 * estimate, the idea's board session (≤ 17) and four standing-intelligence sweeps; act 3's plan and its
 * pre-mortem (≤ 17); act 4's two division plans, the work they queued and its gates.
 *
 * Pinned at 160 — a little over 1.5× — because the point of pinning it is to notice a *regression*: a step that
 * started re-asking, a session that stopped reusing its rounds, an interview asked twice. It is not meant to
 * fail the suite over one extra retry or one extra gate. A run that needs more than this is spending an owner's
 * free tier on something nobody asked for, and that is worth a red test.
 */
const CALL_BUDGET = 160;

/** The board's one unanswerable round in this journey, so exactly one question reaches the owner. */
const ASKS_THE_OWNER = 'Founder-Market Fit';
/** What the standing-intelligence sweeps file: a card the owner has never seen (ruling W3-5). */
const SWEEP_CARD = 'Publish the allergen matrix as a free tool';
/** The card the scripted discovery job files — the idea the owner actually picked, and the one the plan serves. */
const DISCOVERY_CARD = 'The idea the owner described';
/**
 * The plan chair's one business finding (ruling W3-2). Written in the `**Fix:**` spelling the third live run's
 * board actually used — not `fix by …` — because that is the spelling the company has to honour, and a fixture
 * that used the one the parser already knew would test the parser against itself.
 */
const PLAN_FIX = 'Demand: nobody has confirmed a single nursery buys food centrally. **Fix:** sell to the forty-site chain that already orders together, not to single sites';
/** The silence the transcript records where an advisor did not answer — `runBoardDialogue`'s own words. */
const NO_ANSWER = '(no answer: no model was available)';

let dir: string;
let disposed = false;
const daemons: Daemon[] = [];
const progress = eventProgress(() => dir);

beforeEach(async () => {
  disposed = false;
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-journey-'));
  const { vault } = await scaffoldVault(dir);
  // Nobody is at the keyboard for the *idea* verdict, and the board has to be allowed to rule on it or the plan
  // could never name a kept idea. The plan verdict is still the owner's: the note is filed and decided inside
  // the same second, long before this switch elapses on it.
  letTheBoardDecide(vault);
  noLocalModel(vault);
  vault.close();
});
afterEach(async () => {
  disposed = true;
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  await waitForProgress(pred, { progress, torn: () => disposed, what });
}

/** The office, as the owner has it: one socket, the snapshot it opens on, and the two ops the panels send. */
interface Office {
  seen: Record<string, unknown>[];
  chat(text: string): void;
  decide(id: string, d: { approved: boolean; chosen?: number; comment?: string; confirm?: boolean }): void;
  /** The next message matching `pred` that has not been read yet, so two ops in flight cannot read each other's. */
  next(pred: (m: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>>;
  close(): void;
}

async function openOffice(d: Daemon): Promise<Office> {
  const { token } = JSON.parse(readFileSync(path.join(dir, '.cubicle/daemon.json'), 'utf8')) as { token: string };
  const sock = new WebSocket(`ws://127.0.0.1:${d.config.port}?token=${token}`);
  const seen: Record<string, unknown>[] = [];
  sock.on('message', (m) => seen.push(JSON.parse(String(m))));
  await new Promise((r) => sock.once('open', r));
  let read = 0;
  const office: Office = {
    seen,
    chat: (text) => sock.send(JSON.stringify({ op: 'chat', text })),
    decide: (id, dec) => sock.send(JSON.stringify({ op: 'decide', id, ...dec })),
    async next(pred, what) {
      await waitFor(() => seen.slice(read).some(pred), what);
      const at = seen.slice(read).findIndex(pred);
      read += at + 1;
      return seen[read - 1];
    },
    close: () => sock.close(),
  };
  await office.next((m) => m.op === 'snapshot', 'the office to open');
  return office;
}

describe('the owner journey, end to end (three live runs\' worth of defects, in one story)', () => {
  it('goes surprise me → pick → brief → go → adopt → plan → approve → work, and the vault reads true at every step', async () => {
    const llm = orgLlm({
      vetoes: 0,                       // the board passes the plan first time: this journey is not about the veto
      surpriseIdeas: THREE_IDEAS,
      selfInterview: SIX_CEO_ANSWERS,
      // PIVOT REQUIRED, not WEAK: it is still the two-step adoption of ruling W3-3, and it is the one verdict
      // that also makes the board propose a different company — which is what ruling W3-2 is about.
      briefVerdict: 'PIVOT REQUIRED',
      boardAsksOwner: ASKS_THE_OWNER,
      ownerReplies: true,
      planKeptIdea: true,
      shipStream: null,                // the only stream this company has is the one its first cycle seeded
      intelligenceCard: SWEEP_CARD,
      planChairFix: PLAN_FIX,
      silentAdvisor: DISCOVERY_CARD,   // one advisor call on the idea session comes back empty
    });
    const d = new Daemon(
      defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, {
        port: 0, tickMs: 300, maxConcurrentJobs: 3,
        // Every heartbeat here is one somebody asked for. See the file header.
        heartbeat: { maxElapsedHours: 999, jobsCompletedN: Number.MAX_SAFE_INTEGER, startupAwayHours: 999 },
        providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml'),
      }),
      { llm, disableSleepWatch: true, disablePantry: true, memory: false, log: () => undefined, closeDbOnStop: false },
    );
    daemons.push(d);
    await d.start();
    const v = d.vault;
    const office = await openOffice(d);

    // --- what the owner can see, read the way the owner reads it -------------------------------------------
    const snapshot = (): Snapshot => buildSnapshot(v);
    const rows = (kind: string) => snapshot().inbox.filter((r) => r.kind === kind);
    const cabin = () => listInbox(v).filter((n) => n.data.kind === 'message');
    const ownerNotes = () => cabin().filter((n) => n.data.from === 'owner' && n.data.to === 'ceo');
    const ceoReplyTo = (title: string) => {
      const note = ownerNotes().find((n) => n.body.startsWith(`# ${title}`));
      return note ? (note.body.split(/^## CEO\s*$/m)[1] ?? '').trim() : '';
    };
    const jobsOf = (type: string) => listJobs(v).filter((j) => j.type === type);
    const heartbeats = () => jobsOf('ceo.heartbeat');
    const cycles = () => v.events.count('heartbeat.completed');
    const seeds = () => listJobs(v).filter((j) => FIRST_JOB_TITLES.includes(j.title as typeof FIRST_JOB_TITLES[number]));
    const boardNotes = (subject: 'brief' | 'idea' | 'plan') =>
      v.list('Meetings', { ext: '.md' }).map((rel) => ({ rel, ...v.readNoteOrNull(rel)! }))
        .filter((n) => n.data.room === 'board' && n.data.subject === subject);
    const brandName = () => String(parseNote(v.readTextOrNull(BRAND_NAME_PATH) ?? '').data.name ?? '');
    const brief = () => listInbox(v).filter((n) => n.data.kind === 'founder_brief');
    /** The note the owner rules on for one card — open or already closed, because the board closes these itself. */
    const ideaVerdictFor = (slug: string) => listInbox(v).find((n) => n.data.kind === 'idea_verdict' && n.data.target === `Ideas/${slug}.md`) ?? null;
    /**
     * Wait for something that needs another cycle, asking for one while we wait.
     *
     * The cadence is off in this vault so that every cycle is one somebody asked for — which is what makes the
     * "a decision wakes the company" assertions mean anything, and also means nothing else will ever turn the
     * funnel's crank. In a live company the six-hourly trigger does this; here the test does. `requestHeartbeat`
     * returns the open heartbeat instead of creating a second one, so asking repeatedly is safe.
     */
    const pokeUntil = async (pred: () => boolean, what: string): Promise<void> => {
      const poke = setInterval(() => { if (!pred()) d.requestHeartbeat(`waiting for ${what}`); }, 500);
      // Asking is itself a write, so the vault is never silent while this runs and the stall detector can never
      // fire — the same reason `planUntilFannedOut` carries its own ceiling. What a funnel that has stopped looks
      // like is the cards and the open jobs, so the failure says both rather than only that it waited.
      const deadline = Date.now() + 120_000 * loadScale();
      try {
        while (!pred()) {
          if (disposed) throw new Error('torn down while still waiting');
          if (Date.now() > deadline) {
            const cards = listIdeas(v).map((i) => `${i.id}[${i.source}/${i.decision}/score ${i.score}/board ${i.board_verdict}]`).join(' ');
            const open = listJobs(v).filter((j) => !['done', 'cancelled'].includes(j.status)).map((j) => `${j.type}=${j.status}`).join(' ');
            throw new Error(`waited for ${what}\n  ideas: ${cards}\n  open jobs: ${open}`);
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally { clearInterval(poke); }
    };
    /** A ruling still on another branch: the journey took the current path and says which. */
    const inFlight: string[] = [];

    /** One board session, read the way §3 promises it: a transcript in the open, six rounds, inside the budget. */
    const expectOneSession = (subject: 'brief' | 'idea' | 'plan', why: string) => {
      const notes = boardNotes(subject);
      expect(notes, `${why}: one ${subject} session, not ${notes.length}`).toHaveLength(1);
      const note = notes[0];
      expect(note.data.status).toBe('done');
      expect(note.data.facilitator).toBeTruthy();
      for (let r = 1; r <= BOARD_DIALOGUE_ROUNDS; r++) expect(note.body).toContain(`**Round ${r} — `);
      expect(Number(note.data.calls)).toBeGreaterThan(0);
      expect(Number(note.data.calls)).toBeLessThanOrEqual(BOARD_DIALOGUE_MAX_CALLS);
      return note;
    };

    // =======================================================================================================
    // Act 1 — "surprise me". The CEO answers in the cabin and files three whole ideas. Nothing else starts.
    // =======================================================================================================
    office.chat('surprise me');
    await office.next((m) => m.op === 'chat.ack', 'the cabin to take the message');
    await waitFor(() => ceoReplyTo('surprise me') !== '', 'the CEO to answer "surprise me"');

    const surpriseReply = ceoReplyTo('surprise me');
    // Ruling FR-2 / finding F1: three lines, all of them finished. The owner is picking from what is written.
    expect(completeIdeaLines(surpriseReply)).toHaveLength(3);
    for (const idea of THREE_IDEAS) expect(surpriseReply).toContain(idea);
    expect(ownerNotes()[0].data.answered).toBe(true);

    // …and the pick is a decision on the Decisions sheet, with three chips on it.
    await waitFor(() => rows('brand_change').length === 1, 'the three ideas as one decision');
    const pick = rows('brand_change')[0];
    expect(pick.options.map((o) => o.n)).toEqual([1, 2, 3]);
    expect(pick.decidable).toBe('choose');
    expect(pick.target).toBe(BRAND_NAME_PATH);
    expect(pick.pending).toBe(false);
    expect(pick.board_pending).toBe(false);

    // Nothing has been researched, planned, seeded or judged: the company is waiting for the owner (finding F3).
    await waitFor(() => cycles() === 1, 'the first cycle to finish');
    expect(jobsOf('discovery')).toEqual([]);
    expect(jobsOf('company.plan')).toEqual([]);
    expect(seeds()).toEqual([]);
    expect(listStreams(v)).toEqual([]);
    expect(boardNotes('brief')).toEqual([]);
    expect(boardNotes('idea')).toEqual([]);
    expect(boardNotes('plan')).toEqual([]);
    expect(v.readTextOrNull(FOUNDER_BRIEF)).toBeNull();
    // The one thing this cycle did say in the log, in the discovery step's own words.
    expect(readJob(v, heartbeats()[0].id)!.body).toContain('waiting for you to pick one of the three ideas');

    // The six questions are the CEO's own (ruling P8-13), and they go out on this cycle — the company asks
    // itself about the ideas it just proposed rather than asking the owner to answer for them.
    expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('asked');

    // =======================================================================================================
    // Act 2 — the owner picks idea 2 from the Decisions sheet (D1 / ruling P8-14).
    // =======================================================================================================
    office.decide(pick.id, { approved: true, chosen: 2 });
    await office.next((m) => m.op === 'decide.ack' && m.id === pick.id, 'the pick to be acknowledged');

    // The decision reaches Brand/name.md …
    await waitFor(() => brandName() === 'Tuckbox', 'idea 2 to become the company name');
    // … and wakes the company, which is the whole of D1: the same pick saved in Obsidian always did.
    await waitFor(() => heartbeats().some((j) => j.title === `Heartbeat (decided ${pick.id})`), 'the cycle the pick asked for');

    // The self-interview is in the owner's thread, six answers, every one tagged with what it rests on.
    const sixQuestions = cabin().find((n) => n.data.from !== 'owner' && INTERVIEW_QUESTIONS.every((q) => n.body.includes(q)))!;
    expect(sixQuestions, 'the CEO\'s own six answers in the cabin').toBeTruthy();
    const answers = ceoAnswersFrom(sixQuestions.body);
    expect(answers).toHaveLength(6);
    expect((sixQuestions.body.match(/^\*\*CEO:\*\* /gm) ?? [])).toHaveLength(6);
    // The tags are the whole point of ruling P8-13: they are what stops the founder brief citing the CEO's own
    // reading as the owner's word. Asserted exactly, so a parse that silently promoted one to a claim fails here.
    expect(answers.map((a) => a.tag)).toEqual(['from the idea', 'from the idea', 'unstated', 'from the idea', 'unstated', 'unstated']);

    // The research office reads the pick, and the board finishes the brief before the owner is asked anything.
    await waitFor(() => jobsOf('discovery').length === 1, 'the discovery job the pick bought');
    const discovery = jobsOf('discovery')[0];
    await waitFor(() => readJob(v, discovery.id)!.data.status === 'done', 'the discovery job to finish');
    await waitFor(() => brief().length > 0, 'the founder brief proposal');
    await waitFor(() => brief()[0].data.board_pending === false, 'the board to finish the brief');

    // Ruling W3-4: **one** open founder_brief for that job, whatever the author did.
    expect(brief()).toHaveLength(1);
    const briefNote = brief()[0];
    expect(briefNote.data.job).toBe(discovery.id);
    expect(briefNote.data.approved).toBeNull();
    // `board_pending` was set by `proposal.create` and is only ever written `false` by the session that cleared
    // it, so an explicit `false` here is the proof that the flag went on and came off (ruling P8-6).
    expect(briefNote.data.board_pending).toBe(false);

    const session = expectOneSession('brief', 'the brief the owner is about to adopt');
    const draft = briefFromProposalBody(briefNote.body);
    const pressure = briefSectionBody(draft, PRESSURE_TEST_SECTION);
    // The board's own round findings are the brief's pressure test, and it ends on a verdict word.
    expect(pressure).toContain('Nurseries will pay 40 a week to stop planning meals.');
    expect(pressure).toContain(session.rel.replace(/\.md$/, ''));
    expect(readPressureVerdict(pressure)).toMatchObject({ ok: true, verdict: 'PIVOT REQUIRED' });
    // …and it passes the check that refused the first live run's beautiful, false brief.
    expect(checkFounderBrief(v, draft, briefCheckContext(v))).toMatchObject({ ok: true, findings: [] });

    // The one round the material could not answer is one question, in one cabin message, and it is on the note.
    const asked = cabin().filter((n) => BOARD_QUESTIONS_TITLE_RE.test(n.body));
    expect(asked, 'exactly one "the board needs N answers from you"').toHaveLength(1);
    expect(briefNote.body).toContain(BOARD_OPEN_QUESTIONS);

    // Still nothing planned, nothing seeded: every plan waits for the brief (rulings S-1, P8-15).
    await waitFor(() => cycles() === 2, 'the pick\'s cycle to finish');
    expect(jobsOf('company.plan')).toEqual([]);
    expect(jobsOf('board.premortem')).toEqual([]);
    expect(seeds()).toEqual([]);
    expect(listStreams(v)).toEqual([]);
    expect(readJob(v, heartbeats().at(-1)!.id)!.body).toContain(WAITING_FOR_BRIEF);

    // The board sat on the idea the owner picked, and on nothing else: a card the sweeps found is the company's
    // own reading, not the owner's, and it must not be judged unpromoted (ruling W3-5).
    const judged = boardNotes('idea').map((n) => String(n.data.title));
    expect(judged).toContain(DISCOVERY_CARD);
    expect(judged).not.toContain(SWEEP_CARD);

    // Ruling W3-2, the brief half: a board that says PIVOT REQUIRED has proposed a *different company*, and the
    // company's answer is a card the owner rules on — never a brief, a plan or a name that quietly becomes it.
    const pivots = () => listIdeas(v).filter((i) => i.source === BOARD_IDEA_SOURCE);
    expect(pivots(), 'the chair\'s pivot on the brief, as one candidate card').toHaveLength(1);
    const briefPivot = pivots()[0];
    expect(briefPivot.evidence, 'the pivot cites the argument it came out of').toContain(session.rel);
    expect(briefPivot.decision).toBe('undecided');
    expect(readIdea(v, briefPivot.id)!.body).toContain('Nothing is planned against this until you keep it.');
    // …and the brief itself still describes the company the owner picked. The pivot is an offer, not an edit.
    expect(draft).toContain('Meal kits for nurseries');

    // The failure this journey injects: one advisor turn on the idea session came back with nothing at all.
    // The session has to survive it — the owner's idea does not stop being judged because one model call was
    // empty — and the transcript has to *say* so rather than close the gap with something nobody said.
    const ideaSession = boardNotes('idea').find((n) => n.data.title === DISCOVERY_CARD)!;
    expect(ideaSession.body, 'the transcript records the silence instead of inventing a turn').toContain(NO_ANSWER);
    expect(Number(ideaSession.data.calls)).toBeLessThanOrEqual(BOARD_DIALOGUE_MAX_CALLS);
    expect(ideaSession.data.status).toBe('done');
    for (let r = 1; r <= BOARD_DIALOGUE_ROUNDS; r++) expect(ideaSession.body).toContain(`**Round ${r} — `);
    // Two advisors and a chair sat; one call of theirs was lost, so the board is not "unreviewed" either.
    expect(v.events.query({ types: ['daemon.warning'] }).filter((e) => e.payload.where === 'ideas_board' && /nobody|no advisor/i.test(String(e.payload.reason ?? ''))))
      .toEqual([]);
    // If a retry ever lands, the transcript says so and this asserts it instead of the silence above.
    if (/asked again|retried/i.test(ideaSession.body)) expect(ideaSession.body).toMatch(/asked again|retried/i);
    else inFlight.push('an advisor whose call comes back empty is not asked again; the transcript records the silence');

    // The owner is asked about the pivot like any other candidate: it is researched, priced and put to the board
    // on its own turn, and what reaches them is an `idea_verdict` note — not a plan that changed underneath them.
    // Poking for cycles is what the six-hourly trigger does in a live company; the cadence is off here so that
    // every other cycle in this vault is one the owner asked for.
    await pokeUntil(() => !!readIdea(v, briefPivot.id)?.data.board_verdict, 'the board to sit on the chair\'s pivot');
    await pokeUntil(() => !!ideaVerdictFor(briefPivot.id), 'the pivot\'s verdict to reach the owner');
    expect(boardNotes('idea').filter((n) => n.data.title === briefPivot.title), 'one session on the pivot').toHaveLength(1);

    // Ruling W3-5's other half: a card nobody asked for becomes a candidate the moment the owner says so. They
    // promote it the way the brief tells them to — `decision: keep` on the card, in Obsidian — which is a write
    // the daemon never made, and the only owner surface there is for this (the Decisions sheet has no row for a
    // card nobody has been asked about; that is the whole point of the ruling).
    const sweep = listIdeas(v).find((i) => i.title === SWEEP_CARD)!;
    expect(sweep.source.startsWith('intelligence'), 'the sweep filed it, not the owner').toBe(true);
    expect(sweep.board_verdict, 'and the board had not touched it').toBeNull();
    const sweepAbs = path.join(dir, `Ideas/${sweep.id}.md`);
    writeFileSync(sweepAbs, readFileSync(sweepAbs, 'utf8').replace(/^decision: .*$/m, 'decision: keep'));
    expect(readIdea(v, sweep.id)!.data.decision).toBe('keep');

    await pokeUntil(() => !!readIdea(v, sweep.id)?.data.board_verdict, 'the board to sit on the promoted sweep card');
    await pokeUntil(() => !!ideaVerdictFor(sweep.id), 'the promoted card\'s verdict to reach the owner');
    expect(boardNotes('idea').filter((n) => n.data.title === SWEEP_CARD), 'one session on the promoted card').toHaveLength(1);

    // =======================================================================================================
    // Act 3 — the owner reads the six answers and says "go", then adopts the brief.
    // =======================================================================================================
    const cyclesBeforeGo = cycles();
    office.chat('go');
    await office.next((m) => m.op === 'chat.ack', 'the cabin to take "go"');
    await waitFor(() => /^## Endorsed\b/m.test(v.readText(INTERVIEW_PATH)), 'the interview to be endorsed');
    expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('answered');
    await waitFor(() => cycles() > cyclesBeforeGo, 'the cycle "go" asked for');

    // Ruling W3-3: the board called this brief WEAK, so "Adopt" is "Adopt anyway" and the op must carry `confirm`.
    expect(snapshot().inbox.find((r) => r.id === briefNote.data.id)!.decidable).toBe('adopt');
    const briefRow = snapshot().inbox.find((r) => r.id === briefNote.data.id)!;
    expect(briefRow.verdict, 'the row carries the verdict the owner would be overruling').toBe('PIVOT REQUIRED');
    expect(briefRow.needs_confirm).toBe(true);
    office.decide(briefNote.data.id, { approved: true });
    const answer = await office.next((m) => (m.op === 'error' && m.id === briefNote.data.id) || (m.op === 'decide.ack' && m.id === briefNote.data.id), 'the daemon to answer the adoption');
    expect(answer.op, 'an adoption without `confirm` is refused, not applied').toBe('error');
    expect(String(answer.message)).toMatch(/confirm|WEAK|anyway/i);
    expect(findInboxById(v, briefNote.data.id)!.data.approved, 'a refused adoption changes nothing').toBeNull();
    office.decide(briefNote.data.id, { approved: true, confirm: true });
    await office.next((m) => m.op === 'decide.ack' && m.id === briefNote.data.id, 'the confirmed adoption');

    await waitFor(() => (v.readTextOrNull(FOUNDER_BRIEF) ?? '').trim().length > 0, 'the brief to be adopted');
    expect(v.readText(FOUNDER_BRIEF)).toContain(PRESSURE_TEST_SECTION);

    // Ruling W3-7: the interview is over — the brief supersedes it — and the CEO stops inviting a "go".
    await waitFor(() => /^## Superseded\b/m.test(v.readText(INTERVIEW_PATH)), 'the interview to be superseded by the brief');
    expect(interviewPhase(v.readTextOrNull(INTERVIEW_PATH))).toBe('superseded');

    // The next cycle plans, and it is the first cycle that may.
    // The plan is written once, and against the ideas the owner kept: a rewrite here would mean the guard or the
    // board sent it back, and neither should on this journey.
    await waitFor(() => jobsOf('company.plan').length === 1, 'the company plan');
    await waitFor(() => jobsOf('company.plan').every((j) => ['done', 'failed', 'cancelled'].includes(j.status)), 'the plan to be written');
    await waitFor(() => rows('plan_verdict').length === 1, 'the plan verdict the owner rules on');

    const plan = v.readText('Plans/plan.md');
    const kept = listIdeas(v).filter((i) => i.decision === 'keep').map((i) => i.id);
    expect(kept.length, 'the board kept the idea the owner picked').toBeGreaterThan(0);
    // Ruling W3-1, read with the company's own parser and the company's own validator rather than a second idea
    // of what an objective is: `planObjectives` knows that the bullets the division leads append are job links
    // and not objectives, and `checkPlan` is what the heartbeat actually holds the CEO to before the board sits.
    const objectives = planObjectives(plan);
    expect(objectives.length, 'the plan has objectives').toBeGreaterThan(0);
    for (const o of objectives) expect(o.idea, `objective "${o.text}" names the kept idea it serves`).not.toBeNull();
    for (const o of objectives) expect(kept).toContain(o.idea);
    expect(checkPlan(v, plan), 'the plan the board is about to sit on passes the validator').toMatchObject({ ok: true, findings: [] });
    expect(unkeptIdeasNamedIn(plan, listIdeas(v))).toEqual([]);
    // The idea the *owner* picked, and not the pivot the board would rather the company sold.
    const discoveryIdea = listIdeas(v).find((i) => i.title === DISCOVERY_CARD)!;
    for (const o of objectives) expect(o.idea, 'the plan serves the owner\'s idea, not the board\'s').toBe(discoveryIdea.id);

    const premortem = expectOneSession('plan', 'the pre-mortem on this cycle\'s plan');

    // Ruling W3-2, the plan half. The board found something about the *business* and said how to fix it. That is
    // the third live run's defect in one line: the CEO "aligned the plan with the board's recommendations" and by
    // the next cycle the company was selling something else, with nobody asked. So the plan on disk must still be
    // exactly what the CEO wrote and what the owner is about to approve — and the fix must become a card instead.
    expect(v.readText('Plans/plan.md'), 'the board did not rewrite the plan').toBe(plan);
    const planPivot = listIdeas(v).find((i) => i.source === BOARD_IDEA_SOURCE && i.evidence.includes(premortem.rel));
    if (planPivot) {
      expect(planPivot.decision, 'the pivot is the owner\'s to keep, not the plan\'s to become').toBe('undecided');
      expect(readIdea(v, planPivot.id)!.body).toContain('forty-site chain');
      await pokeUntil(() => !!ideaVerdictFor(planPivot.id), 'the plan pivot\'s verdict to reach the owner');
    } else {
      // `productFixes` reads `… fix by <what to do instead>` and not yet the `**Fix:**` spelling the live run's
      // board actually used, so the chair's business fix is still only a finding on the plan verdict note. It is
      // on the owner's screen either way — this asserts that much — and becomes a card once the spelling lands.
      expect(productFixes([PLAN_FIX]), 'the fix the chair wrote is not read as a pivot yet').toEqual([]);
      expect(findInboxById(v, rows('plan_verdict')[0].id)!.body).toContain('forty-site chain');
      inFlight.push('W3-2 (`**Fix:**` spelling): a business fix written that way is not yet filed as a pivot card');
    }

    // The first jobs and the first stream arrive on the first heartbeat after adoption, and never again (P8-15).
    await waitFor(() => seeds().length === 3, 'the three first jobs');
    expect(listStreams(v)).toHaveLength(1);
    const stream = listStreams(v)[0].slug;
    expect(seeds().every((j) => j.stream === stream)).toBe(true);
    const planningCycle = cycles();

    // =======================================================================================================
    // Act 4 — the owner approves the plan, and the divisions plan against it.
    // =======================================================================================================
    const verdict = rows('plan_verdict')[0];
    office.decide(verdict.id, { approved: true });
    await office.next((m) => m.op === 'decide.ack' && m.id === verdict.id, 'the plan approval');
    await waitFor(() => findInboxById(v, verdict.id)!.data.approved === true, 'the approval to land on the note');
    // The owner ruled, not the clock: `board_decides_after_hours` never got to stand in for them here.
    expect((findInboxById(v, verdict.id)!.data as { approved_by?: string }).approved_by).toBe('owner');

    await planUntilFannedOut(d, v, 2);
    expect(jobsOf('division.plan').map((j) => j.assigned).sort()).toEqual(['cfo', 'cto']);
    // Work the leads queued, on the stream this company has.
    const scheduled = listJobs(v).filter((j) => j.type === 'engineer.ship' && !seeds().some((s) => s.id === j.id));
    expect(scheduled.length, 'the CTO scheduled work').toBeGreaterThan(0);
    expect(scheduled.every((j) => j.stream === stream)).toBe(true);

    // And nothing seeded a second time, however many cycles have run since.
    expect(cycles()).toBeGreaterThan(planningCycle);
    expect(seeds()).toHaveLength(3);
    expect(listStreams(v)).toHaveLength(1);

    // At least one gate review ran — the company reviews its own work (§3), starting with the discovery job's.
    const gates = listJobs(v).filter((j) => GATE_JOB_TYPES.includes(j.type));
    expect(gates.length, 'a gate review ran').toBeGreaterThan(0);
    expect(gates.some((j) => j.status === 'done'), 'a gate review finished').toBe(true);

    // The one document the owner actually reads says what happened and what needs them.
    const runs = v.list('Runs', { ext: '.md' }).sort();
    const run = v.readText(runs.at(-1)!);
    expect(run).toContain('## What happened');
    expect(run).toContain('## What needs you');
    expect(run).toContain('## Next action per team');
    // …and the facts the CEO was given to write it from — the daemon's own lines, not the model's — say what the
    // cycle did and what is waiting on the owner. A brief whose "What needs you" was drafted out of nothing is
    // exactly what the second live run's owner read.
    const facts = run.split('_Facts used:_')[1] ?? '';
    expect(facts).toMatch(/^Finished jobs: .+$/m);
    expect(facts).toMatch(/^Queued next: .+$/m);
    expect(facts).toMatch(/^Needs owner: .+$/m);
    expect(facts).not.toMatch(/^Needs owner: nothing$/m);
    expect(facts).toContain(`Plan: ${plan.slice(0, 40)}`);

    // Every conversation the company has had, in the Messages view: the cabin, and the board arguing in the open.
    const threads = snapshot().conversations;
    expect(threads.some((t) => t.kind === 'dm' && t.id === 'dm:owner-ceo')).toBe(true);
    expect(threads.filter((t) => t.kind === 'board').length).toBeGreaterThanOrEqual(3);   // brief, idea, plan
    // Pantry is off in this run (a coffee between two idle people is not deterministic enough to pin a budget
    // against), so there is nothing to assert but the shape: if one ever ran, it is a thread like any other.
    for (const t of threads.filter((t) => t.kind === 'pantry')) expect(t.turns).toBeGreaterThan(0);

    // =======================================================================================================
    // Act 4b — "what's happening?" (ruling W3-6).
    //
    // The third live run's owner typed "WhAtS hppening rn?" and got three paragraphs about governance teams
    // monitoring compliance protocols, followed by the founder interview's "just go" line. So: the typo verbatim,
    // and the answer has to be the company's own facts and nothing else.
    // =======================================================================================================
    const STATUS_ASK = 'WhAtS hppening rn?';
    office.chat(STATUS_ASK);
    await office.next((m) => m.op === 'chat.ack', 'the cabin to take the status question');
    await waitFor(() => ceoReplyTo(STATUS_ASK) !== '', 'the CEO to say what is happening');
    const status = ceoReplyTo(STATUS_ASK);

    // What it must say: the verdict on the brief the whole company is planning against, and the work that plan
    // actually names. Both are facts `statusFacts` reads off the vault; neither was in the live run's answer.
    expect(status, 'the answer names the board\'s verdict on the brief').toContain('PIVOT REQUIRED');
    const firstObjective = planObjectives(v.readText('Plans/plan.md'))[0];
    expect(status, 'the answer names what the plan is actually doing').toContain(firstObjective.text.split(/\s+—\s+|\n/)[0].slice(0, 30));
    // What it must not be: an essay, a request, or a date nobody has. `1970` is the epoch a missing timestamp
    // falls back to, and an owner told their brief was adopted in 1970 has been told something false.
    const statusLines = status.split('\n').filter((l) => l.trim());
    expect(statusLines.length, `five lines at most, not ${statusLines.length}`).toBeLessThanOrEqual(5);
    expect(statusLines.length, 'and not one line of nothing').toBeGreaterThanOrEqual(3);
    expect(status).not.toMatch(/just "?go"?|say go/i);
    expect(status).not.toContain('1970');
    expect(status.length, 'a status answer is read at a glance').toBeLessThan(1200);

    // =======================================================================================================
    // Act 5 — the story, read across the whole run.
    // =======================================================================================================
    // No proposal was filed twice for one job. This is ruling W3-4 generalised: a second note for the same job,
    // kind and target is a decision the owner has to take twice, and it is how the live run's owner ended up
    // with two briefs for one reading.
    const byJob = new Map<string, string[]>();
    for (const n of listInbox(v).filter((n) => n.data.kind !== 'message')) {
      const key = `${n.data.job ?? ''}|${n.data.kind}|${n.data.target ?? ''}`;
      byJob.set(key, [...(byJob.get(key) ?? []), n.path]);
    }
    for (const [key, paths] of byJob) expect(paths, `two notes for ${key}`).toHaveLength(1);

    // The owner's own decisions are never forgeries. `ownerDecide` writes as the owner and the dispatcher's sha
    // guard has to honour that, or every click in the office is refused as a system write pretending to be a
    // flip (SP8 §1). A refusal about a *decision* names the note in `payload.proposal`; a tool guardrail names
    // the tool instead, and one of those is expected here — an `engineer.ship` on a stream whose pipeline nobody
    // has written yet cannot ship, which is §17 working.
    const refusedDecisions = v.events.query({ types: ['guardrail.blocked'] })
      .filter((e) => !!(e.payload as { proposal?: string }).proposal)
      .map((e) => `${(e.payload as { proposal?: string }).proposal}: ${String((e.payload as { reason?: string }).reason)}`);
    expect(refusedDecisions).toEqual([]);
    // …and every decision the owner took really was applied.
    for (const id of [pick.id, briefNote.data.id, verdict.id]) {
      expect(findInboxById(v, id)!.data.resolved_at, `decision ${id} was never resolved`).toBeTruthy();
      expect((findInboxById(v, id)!.data as { refused?: string }).refused ?? '').toBe('');
    }

    // Every reply the CEO gave the owner is something they can read on a phone …
    const replies = ownerNotes().map((n) => (n.body.split(/^## CEO\s*$/m)[1] ?? '').trim()).filter(Boolean);
    expect(replies.length).toBeGreaterThanOrEqual(2);
    for (const r of replies) expect(r.length, `a reply of ${r.length} chars`).toBeLessThan(1200);
    // … and once the interview is closed, nothing asks them to say "go" again (ruling W3-7).
    expect(ceoReplyTo('go')).not.toMatch(/just "?go"?|say go/i);

    // Every idea the board ever sat on was one the owner had seen: their own pick, the board's own pivot out of
    // an argument they were shown, or the sweep card they promoted themselves. Nothing else (ruling W3-5).
    const seen = new Set(listIdeas(v).filter((i) => i.source !== 'intelligence' || i.decision === 'keep').map((i) => i.title));
    for (const n of boardNotes('idea')) expect([...seen], `the board sat on "${n.data.title}"`).toContain(String(n.data.title));

    // The budget, measured and pinned, and said out loud on the way past: a journey whose cost nobody reads is a
    // budget that drifts a call at a time until the pin is the only thing holding it. See CALL_BUDGET.
    const calls = Object.values(llm.calls).reduce((a, b) => a + b, 0);
    process.stdout.write(`\njourney: ${calls} model calls (budget ${CALL_BUDGET})\n`);
    expect(calls, `the journey spent ${calls} model calls`).toBeLessThan(CALL_BUDGET);
    expect(calls, 'a journey that spends nothing has not happened').toBeGreaterThan(20);

    // Straight to the stream rather than through `console` (which the reporter keeps to itself on a passing
    // file): what this run had to take the pre-ruling path for. A reviewer reading a green journey needs to know
    // whether it was green because the rulings landed or because it routed around them.
    if (inFlight.length) process.stdout.write(`journey: not on this branch yet — ${inFlight.join('; ')}\n`);

    office.close();
  }, TEST_MS);

  // W3-1, W3-3 and W3-7 are on this branch, so the case above asserts them outright rather than feature-detecting
  // them: `checkPlan` and `planObjectives` read the plan, the unconfirmed adoption is refused, and the interview
  // reads superseded. `inFlight` stays for whatever ruling lands next.
});
