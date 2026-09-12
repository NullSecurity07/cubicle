import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, listJobs, updateJob, createProposal, findInboxById, idFromKey, nowIso, loadOrg } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools, proposalKindFor, CLASSIFIER_UNAVAILABLE_PREFIX } from '@cubicle/tools';
import { vaultScheduler } from '@cubicle/harness';
import { requeueUnblocked, executeStoredCall, dispatchProposals, defaultConfig, escalationTarget, RETRY_NOW } from '../src/index.js';

const root = path.resolve(__dirname, '../../..');

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-dispatch-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** What colleague.message(kind: question) leaves behind: the section in the recipient's Messages/ note … */
function askQuestion(to: string, from: string, id: string, jobId: string, body: string): void {
  vault.appendText(`Messages/${to}.md`, `\n## ${nowIso()} from ${from} (question) <!-- id:${id} job:${jobId} -->\n\n${body}\n`, from, { job: jobId });
}

/** … and the colleague.answer job it queues for the recipient (packages/tools/src/tools/colleague.ts). */
function answerJob(to: string, from: string, id: string, jobId: string, body: string): string {
  return createJob(vault, {
    id: idFromKey('job', `answer:${id}`), type: 'colleague.answer', assigned: to, priority: 2,
    title: `Answer ${from}: ${body.slice(0, 60)}`, parent: jobId, links: [`[[${jobId}]]`],
    goal: `${from} asked you a question and is blocked until you answer:\n\n> ${body}\n\nAnswer with colleague.message(to: "${from}", body: "re:${id} <your answer>").`,
  }, from);
}

