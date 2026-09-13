import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, listJobs, listInbox, readJob, updateJob, createProposal, createJob,
  BRAND_NAME_PATH, DISCOVERY_INBOX, FOUNDER_BRIEF, PROPOSED_CONTENT_FENCE, ownerPick, createStream, listStreams,
} from '@cubicle/core';
import { ToolRegistry, parseToolsConfig, phase3Tools } from '@cubicle/tools';
import type { Llm } from '@cubicle/harness';
import { Daemon, defaultConfig, runHeartbeat, createHeartbeatJob, dispatchProposals, answerRejectedBrief, inboxEditWakesHeartbeat, ownerEditAsksForWork, soleStreamForShip, WAITING_FOR_BRIEF, HEARTBEAT_STEPS } from '../src/index.js';
import { hasApprovedBrief, briefRejectionComment, rejectionAsksForNewIdea, REJECTED_BRIEF_LABEL, rejectionDiscoveryJobId } from '../src/discovery.js';
import { adoptFounderBrief, ADOPTED_BRIEF } from './helpers/brief.js';
import { noLocalModel } from './helpers/no-local-model.js';

/**
 * The second live run's defects, each pinned by what the owner saw (ledger
 * `sdd/2026-09-13-second-run-fixes/progress.md`):
 *
 * S-1 the company wrote a plan two seconds after "surprise me" — before any brief existed — and wrote another
 *     one after the owner had rejected the brief it did eventually produce.
 * S-2 the owner's rejection comment ("rejected make it better or get a new idea") was never read, never
 *     answered and never acted on: the note was closed as "rejected" and that was the whole of it.
 * S-4 four heartbeats in twenty minutes, one per Obsidian save of a proposal, each one re-planning; the day's
 *     free strong tier was gone by mid-morning. Every one of those saves was an approval.
 */

