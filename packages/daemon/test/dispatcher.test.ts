import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, listJobs, updateJob, createProposal, findInboxById, idFromKey, nowIso, loadOrg } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler } from '@cubicle/harness';
import { requeueUnblocked, executeStoredCall, defaultConfig, escalationTarget } from '../src/index.js';

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
