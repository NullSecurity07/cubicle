import { z } from 'zod';
import { defineTool } from '../registry.js';
import { gitFor, autoCommit } from '@cubicle/core';

export const gitLog = defineTool({
  name: 'git.log',
  description: 'Recent commits in the vault repo (optionally for a path).',
  schema: { path: z.string().optional(), limit: z.number().int().min(1).max(50).default(10) },
  async handler({ path, limit }, ctx) {
    const git = gitFor(ctx.vault.root);
    const log = await git.log({ maxCount: limit, ...(path ? { file: path } : {}) });
    return { ok: true, text: log.all.map((c) => `${c.hash.slice(0, 7)} ${c.date.slice(0, 16)} ${c.message}`).join('\n') || '(no commits)' };
  },
});

export const gitDiff = defineTool({
  name: 'git.diff',
  description: 'Working-tree diff vs HEAD (optionally for a path). Use it to see what changed under Site/ before editing.',
  schema: { path: z.string().default('Site'), stat: z.boolean().default(false) },
  async handler({ path, stat }, ctx) {
    const git = gitFor(ctx.vault.root);
    const args = stat ? ['--stat', '--', path] : ['--', path];
    const diff = await git.diff(args);
    const status = await git.raw(['status', '--porcelain', '--', path]);
    return { ok: true, text: `${status.trim() ? `status:\n${status.trim()}\n\n` : ''}${diff.slice(0, 30_000) || '(no diff)'}` };
  },
});

export const gitCommit = defineTool({
  name: 'git.commit',
  description: 'Commit everything in the vault with a message (the heartbeat also commits; use this after a shipped change).',
  schema: { message: z.string().min(3) },
  async handler({ message }, ctx) {
    const hash = await autoCommit(ctx.vault.root, `${ctx.roleId}: ${message}`);
    return { ok: true, text: hash ? `committed ${hash.slice(0, 7)}` : 'nothing to commit' };
  },
});

export const gitRevert = defineTool({
  name: 'git.revert',
  description: 'Discard uncommitted changes under a Site/ path you made (never owner-changed files), restoring the last commit.',
  schema: { path: z.string().default('Site') },
  async handler({ path }, ctx) {
    const rel = path.replace(/^\/+/, '');
    if (!rel.startsWith('Site')) return { ok: false, text: 'git.revert only works under Site/' };
    const changed = (await gitFor(ctx.vault.root).raw(['status', '--porcelain', '--', rel])).split('\n').filter(Boolean).map((l) => l.slice(3).trim());
    const ownerChanged = changed.filter((f) => ctx.vault.isOwnerChanged(f));
    if (ownerChanged.length) return { ok: false, text: `refusing: owner-changed files would be lost: ${ownerChanged.join(', ')}` };
    await gitFor(ctx.vault.root).raw(['checkout', '--', rel]).catch(() => undefined);
    await gitFor(ctx.vault.root).raw(['clean', '-fd', '--', rel]).catch(() => undefined);
    ctx.vault.rescan('Site', ctx.roleId, { job: ctx.jobId });
    return { ok: true, text: `reverted ${changed.length} file(s) under ${rel}` };
  },
});

export const gitTools = [gitLog, gitDiff, gitCommit, gitRevert];