const root = path.resolve(__dirname, '../../..');
let dir: string; let vault: Vault;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-second-run-'));
  vault = (await scaffoldVault(dir)).vault;
  noLocalModel(vault);
});
afterEach(() => { try { vault.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

/** A model that answers by what it was asked, and records every prompt. No test here depends on its prose. */
function scriptedLlm(answer: (prompt: string) => string = () => 'Noted.'): Llm & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async chat(_req, chat) {
      const user = String(chat.messages.at(-1)?.content ?? '');
      prompts.push(user);
      return { content: answer(user), toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium' as const, downgraded: false, parsedToolCalls: [] };
    },
    promptBudget: () => 6000,
  };
}

/** Three whole ideas for the surprise ask, and one line for anything else. */
const THREE_IDEAS = '1. CrateMate — weekly allergen-checked meal kits for nurseries.\n2. Roomly — a booking sheet for village halls.\n3. Tallyhouse — a stock count app for corner shops.';
const surpriseAwareLlm = () => scriptedLlm((p) => (/surprise them/i.test(p) ? THREE_IDEAS : 'Understood; here is what we will do.'));

/** The owner picking one of the CEO's three ideas: the `brand_change` shape `ownerPick` reads. */
function pickAnIdea(v: Vault): string {
  const { path: rel } = createProposal(v, {
    kind: 'brand_change', from: 'ceo', target: BRAND_NAME_PATH, title: 'Three company ideas — pick one',
    body: `${THREE_IDEAS}\n\nSet \`chosen: 1|2|3\` and \`approved: true\`; the chosen line's name becomes the company name.`,
  }, 'ceo');
  v.updateNote(rel, (n) => ({ data: { ...n.data, approved: true, chosen: 1 }, body: n.body }), 'owner');
  return rel;
}

/** One heartbeat from `gather`, exactly as the daemon runs it. */
const cycle = (v: Vault, llm: Llm, hb = createHeartbeatJob(v, 'test')) =>
  runHeartbeat({ vault: v, llm, env: {}, now: () => new Date() }, hb).then((out) => ({ hb, out }));

const stepOf = (v: Vault, hb: string) => HEARTBEAT_STEPS[readJob(v, hb)!.data.checkpoint_step as number];
const planJobs = (v: Vault) => listJobs(v).filter((j) => j.type === 'company.plan');
const discoveryJobs = (v: Vault) => listJobs(v).filter((j) => j.type === 'discovery');

describe('S-1: nothing is planned before the owner has adopted a founder brief', () => {
  it('hasApprovedBrief is false on a fresh vault and true once the brief is on disk', () => {
    expect(hasApprovedBrief(vault)).toBe(false);
    vault.writeText(FOUNDER_BRIEF, '   \n', 'daemon');
    expect(hasApprovedBrief(vault)).toBe(false);   // an empty file is not a brief
    adoptFounderBrief(vault);
    expect(hasApprovedBrief(vault)).toBe(true);
  });

  it('a cycle on a picked idea finishes every step and queues no plan, and says why', async () => {
    const v = Vault.open(dir);
    try {
      const picked = pickAnIdea(v);
      expect(ownerPick(v)).not.toBeNull();

      // Cycle one reads the pick: it blocks on the discovery job, exactly as it should.
      const first = await cycle(v, scriptedLlm());
      expect(first.out.status).toBe('blocked');
      expect(discoveryJobs(v)).toHaveLength(1);

      // The research office is still reading — it has filed no brief — and the cycle resumes anyway (the job
      // finished without proposing one, which is the live run's own shape). Nothing may be planned off that.
      updateJob(v, discoveryJobs(v)[0].id, { status: 'done' }, 'research_manager');
      await cycle(v, scriptedLlm(), first.hb);

      expect(hasApprovedBrief(v)).toBe(false);
      expect(planJobs(v)).toHaveLength(0);
      expect(listJobs(v).some((j) => j.type === 'division.plan')).toBe(false);
      expect(listJobs(v).some((j) => j.type === 'board.premortem')).toBe(false);
      expect(listInbox(v).some((n) => n.data.kind === 'plan_verdict')).toBe(false);
      // …and the cycle ran to the end rather than stalling: the brief and the commit are the last two steps.
      expect(stepOf(v, first.hb)).toBeUndefined();
      const log = readJob(v, first.hb)!.body;
      expect(log).toContain(WAITING_FOR_BRIEF);
      // All four planning steps said it, not just the first.
      expect(log.match(new RegExp(WAITING_FOR_BRIEF, 'g'))).toHaveLength(4);

      // And the owner is told, in the one document they read.
      const run = readFileSync(path.join(dir, v.list('Runs', { ext: '.md' }).sort().at(-1)!), 'utf8');
      expect(run).toContain('Nothing is planned until a founder brief is adopted');
      expect(run).toContain('Planning: waiting for the founder brief');
      expect(picked).toBeTruthy();
    } finally { v.close(); }
  }, 60_000);

  it('the very next cycle plans once the brief has been adopted', async () => {
    const v = Vault.open(dir);
    try {
      pickAnIdea(v);
      const first = await cycle(v, scriptedLlm());
      updateJob(v, discoveryJobs(v)[0].id, { status: 'done' }, 'research_manager');
      await cycle(v, scriptedLlm(), first.hb);
      expect(planJobs(v)).toHaveLength(0);

      // The owner approves the brief; the dispatcher writes it. Nothing else about the vault changes.
      adoptFounderBrief(v);
      const next = await cycle(v, scriptedLlm());
      expect(next.out).toMatchObject({ status: 'blocked' });
      expect(planJobs(v)).toHaveLength(1);
      expect(readJob(v, next.hb)!.body).not.toContain(WAITING_FOR_BRIEF);
    } finally { v.close(); }
  }, 60_000);

  it('the What-needs-you row names the open brief proposal rather than repeating it', async () => {
    const v = Vault.open(dir);
    try {
      v.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries. Two already pay us.', 'owner');
      const first = await cycle(v, scriptedLlm());
      const disc = discoveryJobs(v)[0].id;
      // The research office did its job: a brief is waiting for the owner's verdict.
      createProposal(v, {
        kind: 'founder_brief', from: 'research_manager', target: FOUNDER_BRIEF, title: 'What I understood',
        body: `## Proposed content\n\n${PROPOSED_CONTENT_FENCE}\n${ADOPTED_BRIEF}${PROPOSED_CONTENT_FENCE}\n`,
      }, 'research_manager');
      updateJob(v, disc, { status: 'done' }, 'research_manager');
      await cycle(v, scriptedLlm(), first.hb);

      const run = readFileSync(path.join(dir, v.list('Runs', { ext: '.md' }).sort().at(-1)!), 'utf8');
      expect(run).toContain('Approve or reject: What I understood');
      expect(run).not.toContain('Nothing is planned until a founder brief is adopted');
      expect(planJobs(v)).toHaveLength(0);
    } finally { v.close(); }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------

/** The raw-file edit the dispatcher reads as the owner's own (`isOwnerChanged` compares shas). */
const ownerEdit = (rel: string, f: (t: string) => string) => writeFileSync(path.join(dir, rel), f(readFileSync(path.join(dir, rel), 'utf8')));

const toolsConfig = parseToolsConfig('tools: {}\n');
const dispatcherDeps = (llm: Llm) => ({
  vault, registry: new ToolRegistry().registerAll(phase3Tools()), toolsConfig,
  scheduler: { enqueue: () => 'job_x' }, env: {} as NodeJS.ProcessEnv,
  onBriefRejected: (note: Parameters<typeof answerRejectedBrief>[1], ctx: Parameters<typeof answerRejectedBrief>[2]) =>
    answerRejectedBrief({ vault, llm, env: {} }, note, ctx).then(() => undefined),
});

/** File a founder brief the owner then turns down, with `comment` typed into the note body. */
function rejectABrief(comment: string): string {
  const { path: rel } = createProposal(vault, {
    kind: 'founder_brief', from: 'research_manager', target: FOUNDER_BRIEF, title: 'What I understood',
    body: `This is what I understood from what you gave me. It becomes \`${FOUNDER_BRIEF}\`, and every plan is written against it, so it is worth reading closely — edit the block below if I got anything wrong.\n\n**Read from:**\n- Discovery/inbox/pitch.md\n\n## Proposed content\n\n${PROPOSED_CONTENT_FENCE}\n${ADOPTED_BRIEF}${PROPOSED_CONTENT_FENCE}\n\nSet \`approved: true\` to adopt it, or edit the block first. Set \`approved: false\` and I will ask again next cycle.\n`,
  }, 'research_manager');
  ownerEdit(rel, (t) => t.replace(/^approved: .*$/m, 'approved: false').trimEnd() + `\n\n${comment}\n`);
  return rel;
}

describe('S-2: a rejected founder brief is an instruction, not a closed note', () => {
  it('reads the comment out of the note body, the owner comments and the frontmatter', () => {
    expect(briefRejectionComment({ data: {}, body: `# What I understood\n\nThis is what I understood from what you gave me. It becomes \`x\`.\n\n**Read from:**\n- a.md\n\n## Proposed content\n\n${PROPOSED_CONTENT_FENCE}\n## What the company is\n\nMeal kits.\n${PROPOSED_CONTENT_FENCE}\n\nSet \`approved: true\` to adopt it.\n\nrejected make it better or get a new idea\n` }))
      .toBe('rejected make it better or get a new idea');
    expect(briefRejectionComment({ data: { why: 'too vague' }, body: '# t\n\n%%cubicle: and no pressure test%%\n' }))
      .toBe('too vague and no pressure test');
    expect(briefRejectionComment({ data: {}, body: '# t\n' })).toBe('');
  });

  it('"make it better" alone is not a request for a different idea; "get a new idea" is', () => {
    expect(rejectionAsksForNewIdea('make it better')).toBe(false);
    expect(rejectionAsksForNewIdea('rejected make it better or get a new idea')).toBe(true);
    expect(rejectionAsksForNewIdea('surprise me again')).toBe(true);
    expect(rejectionAsksForNewIdea('try a different idea')).toBe(true);
  });

  it('answers the owner, re-runs discovery on what they said, and plans nothing', async () => {
    const comment = 'rejected make it better or get a new idea';
    const rel = rejectABrief(comment);
    const llm = surpriseAwareLlm();

    expect(await dispatchProposals(dispatcherDeps(llm))).toBeGreaterThan(0);

    // (b) one new discovery job, carrying the owner's words and the brief they turned down.
    const disc = discoveryJobs(vault);
    expect(disc).toHaveLength(1);
    const goal = readJob(vault, disc[0].id)!.body;
    expect(goal).toContain(REJECTED_BRIEF_LABEL);
    expect(goal).toContain(comment);
    expect(goal).toContain('## What the company is');   // the rejected brief, as material

    // (a) one message from the CEO to the owner, and — because they asked for a different idea — three of them.
    const messages = listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.to === 'owner');
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain('CrateMate');
    const trio = listInbox(vault).filter((n) => n.data.kind === 'brand_change' && /Three company ideas/.test(String(n.data.title ?? n.body)));
    expect(trio).toHaveLength(1);

    // (c) nothing was planned, and the brief was not written.
    expect(planJobs(vault)).toHaveLength(0);
    expect(hasApprovedBrief(vault)).toBe(false);
    // The note is closed, and says what happened rather than just "rejected".
    const closed = vault.readNoteOrNull(rel)!;
    expect(closed.data.resolved_at).toBeTruthy();
    expect(closed.body).toContain('discovery re-runs as');
  });

  it('"make it better" on its own re-runs discovery and proposes no new ideas', async () => {
    rejectABrief('make it better');
    const llm = surpriseAwareLlm();

    await dispatchProposals(dispatcherDeps(llm));

    expect(discoveryJobs(vault)).toHaveLength(1);
    expect(readJob(vault, discoveryJobs(vault)[0].id)!.body).toContain('make it better');
    expect(listInbox(vault).filter((n) => n.data.kind === 'brand_change')).toHaveLength(0);
    expect(listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.to === 'owner')).toHaveLength(1);
    expect(llm.prompts.some((p) => /surprise them/i.test(p))).toBe(false);
  });

  it('the re-run is a NEW job, not the one the same material already bought', async () => {
    // The material has not changed at all — same files, same interview, same messages — so the ordinary digest
    // would hand back the job that has already run. The rejection is what makes it a different job.
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries.', 'owner');
    const already = createJob(vault, { type: 'discovery', title: 'Read what the owner gave us', assigned: 'research_manager', priority: 1, goal: 'Read it.' }, 'daemon');
    updateJob(vault, already, { status: 'done' }, 'research_manager');

    const rel = rejectABrief('make it better');
    await dispatchProposals(dispatcherDeps(scriptedLlm()));

    const fresh = discoveryJobs(vault).filter((j) => j.id !== already);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).toBe(rejectionDiscoveryJobId(vault.readNoteOrNull(rel)!.data.id, 'make it better'));
    expect(fresh[0].status).toBe('queued');
  });

  it('resolves the note, and still queues the re-run, when no model can answer', async () => {
    const rel = rejectABrief('make it better');
    // No `onBriefRejected` at all: the dispatcher-only shape, and a daemon whose model layer is not up.
    const { onBriefRejected: _drop, ...bare } = dispatcherDeps(scriptedLlm());
    expect(await dispatchProposals(bare)).toBeGreaterThan(0);
    expect(discoveryJobs(vault)).toHaveLength(1);
    expect(vault.readNoteOrNull(rel)!.data.resolved_at).toBeTruthy();
    expect(listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.to === 'owner')).toHaveLength(0);
  });

  it('a replayed tick re-finds the same re-run and the same message', async () => {
    const rel = rejectABrief('make it better');
    const llm = surpriseAwareLlm();
    await dispatchProposals(dispatcherDeps(llm));
    // Clear `resolved_at` the way a rebuild would, and dispatch again over the same note.
    ownerEdit(rel, (t) => t.replace(/^resolved_at: .*$/m, 'resolved_at: null'));
    await dispatchProposals(dispatcherDeps(llm));
    expect(discoveryJobs(vault)).toHaveLength(1);
    expect(listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.to === 'owner')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------

describe('S-4: an approval is applied on the tick; only a message or a rejection wakes a cycle', () => {
  const note = (id: string, front: string, body = '# A note\n') => {
    const rel = `00 Inbox/2026-09-13-${id}.md`;
    vault.writeText(rel, `---\nid: ${id}\ncreated: 2026-09-13T09:00:00.000Z\n${front}---\n${body}`, 'owner');
    return rel;
  };

  it('reads the wake rule off the note', () => {
    const approved = note('p_ok', 'kind: plan_verdict\nfrom: ceo\nto: owner\napproved: true\n');
    const rejected = note('p_no', 'kind: plan_verdict\nfrom: ceo\nto: owner\napproved: false\n');
    const briefNo = note('b_no', 'kind: founder_brief\nfrom: research_manager\napproved: false\n');
    const pending = note('b_open', 'kind: brand_change\nfrom: ceo\napproved: null\n');
    const brandOk = note('b_ok', 'kind: brand_change\nfrom: ceo\napproved: true\n');
    const fromOwner = note('m_own', 'kind: message\nfrom: owner\nto: ceo\n');
    const toOwner = note('m_ceo', 'kind: message\nfrom: ceo\nto: owner\n');

    expect(inboxEditWakesHeartbeat(vault, approved)).toBe(false);
    expect(inboxEditWakesHeartbeat(vault, rejected)).toBe(true);
    expect(inboxEditWakesHeartbeat(vault, briefNo)).toBe(true);
    expect(inboxEditWakesHeartbeat(vault, pending)).toBe(false);
    expect(inboxEditWakesHeartbeat(vault, brandOk)).toBe(false);
    expect(inboxEditWakesHeartbeat(vault, fromOwner)).toBe(true);
    expect(inboxEditWakesHeartbeat(vault, toOwner)).toBe(false);
    expect(inboxEditWakesHeartbeat(vault, '00 Inbox/2026-09-13-gone.md')).toBe(false);

    // The re-planning gate asks the same question, and answers "yes" everywhere outside the inbox.
    expect(ownerEditAsksForWork(vault, approved)).toBe(false);
    expect(ownerEditAsksForWork(vault, rejected)).toBe(true);
    expect(ownerEditAsksForWork(vault, 'Brand/name.md')).toBe(true);
    expect(ownerEditAsksForWork(vault, `${DISCOVERY_INBOX}/pitch.md`)).toBe(true);
  });

  it('the daemon wakes a cycle for a message and a rejection, and for nothing else', async () => {
    // A company that has already run a cycle, so only the edits below can ask for one. `maxConcurrentJobs: 0`
    // keeps the pool from picking a heartbeat up: what is under test is which edits create one.
    vault.events.emit({ type: 'heartbeat.completed', payload: { id: 'seed' } });
    const approved = note('p_ok', 'kind: plan_verdict\nfrom: ceo\nto: owner\napproved: true\n');
    const brandOk = note('b_ok', 'kind: brand_change\nfrom: ceo\ntarget: Brand/name.md\napproved: true\n');
    // `answered: true` on purpose: an unanswered owner note is a heartbeat trigger of its own (the tick's
    // catch-up sweep), and what is under test here is the *edit* rule, not that sweep.
    const message = note('m_own', 'kind: message\nfrom: owner\nto: ceo\nanswered: true\n', '# Any news?\n\nAny news?\n');
    const rejected = note('p_no', 'kind: plan_verdict\nfrom: ceo\nto: owner\napproved: false\n');
    vault.close();

    const d = new Daemon(
      defaultConfig(dir, { CUBICLE_MOCK_TOOLS: '1' } as NodeJS.ProcessEnv, {
        port: 0, tickMs: 600_000, maxConcurrentJobs: 0,
        heartbeat: { maxElapsedHours: 999, jobsCompletedN: Number.MAX_SAFE_INTEGER, startupAwayHours: 999 },
        providersPath: path.join(root, 'config/providers.yaml'), toolsPath: path.join(root, 'config/tools.yaml'),
      }),
      { llm: scriptedLlm(), disableWs: true, disableSleepWatch: true, disablePantry: true, memory: false, log: () => undefined, closeDbOnStop: false },
    );
    await d.start();
    try {
      const v = d.vault;
      const heartbeats = () => listJobs(v).filter((j) => j.type === 'ceo.heartbeat');
      const edited = (rel: string) => v.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: rel, area: '00 Inbox', deleted: false, wakes_heartbeat: true } });

      edited(approved);
      expect(heartbeats()).toHaveLength(0);
      edited(brandOk);
      expect(heartbeats()).toHaveLength(0);

      edited(message);
      expect(heartbeats()).toHaveLength(1);
      updateJob(v, heartbeats()[0].id, { status: 'cancelled' }, 'daemon');

      edited(rejected);
      expect(heartbeats()).toHaveLength(2);

      // An edit outside the inbox still wakes one, as it always did.
      updateJob(v, heartbeats().find((j) => j.status !== 'cancelled')!.id, { status: 'cancelled' }, 'daemon');
      v.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: 'Brand/name.md', area: 'Brand', deleted: false, wakes_heartbeat: true } });
      expect(heartbeats()).toHaveLength(3);
    } finally { await d.stop(); }
  }, 120_000);

  it('an approved plan is not a reason to rewrite the plan', async () => {
    const v = Vault.open(dir);
    try {
      adoptFounderBrief(v);
      // A fresh, substantive plan with open work: the gate stands it down unless somebody asked for a change.
      v.writeText('Plans/plan.md', `---\nupdated: "${new Date().toISOString().slice(0, 10)}"\ncycle: 3\n---\n# Plan\n\n## Objectives\n\n### dev\n- Ship the first cut of the site\n`, 'ceo');
      createJob(v, { type: 'engineer.ship', title: 'Ship the site', assigned: 'backend_engineer', priority: 2, goal: 'Ship it.' }, 'ceo');
      // …and the one owner edit since the last cycle is an approval.
      const approved = `00 Inbox/2026-09-13-p_ok.md`;
      v.writeText(approved, '---\nid: p_ok\nkind: plan_verdict\nfrom: ceo\nto: owner\ncreated: 2026-09-13T09:00:00.000Z\napproved: true\nfanned_out: hb_old\nresolved_at: 2026-09-13T09:01:00.000Z\n---\n# Plan verdict\n', 'owner');
      v.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: approved, area: '00 Inbox', deleted: false, wakes_heartbeat: true } });

      const { hb } = await cycle(v, scriptedLlm(), createHeartbeatJob(v, 'jobs completed'));
      expect(readJob(v, hb)!.body).toContain('planning skipped');
      expect(planJobs(v)).toHaveLength(0);
    } finally { v.close(); }
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------

describe('S-6b: a ship the daemon queues itself carries a stream, or is not queued at all', () => {
  const aStream = (slug: string, team = 'dev') =>
    createStream(vault, { slug, name: slug, problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: team }, 'product_manager');

  it('picks the only stream, and refuses to choose when there is none or several', () => {
    expect(soleStreamForShip(vault).refuse).toContain('no stream exists');
    aStream('site');
    expect(soleStreamForShip(vault)).toEqual({ stream: 'site' });
    aStream('app');
    expect(soleStreamForShip(vault).refuse).toContain('2 streams exist');
    expect(listStreams(vault).map((s) => s.slug)).toEqual(['app', 'site']);
  });

  it('the heartbeat reconcile step carries the only stream, and queues nothing without one', async () => {
    const v = Vault.open(dir);
    try {
      const ships = () => listJobs(v).filter((j) => j.type === 'engineer.ship' && /reconcile site with brand/i.test(j.title));
      // No stream: the job would have done the work and then been refused at the CI gate, so it is not queued.
      v.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: 'Brand/palette.md', area: 'Brand', deleted: false, wakes_heartbeat: true } });
      const dry = await cycle(v, scriptedLlm());
      expect(ships()).toHaveLength(0);
      expect(readJob(v, dry.hb)!.body).toContain('no reconcile job: no stream exists');

      // One stream, and the same edit: now it is queued, and it carries it.
      createStream(v, { slug: 'site', name: 'Site', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev' }, 'product_manager');
      v.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: 'Brand/palette.md', area: 'Brand', deleted: false, wakes_heartbeat: true } });
      await cycle(v, scriptedLlm());
      expect(ships()).toHaveLength(1);
      expect(ships()[0].stream).toBe('site');
    } finally { v.close(); }
  }, 60_000);

  it('the dispatcher queues the reconcile job only when it can name the stream', async () => {
    const propose = (title: string) => {
      const { path: rel } = createProposal(vault, {
        kind: 'brand_change', from: 'ceo', target: BRAND_NAME_PATH, title,
        body: `## Proposed content\n\n\`\`\`\n---\nname: "${title}"\ntagline: "t"\nurl: ""\n---\n# ${title}\n\`\`\`\n`,
      }, 'ceo');
      ownerEdit(rel, (t) => t.replace(/^approved: .*$/m, 'approved: true'));
      return rel;
    };
    const ships = () => listJobs(vault).filter((j) => j.type === 'engineer.ship' && /reconcile site with brand/i.test(j.title));

    const first = propose('Nameless');
    await dispatchProposals(dispatcherDeps(scriptedLlm()));
    expect(ships()).toHaveLength(0);
    expect(vault.readNoteOrNull(first)!.body).toContain('no reconcile job: no stream exists');

    aStream('site');
    propose('PlateReady');
    await dispatchProposals(dispatcherDeps(scriptedLlm()));
    expect(ships()).toHaveLength(1);
    expect(ships()[0].stream).toBe('site');
  });
});
