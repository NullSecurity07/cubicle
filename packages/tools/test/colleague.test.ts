import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, listJobs, readJob } from '@cubicle/core';
import { parseToolsConfig, createRoleToolClient, colleagueMessage, type ToolContext } from '../src/index.js';

let dir: string; let vault: Vault;
const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));

beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-colleague-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function role(id: string) { return RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${id}.md`)).data); }
function ctxFor(roleId: string, jobId: string | null, key?: string): ToolContext {
  return {
    vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: {}, workspace: '.cubicle/workspace/x', now: () => new Date(),
    scheduler: { enqueue: (j) => createJob(vault, j, roleId) }, idempotencyKey: key,
  };
}

const QUESTION = 'Which framework should the site use, and does the choice affect the deploy story at all?';

describe('colleague.message(kind: question)', () => {
  it('enqueues a colleague.answer job for the recipient, once per message id', async () => {
    const asker = createJob(vault, { type: 'engineer.ship', title: 'site', assigned: 'engineer', goal: 'build' }, 'cto');
    const client = await createRoleToolClient([colleagueMessage], ctxFor('engineer', asker, 'k:1:2'));
    try {
      const before = listJobs(vault).length;
      const r = await client.call('colleague.message', { to: 'cto', body: QUESTION, kind: 'question' });
      expect(r.ok).toBe(true);
      const msgId = (r.data as { id: string }).id;
      expect(r.block).toEqual({ kind: 'message', id: msgId });

      const answer = listJobs(vault).find((j) => j.type === 'colleague.answer');
      expect(answer).toBeDefined();
      expect(answer!.assigned).toBe('cto');
      expect(answer!.status).toBe('queued');
      expect(answer!.priority).toBe(2);
      expect(answer!.title).toBe(`Answer engineer: ${QUESTION.slice(0, 60)}`);
      expect(answer!.links.some((l) => l.includes(asker))).toBe(true);
      expect(answer!.parent).toBe(asker); // same shape as a handoff: the question's job owns the answer
      const body = readJob(vault, answer!.id)!.body;
      expect(body).toContain('## Goal');
      expect(body).toContain(`colleague.message(to: "engineer", body: "re:${msgId}`);
      expect(body).toContain(QUESTION);
      expect(listJobs(vault).length).toBe(before + 1);

      // A replayed step (same idempotency key → same message id) must not create a second job.
      const again = await client.call('colleague.message', { to: 'cto', body: QUESTION, kind: 'question' });
      expect(again.ok).toBe(true);
      expect((again.data as { id: string }).id).toBe(msgId);
      expect(listJobs(vault).filter((j) => j.type === 'colleague.answer')).toHaveLength(1);
    } finally { await client.close(); }
  });

  it('an fyi message creates no job', async () => {
    const client = await createRoleToolClient([colleagueMessage], ctxFor('engineer', null, 'k:9:9'));
    try {
      const before = listJobs(vault).length;
      const r = await client.call('colleague.message', { to: 'cto', body: 'shipped the landing page', kind: 'fyi' });
      expect(r.ok).toBe(true);
      expect(listJobs(vault).length).toBe(before);
    } finally { await client.close(); }
  });
});