describe('unanswered questions time out and escalate to the CEO (D2)', () => {
  it('questionWaitMs defaults to two heartbeat intervals (12 h)', () => {
    const cfg = defaultConfig(dir);
    expect(cfg.questionWaitMs).toBe(2 * cfg.heartbeat.maxElapsedHours * 3600_000);
    expect(cfg.questionWaitMs).toBe(12 * 3600_000);
  });

  it('a question nobody answered for 13 h requeues the asker, hands off to the CEO and queues them a colleague.answer job', () => {
    const asker = createJob(vault, { type: 'engineer.ship', title: 'ship it', assigned: 'backend_engineer', goal: 'g' }, 'cto');
    const msgId = 'msg_stale1';
    askQuestion('cto', 'backend_engineer', msgId, asker, 'Which palette do I use for the hero?');
    const ctoJob = answerJob('cto', 'backend_engineer', msgId, asker, 'Which palette do I use for the hero?');
    updateJob(vault, asker, { status: 'blocked', blocked_on: { kind: 'message', id: msgId, since: hoursAgo(13) } }, 'backend_engineer');

    expect(requeueUnblocked(vault)).toBe(1);

    const j = readJob(vault, asker)!;
    expect(j.data.status).toBe('queued');
    expect(j.body).toContain(`unanswered question ${msgId} escalated to ceo`);

    const ceoMail = vault.readText('Messages/ceo.md');
    const section = ceoMail.split(/\n(?=## )/).find((s) => /from daemon \(handoff\)/.test(s))!;
    expect(section).toBeTruthy();
    expect(section).toContain('backend_engineer'); // the asker
    expect(section).toContain('cto'); // the recipient who never answered
    expect(section).toContain('Which palette do I use for the hero?');

    const answerJobs = listJobs(vault).filter((x) => x.type === 'colleague.answer' && x.assigned === 'ceo');
    expect(answerJobs).toHaveLength(1);
    expect(answerJobs[0].links).toContain(`[[${asker}]]`);
    expect(readJob(vault, answerJobs[0].id)!.body).toContain(msgId);

    // The original recipient must not answer as well: two roles answering spends quota twice and appends two
    // re:<id> sections to an asker that is no longer blocked.
    const cto = readJob(vault, ctoJob)!;
    expect(cto.data.status).toBe('cancelled');
    expect(cto.body).toContain('escalated to ceo');
    expect(section).toContain('cancelled');
    expect(vault.events.last('job.cancelled')!.job).toBe(ctoJob);

    // Idempotent: a second sweep neither re-escalates nor queues a second answer job.
    requeueUnblocked(vault);
    expect(listJobs(vault).filter((x) => x.type === 'colleague.answer' && x.assigned === 'ceo')).toHaveLength(1);

    // M2: the CEO's job is the escalation's re-entry guard, so it must be written before the handoff and the
    // cancel. Written after them, a kill in between re-ran the whole escalation on the next tick: a second
    // handoff section, and — because the recipient's job was cancelled by then — one claiming the recipient was
    // "still working on" it. Ordering is the fix, so the ordering is what is pinned here.
    const queued = vault.events.query({ types: ['job.queued'] }).find((e) => e.job === answerJobs[0].id)!;
    // The handoff append is attributed to the asker's job; the scaffold's own write of the file is not.
    const handoff = vault.events.query({ types: ['vault.wrote'], job: asker }).find((e) => e.payload.path === 'Messages/ceo.md')!;
    const cancel = vault.events.query({ types: ['job.cancelled'] }).find((e) => e.job === ctoJob)!;
    expect(queued.id).toBeLessThan(cancel.id);
    expect(queued.id).toBeLessThan(handoff.id);
  });

  it('a recipient already working on the answer keeps their job, and the handoff says so', () => {
    const asker = createJob(vault, { type: 'engineer.ship', title: 'ship it', assigned: 'backend_engineer', goal: 'g' }, 'cto');
    const msgId = 'msg_stale2';
    askQuestion('cto', 'backend_engineer', msgId, asker, 'Which palette?');
    const ctoJob = answerJob('cto', 'backend_engineer', msgId, asker, 'Which palette?');
    updateJob(vault, ctoJob, { status: 'running' }, 'cto');
    updateJob(vault, asker, { status: 'blocked', blocked_on: { kind: 'message', id: msgId, since: hoursAgo(13) } }, 'backend_engineer');

    expect(requeueUnblocked(vault)).toBe(1);

    expect(readJob(vault, ctoJob)!.data.status).toBe('running'); // never yank a job mid-step
    const section = vault.readText('Messages/ceo.md').split(/\n(?=## )/).find((x) => /from daemon \(handoff\)/.test(x))!;
    expect(section).toContain('still working on');
    expect(section).toContain('you would both be replying');
  });

  it('nothing happens while the question is still within the wait budget', () => {
    const asker = createJob(vault, { type: 'engineer.ship', title: 'ship it', assigned: 'backend_engineer', goal: 'g' }, 'cto');
    const msgId = 'msg_fresh1';
    askQuestion('cto', 'backend_engineer', msgId, asker, 'Which palette?');
    updateJob(vault, asker, { status: 'blocked', blocked_on: { kind: 'message', id: msgId, since: hoursAgo(11) } }, 'backend_engineer');

    expect(requeueUnblocked(vault)).toBe(0);
    expect(readJob(vault, asker)!.data.status).toBe('blocked');
    expect(vault.readTextOrNull('Messages/ceo.md') ?? '').not.toContain('(handoff)');
    expect(listJobs(vault).filter((x) => x.type === 'colleague.answer')).toHaveLength(0);
  });

  it('escalationTarget prefers the asker\'s division lead and falls through to the CEO', async () => {
    const org = loadOrg(vault);
    expect(escalationTarget(org, 'product_manager', 'frontend_engineer')).toBe('cto');
    expect(escalationTarget(org, 'backend_engineer', 'cto')).toBe('ceo');   // the division lead is the one who did not answer
    expect(escalationTarget(org, 'cto', 'cfo')).toBe('ceo');                // a division lead's own lead is the CEO
    expect(escalationTarget(org, 'ciso', 'coo')).toBe('ceo');               // security holds no division
  });

  it('a question inside a division goes to the division lead, not to the CEO', () => {
    const asker = createJob(vault, { type: 'custom', title: 'design it', assigned: 'product_manager', goal: 'g' }, 'dev_manager');
    const msgId = 'msg_div1';
    askQuestion('frontend_engineer', 'product_manager', msgId, asker, 'Which breakpoint do we design for?');
    answerJob('frontend_engineer', 'product_manager', msgId, asker, 'Which breakpoint do we design for?');
    updateJob(vault, asker, { status: 'blocked', blocked_on: { kind: 'message', id: msgId, since: hoursAgo(13) } }, 'product_manager');

    expect(requeueUnblocked(vault)).toBe(1);

    expect(readJob(vault, asker)!.body).toContain(`unanswered question ${msgId} escalated to cto`);
    expect(vault.readText('Messages/cto.md')).toContain('Which breakpoint do we design for?');
    expect(listJobs(vault).filter((x) => x.type === 'colleague.answer' && x.assigned === 'cto')).toHaveLength(1);
    expect(vault.readTextOrNull('Messages/ceo.md') ?? '').not.toContain('Which breakpoint');
  });
});

describe('an approved call whose mode changed to never (D3)', () => {
  it('is refused with a reason naming never, spends no idempotency key, and emits one approved guardrail.blocked', async () => {
    vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const key = `${job}:1:1`;
    const p = createProposal(vault, { kind: 'outbound_batch', from: 'cmo', job, title: 'send one', body: 'x', call: { tool: 'mock.outbound', args: { to: 'a@x', body: 'hi' }, idempotency_key: key, job, role: 'cmo' } }, 'cmo');
    // The owner approved the batch, then pinned the tool to `never` before the daemon got to it.
    const neverCfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8').replace('mock.outbound:         { mode: auto', 'mock.outbound:         { mode: never'));
    const deps = { vault, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })), toolsConfig: neverCfg, scheduler: vaultScheduler(vault), env: {} };

    const r = await executeStoredCall(deps, findInboxById(vault, p.id)!);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/never/);
    expect(existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl'))).toBe(false); // the handler never ran
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([]); // the key is still spendable after the owner relaxes the mode

    const blocked = vault.events.query({ types: ['guardrail.blocked'] });
    expect(blocked).toHaveLength(1);
    expect(blocked[0].payload.tool).toBe('mock.outbound');
    expect(blocked[0].payload.approved).toBe(true);
    expect(String(blocked[0].payload.reason)).toMatch(/never/);
  });
});

describe('an approved call the constitution guardrail could not check', () => {
  /**
   * A proposal carrying an outbound call the owner has approved, and the deps to dispatch it with
   * `guardrails`.
   *
   * The kind comes from `proposalKindFor`, the same function the tool layer files with, so the note is one
   * the system could actually have produced. `mock.outbound` is the tool because it is one the classifier
   * really reads (`OUTBOUND_TEXT_TOOLS`) and the only such tool with no `trust_review`, so a hold here is
   * the classifier's and nobody else's. Its real kind is `outbound_batch` — pairing it with `spend` was the
   * invalid pairing re-review 1 caught, and it is why the round-1 tests passed over a path the classifier
   * can never take.
   */
  function approvedOutbound(guardrails: { check: () => string | null }[]) {
    vault.updateNote('Roles/cmo.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'cmo', goal: 'send' }, 'cto');
    const key = `${job}:1:1`;
    const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
    const kind = proposalKindFor(cfg, 'mock.outbound');
    expect(kind).toBe('outbound_batch');   // the path this whole describe is about
    const p = createProposal(vault, { kind, from: 'cmo', job, title: 'send one', body: 'x', call: { tool: 'mock.outbound', args: { to: 'a@x', body: 'hi' }, idempotency_key: key, job, role: 'cmo' } }, 'cmo');
    return { job, key, p, cfg, deps: { vault, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })), toolsConfig: cfg, scheduler: vaultScheduler(vault), env: {}, guardrails } };
  }
  /** Approve as the owner. Only a raw file edit reads as one: `updateNote` records its own sha as a system write. */
  const approve = (rel: string) => writeFileSync(path.join(dir, rel), readFileSync(path.join(dir, rel), 'utf8').replace(/^approved: .*$/m, 'approved: true'));
  const OUTAGE = `${CLASSIFIER_UNAVAILABLE_PREFIX} (no answer in 20000 ms), so the call is refused rather than sent unchecked. Try it again once a model is answering.`;

  /**
   * `executeStoredCall`'s own two-kind distinction. It is kind-agnostic, and its one production caller is the
   * `spend` branch — where no shipped tool carries classifiable copy (`deploy.site` and `stripe.payment_link`
   * are not in `OUTBOUND_TEXT_TOOLS`), so the classifier cannot reach it today. The branch is kept, and
   * tested, so that a future `spend` tool that does carry copy cannot inherit the round-1 bug; the path an
   * outbound call actually takes is the `dispatchProposals` case below and the harness's own resume.
   */
  it('keeps the approval, the key and the note, and retries — it is not a refusal (review round 1, CRITICAL)', async () => {
    // The classifier timed out. Nobody decided anything about this call; it was simply not checked.
    const outage = OUTAGE;
    let down = true;
    const { job, key, p, deps } = approvedOutbound([{ check: () => (down ? outage : null) }]);

    const first = await executeStoredCall(deps, findInboxById(vault, p.id)!);
    expect(first.ok).toBe(false);
    expect(first.deferred).toBe(true);
    expect(first.text).toMatch(/could not check this call/);
    expect(first.text).toMatch(/idempotency key is unspent/);
    expect(existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl'))).toBe(false);   // nothing was sent
    // Everything the next attempt needs is still here: the ledger is untouched, and so is the note.
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([]);
    const note = findInboxById(vault, p.id)!;
    expect((note.data as { executing_at?: string }).executing_at).toBeUndefined();
    expect((note.data as { blocked_by_guardrail?: string }).blocked_by_guardrail).toBeUndefined();
    expect(note.data.resolved_at ?? null).toBeNull();

    // The re-dispatch while the outage stands says the same thing — never "a previous attempt was
    // interrupted after starting this call (lost result)", which was untrue and killed the send for good.
    const again = await executeStoredCall(deps, findInboxById(vault, p.id)!);
    expect(again.deferred).toBe(true);
    expect(again.text).not.toMatch(/interrupted|lost result|already executed/);

    // A model answers, and the very next sweep sends it — with the approval the owner already gave.
    down = false;
    const sent = await executeStoredCall(deps, findInboxById(vault, p.id)!);
    expect(sent.ok).toBe(true);
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([key]);
    expect(readFileSync(path.join(dir, '.cubicle/mock-outbound.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('a rule that was actually broken still ends the call, key unspent, with one approved guardrail.blocked', async () => {
    // The other kind of refusal: a verdict, not a missing one. It must not be held and retried for ever.
    const { job, p, deps } = approvedOutbound([{ check: () => 'constitution: banned tactic detected: fake urgency' }]);
    const r = await executeStoredCall(deps, findInboxById(vault, p.id)!);
    expect(r.ok).toBe(false);
    expect(r.deferred).toBeUndefined();
    expect(r.text).toContain('blocked even though approved');
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([]);
    const blocked = vault.events.query({ types: ['guardrail.blocked'] });
    expect(blocked).toHaveLength(1);
    expect(String(blocked[0].payload.reason)).toContain('fake urgency');
  });

  /**
   * The path an approved outbound call actually takes. `dispatchProposals` used to resolve an
   * `outbound_batch` unconditionally and wake its author, which handed the harness a note it could no longer
   * be held by — so a twenty-second outage turned into a permanent "blocked even though approved" on the job
   * and a closed proposal, with the owner's approval spent (re-review 1, CRITICAL).
   */
  it('holds an outbound_batch rather than resolving it, keeps its author asleep, and sends it when the model is back', async () => {
    let down = true;
    const { job, p, deps } = approvedOutbound([{ check: () => (down ? OUTAGE : null) }]);
    approve(p.path);
    // The author waits on the proposal, exactly as the harness leaves it when it files an ask-mode call.
    updateJob(vault, job, { status: 'blocked', blocked_on: { kind: 'proposal', id: p.id, since: nowIso() } }, 'cmo');

    expect(await dispatchProposals(deps)).toBe(0);           // nothing was applied, and nobody was woken
    const held = findInboxById(vault, p.id)!;
    expect(held.data.resolved_at ?? null).toBeNull();        // the owner's approval still stands
    expect(held.data.approved).toBe(true);
    expect(held.body).toContain('could not check this call');
    // Nothing to fix and nothing to re-approve: the owner must not be told to set `approved` again, and must
    // not be told to wait ten minutes either — the hold is released on the next cycle.
    expect(held.body).toContain('on the next cycle');
    expect(held.body).not.toContain('Fix it and set approved again');
    expect(held.body).not.toMatch(/10 minutes|ten minutes/);
    // Waking the author would only have the harness re-block it a moment later, once per tick, writing an
    // "unblocked" line into the job note each time — the same reason a trust hold keeps its author asleep.
    expect(readJob(vault, job)!.data.status).toBe('blocked');
    expect(readJob(vault, job)!.data.side_effects_done).toEqual([]);
    expect(existsSync(path.join(dir, '.cubicle/mock-outbound.jsonl'))).toBe(false);
    // It is a deferral, not a refusal: the office must not tell the owner this call was not allowed.
    expect(vault.events.count('guardrail.blocked')).toBe(0);
    expect(vault.events.count('guardrail.deferred')).toBe(1);
    // Due on the next pass rather than in ten minutes — the same lever the trust hold uses.
    expect((vault.db.prepare('SELECT at FROM refusals WHERE path = ?').get(p.path) as { at: string }).at).toBe(RETRY_NOW);

    // Three more sweeps across an outage that could run for hours: **no clock is moved here** — the note is
    // due on every pass, which is the point — and yet the note is not touched again and the room is not told
    // again, the same rule the dormancy hold and the trust hold are written once for.
    const sha = vault.currentSha(held.path);
    for (let i = 0; i < 3; i++) expect(await dispatchProposals(deps)).toBe(0);
    expect(vault.currentSha(held.path)).toBe(sha);
    expect(vault.events.count('guardrail.deferred')).toBe(1);

    // A model answers, and the very next tick resolves the note and wakes the author to send it — no
    // ten-minute wait for a twenty-second outage (SP5's I1 complaint, and the same `retryOnNextPass` lever).
    down = false;
    expect(await dispatchProposals(deps)).toBeGreaterThanOrEqual(1);
    const done = findInboxById(vault, p.id)!;
    expect(done.data.resolved_at).toBeTruthy();
    expect((done.data as { refused?: string }).refused).toBeUndefined();
    expect(readJob(vault, job)!.data.status).toBe('queued');   // the author may now execute its stored call
  });

  it('the held note is due on every pass, not on the ten-minute timer', async () => {
    // The lever itself, stated plainly: a dormancy hold waits (its cause lasts days); a classifier hold does
    // not (its cause lasts seconds). Both keep their `refusals` row — it is what carries the owner's standing
    // approval across the hold — and only the clock differs.
    const { p, deps } = approvedOutbound([{ check: () => OUTAGE }]);
    approve(p.path);
    await dispatchProposals(deps);
    const row = vault.db.prepare('SELECT at FROM refusals WHERE path = ?').get(p.path) as { at: string };
    expect(row.at).toBe(RETRY_NOW);
    expect(Date.now() - Date.parse(row.at)).toBeGreaterThan(10 * 60_000);
  });

  it('a rule that was actually broken is still the harness\'s to record, and the note is resolved as before', async () => {
    // The dispatcher's pre-check acts on one answer only. A real violation is left exactly where it was: the
    // note resolves, the author wakes, and the harness records the block on the job where its author reads it.
    const { job, p, deps } = approvedOutbound([{ check: () => 'constitution: banned tactic detected: fake urgency' }]);
    approve(p.path);
    updateJob(vault, job, { status: 'blocked', blocked_on: { kind: 'proposal', id: p.id, since: nowIso() } }, 'cmo');

    expect(await dispatchProposals(deps)).toBeGreaterThanOrEqual(1);
    expect(findInboxById(vault, p.id)!.data.resolved_at).toBeTruthy();
    expect(vault.events.count('guardrail.deferred')).toBe(0);
    expect(readJob(vault, job)!.data.status).toBe('queued');
  });
});

describe('question timeouts count time the daemon was actually running (live-run 2026-09-10)', () => {
  // The daemon was stopped from 13:59 to 04:00 the next day. The first tick after start found a 14 h old question
  // whose answer job had never had a chance to run and escalated it: the CEO answered a question the COO was about
  // to answer, and the asker — requeued before any answer existed — finished itself as blocked on the owner.
  it('a question older than the wait but asked before the daemon started is not escalated yet', () => {
    const asker = createJob(vault, { type: 'engineer.ship', title: 'ship it', assigned: 'backend_engineer', goal: 'g' }, 'cto');
    const msgId = 'msg_downtime';
    askQuestion('cto', 'backend_engineer', msgId, asker, 'Which palette?');
    answerJob('cto', 'backend_engineer', msgId, asker, 'Which palette?');
    updateJob(vault, asker, { status: 'blocked', blocked_on: { kind: 'message', id: msgId, since: hoursAgo(14) } }, 'backend_engineer');

    expect(requeueUnblocked(vault, 12 * 3600_000, { sinceFloor: Date.now() - 3600_000 })).toBe(0);
    expect(readJob(vault, asker)!.data.status).toBe('blocked');
    expect(listJobs(vault).filter((x) => x.type === 'colleague.answer' && x.assigned === 'ceo')).toHaveLength(0);

    // Once the daemon has been up for the whole wait, it escalates as before.
    expect(requeueUnblocked(vault, 12 * 3600_000, { sinceFloor: Date.now() - 13 * 3600_000 })).toBe(1);
    expect(readJob(vault, asker)!.data.status).toBe('queued');
  });

  it('the escalation tells the asker, in its own transcript, to go on without the answer', () => {
    const asker = createJob(vault, { type: 'engineer.ship', title: 'ship it', assigned: 'backend_engineer', goal: 'g' }, 'cto');
    const msgId = 'msg_goon';
    askQuestion('cto', 'backend_engineer', msgId, asker, 'Which palette?');
    answerJob('cto', 'backend_engineer', msgId, asker, 'Which palette?');
    updateJob(vault, asker, { status: 'blocked', checkpoint_step: 3, blocked_on: { kind: 'message', id: msgId, since: hoursAgo(13) } }, 'backend_engineer');
    expect(requeueUnblocked(vault)).toBe(1);
    const transcript = readFileSync(path.join(dir, '.cubicle/jobs', `${asker}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const note = transcript.find((o) => o.kind === 'system' && o.text.includes(msgId));
    expect(note).toBeTruthy();
    expect(note.step).toBe(3);
    expect(note.text).toMatch(/ceo/);
    expect(note.text).toMatch(/without|assum|do not wait/i);
  });
});
