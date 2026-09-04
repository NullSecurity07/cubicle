import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, listJobs, updateJob, createProposal, findInboxById, idFromKey, nowIso } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler } from '@cubicle/harness';
import { requeueUnblocked, executeStoredCall, defaultConfig } from '../src/index.js';

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
    const asker = createJob(vault, { type: 'engineer.ship', title: 'ship it', assigned: 'engineer', goal: 'g' }, 'cto');
    const msgId = 'msg_stale1';
    askQuestion('cto', 'engineer', msgId, asker, 'Which palette do I use for the hero?');
    const ctoJob = answerJob('cto', 'engineer', msgId, asker, 'Which palette do I use for the hero?');
    updateJob(vault, asker, { status: 'blocked', blocked_on: { kind: 'message', id: msgId, since: hoursAgo(13) } }, 'engineer');

    expect(requeueUnblocked(vault)).toBe(1);

    const j = readJob(vault, asker)!;
    expect(j.data.status).toBe('queued');
    expect(j.body).toContain(`unanswered question ${msgId} escalated to ceo`);

    const ceoMail = vault.readText('Messages/ceo.md');
    const section = ceoMail.split(/\n(?=## )/).find((s) => /from daemon \(handoff\)/.test(s))!;
    expect(section).toBeTruthy();
    expect(section).toContain('engineer'); // the asker
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
  });

  it('a recipient already working on the answer keeps their job, and the handoff says so', () => {
    const asker = createJob(vault, { type: 'engineer.ship', title: 'ship it', assigned: 'engineer', goal: 'g' }, 'cto');
    const msgId = 'msg_stale2';
    askQuestion('cto', 'engineer', msgId, asker, 'Which palette?');
    const ctoJob = answerJob('cto', 'engineer', msgId, asker, 'Which palette?');
    updateJob(vault, ctoJob, { status: 'running' }, 'cto');
    updateJob(vault, asker, { status: 'blocked', blocked_on: { kind: 'message', id: msgId, since: hoursAgo(13) } }, 'engineer');

    expect(requeueUnblocked(vault)).toBe(1);

    expect(readJob(vault, ctoJob)!.data.status).toBe('running'); // never yank a job mid-step
    const section = vault.readText('Messages/ceo.md').split(/\n(?=## )/).find((x) => /from daemon \(handoff\)/.test(x))!;
    expect(section).toContain('still working on');
    expect(section).toContain('you would both be replying');
  });

  it('nothing happens while the question is still within the wait budget', () => {
    const asker = createJob(vault, { type: 'engineer.ship', title: 'ship it', assigned: 'engineer', goal: 'g' }, 'cto');
    const msgId = 'msg_fresh1';
    askQuestion('cto', 'engineer', msgId, asker, 'Which palette?');
    updateJob(vault, asker, { status: 'blocked', blocked_on: { kind: 'message', id: msgId, since: hoursAgo(11) } }, 'engineer');

    expect(requeueUnblocked(vault)).toBe(0);
    expect(readJob(vault, asker)!.data.status).toBe('blocked');
    expect(vault.readTextOrNull('Messages/ceo.md') ?? '').not.toContain('(handoff)');
    expect(listJobs(vault).filter((x) => x.type === 'colleague.answer')).toHaveLength(0);
  });
});

describe('an approved call whose mode changed to never (D3)', () => {
  it('is refused with a reason naming never, spends no idempotency key, and emits one approved guardrail.blocked', async () => {
    vault.updateNote('Roles/head_of_growth.md', (n) => ({ data: { ...n.data, tools: [...(n.data.tools as string[]), 'mock.outbound'] }, body: n.body }), 'owner');
    const job = createJob(vault, { type: 'growth.outreach', title: 'outreach', assigned: 'head_of_growth', goal: 'send' }, 'cto');
    const key = `${job}:1:1`;
    const p = createProposal(vault, { kind: 'outbound_batch', from: 'head_of_growth', job, title: 'send one', body: 'x', call: { tool: 'mock.outbound', args: { to: 'a@x', body: 'hi' }, idempotency_key: key, job, role: 'head_of_growth' } }, 'head_of_growth');
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
