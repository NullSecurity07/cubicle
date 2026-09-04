import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, listJobs, updateJob, nowIso } from '@cubicle/core';
import { requeueUnblocked, defaultConfig } from '../src/index.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-dispatch-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** The section colleague.message writes into the recipient's Messages/ note for a question. */
function askQuestion(to: string, from: string, id: string, jobId: string, body: string): void {
  vault.appendText(`Messages/${to}.md`, `\n## ${nowIso()} from ${from} (question) <!-- id:${id} job:${jobId} -->\n\n${body}\n`, from, { job: jobId });
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
    expect(answerJobs[0].goal ?? '').toBeDefined();
    expect(readJob(vault, answerJobs[0].id)!.body).toContain(msgId);

    // Idempotent: a second sweep neither re-escalates nor queues a second answer job.
    requeueUnblocked(vault);
    expect(listJobs(vault).filter((x) => x.type === 'colleague.answer' && x.assigned === 'ceo')).toHaveLength(1);
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
