import { z } from 'zod';
import { defineTool } from '../registry.js';
import { isOwnerOwned, createProposal, OwnerOwnedPathError, isSecretPath, parseNote, idFromKey, UnsafePathError, LEDGER_DIR, FOUNDER_BRIEF, ownerInstruction } from '@cubicle/core';
import { policyFor, proposalKindFor } from '../registry.js';

const MAX_READ = 60_000;

export const vaultRead = defineTool({
  name: 'vault.read',
  description: 'Read a note or file from the vault by relative path (e.g. "Plans/plan.md").',
  schema: { path: z.string().describe('vault-relative path') },
  async handler({ path }, ctx) {
    try { if (isSecretPath(path)) return { ok: false, text: `refusing to read ${path} (secrets / git internals)` }; } catch (err) { return { ok: false, text: (err as Error).message }; }
    let text: string | null;
    try { text = ctx.vault.readTextOrNull(path); } catch (err) { return { ok: false, text: (err as Error).message }; }
    if (text === null) return { ok: false, text: `not found: ${path}` };
    return { ok: true, text: text.length > MAX_READ ? text.slice(0, MAX_READ) + `\n…[truncated ${text.length - MAX_READ} chars]` : text };
  },
});

export const vaultList = defineTool({
  name: 'vault.list',
  description: 'List files under a vault directory (non-recursive unless recursive=true).',
  schema: { dir: z.string().default(''), recursive: z.boolean().default(false) },
  async handler({ dir, recursive }, ctx) {
    const files = ctx.vault.list(dir, { recursive });
    return { ok: true, text: files.length ? files.join('\n') : '(empty)', data: files };
  },
});

export const vaultSearch = defineTool({
  name: 'vault.search',
  description: 'Full-text search across vault notes (case-insensitive substring). Returns path:line: snippet.',
  schema: { query: z.string(), dir: z.string().default(''), limit: z.number().int().min(1).max(100).default(20) },
  async handler({ query, dir, limit }, ctx) {
    const q = query.toLowerCase();
    const hits: string[] = [];
    for (const rel of ctx.vault.list(dir, { recursive: true })) {
      if (!/\.(md|txt|json|yaml|yml|html|astro|css|js|ts)$/i.test(rel)) continue;
      const lines = ctx.vault.readText(rel).split('\n');
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (lines[i].toLowerCase().includes(q)) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
      }
      if (hits.length >= limit) break;
    }
    return { ok: true, text: hits.length ? hits.join('\n') : 'no matches', data: hits };
  },
});

/**
 * Paths agents may never write through vault.write/append, hard-refused rather than turned into a proposal:
 * `00 Inbox/` (approvals are the owner's; agents use proposal.create), `Messages/` (colleague.message only),
 * `Ledger/` (owner-owned too, guard.ts — but the book is append-only, so even a proposal to overwrite it would
 * be the wrong shape; agents use ledger.record instead), other roles' job notes and any job note's frontmatter
 * (the state machine belongs to the harness).
 */
function agentWriteRestriction(rel: string, content: string, ctx: Parameters<typeof vaultRead.handler>[1]): string | null {
  if (rel.startsWith('00 Inbox/')) return '00 Inbox/ is written only via proposal.create';
  if (rel.startsWith('Messages/')) return 'Messages/ is written only via colleague.message';
  // The founder brief is the owner's to adopt, and the only road to it runs through the check in
  // `proposal.create` (ruling FR-4). The live run took the other road: the discovery job wrote this file
  // directly 49 seconds *before* it filed the proposal, so the unchecked brief — three fabricated claims — was
  // in the vault whatever the owner then decided, and `hasFounderBrief` told every later plan the company had
  // one. The dispatcher still writes it on approval (`dispatcher.ts`, the `founder_brief` case): that is
  // `vault.writeText` as the daemon, not this tool, so nothing legitimate loses access.
  if (rel === FOUNDER_BRIEF) return `${FOUNDER_BRIEF} is adopted by the owner, never written directly: file the whole brief with proposal.create kind=founder_brief (target ${FOUNDER_BRIEF}, the brief inside a "## Proposed content" fence). The daemon writes this file when they approve it.`;
  if (rel === LEDGER_DIR || rel.startsWith(`${LEDGER_DIR}/`)) {
    // `ledger.record` is on every role's tool list (phase3Tools), and the spec is neutral about who may use it —
    // §1 says `who` is "the role id that recorded it". Sending the caller to the finance office was an errand it
    // did not need to run.
    return `${LEDGER_DIR}/ is the book; it is append-only, so use ledger.record to add a row (you have it) — or leave it to the daemon, which generates ${LEDGER_DIR}/runway.md`;
  }
  if (rel.startsWith('Site/') && ctx.vault.exists(rel) && ctx.vault.isOwnerChanged(rel)) return `Site/ file "${rel}" was changed by the owner and is read-only for you; ask the owner (proposal.create kind=message) if it must change`;
  if (rel.startsWith('Jobs/')) {
    if (rel === 'Jobs/queue.md' || rel === 'Jobs/_template.md') return `${rel} is generated`;
    if (!ctx.jobId || rel !== `Jobs/${ctx.jobId}.md`) return 'agents may only edit their own job note';
    const cur = ctx.vault.readTextOrNull(rel);
    if (cur !== null && JSON.stringify(parseNote(cur).data) !== JSON.stringify(parseNote(content).data)) return 'job frontmatter is managed by the harness; edit the body sections only';
  }
  return null;
}

/** Shared write path: owner-owned targets become file_change proposals when policy says `propose`. */
async function guardedWrite(rawPath: string, content: string, append: boolean, ctx: Parameters<typeof vaultRead.handler>[1]) {
  const toolName = append ? 'vault.append' : 'vault.write';
  let path: string;
  try { path = (await import('@cubicle/core')).normalizeRel(rawPath); } catch (err) { return { ok: false, text: (err as Error).message }; }
  if (isSecretPath(path)) { ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: toolName, path, reason: 'secret path' } }); return { ok: false, text: `blocked: ${path}` }; }
  const restricted = agentWriteRestriction(path, append ? (ctx.vault.readTextOrNull(path) ?? '') + content : content, ctx);
  if (restricted) {
    ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: toolName, path, reason: restricted } });
    return { ok: false, text: `blocked: ${restricted}` };
  }
  if (isOwnerOwned(path, ctx.vault.constitution().never_modify)) {
    const mode = policyFor(ctx.config, toolName).owner_owned_mode ?? 'propose';
    if (mode === 'never') {
      ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: toolName, path, reason: 'owner-owned path' } });
      return { ok: false, text: `blocked: ${path} is owner-owned and this tool is set to never for it` };
    }
    const current = ctx.vault.readTextOrNull(path) ?? '';
    const proposed = append ? current + (current.endsWith('\n') || !current ? '' : '\n') + content : content;
    const key = ctx.idempotencyKey ?? `${ctx.jobId ?? 'nojob'}:0:${Date.now()}`;
    const fence = proposed.includes('```') ? '````' : '```';
    const { id, path: p } = createProposal(ctx.vault, {
      id: idFromKey('prop', key),
      kind: proposalKindFor(ctx.config, toolName) === 'outbound_batch' ? 'file_change' : (proposalKindFor(ctx.config, toolName) as 'file_change'),
      from: ctx.roleId, target: path, job: ctx.jobId ?? undefined,
      call: { tool: 'vault.write', args: { path, content: proposed }, idempotency_key: key, job: ctx.jobId ?? undefined, role: ctx.roleId },
      title: `Proposed change to ${path}`,
      body: `${ctx.roleId} wants to ${append ? 'append to' : 'rewrite'} \`${path}\`.\n\n## Proposed content\n\n${fence}\n${proposed}\n${fence}\n\n${ownerInstruction('file_change')}`,
    }, ctx.roleId);
    return { ok: true, text: `proposed: ${path} is owner-owned; filed proposal ${id} at ${p} for the owner to approve`, data: { status: 'proposed', proposal: id } };
  }
  try {
    const sha = append ? ctx.vault.appendText(path, content, ctx.roleId, { job: ctx.jobId }) : ctx.vault.writeText(path, content, ctx.roleId, { job: ctx.jobId });
    return { ok: true, text: `wrote ${path} (sha ${sha.slice(0, 8)})`, data: { sha } };
  } catch (err) {
    if (err instanceof OwnerOwnedPathError || err instanceof UnsafePathError) return { ok: false, text: err.message };
    throw err;
  }
}

export const vaultWrite = defineTool({
  name: 'vault.write',
  description: 'Write (create or replace) a vault file. Owner-owned paths (Brand/, Roles/, constitution, preferences) become a proposal instead.',
  schema: { path: z.string(), content: z.string() },
  async handler({ path, content }, ctx) { return guardedWrite(path, content, false, ctx); },
});

export const vaultAppend = defineTool({
  name: 'vault.append',
  description: 'Append text to a vault file (created if missing). Owner-owned paths become a proposal.',
  schema: { path: z.string(), content: z.string() },
  async handler({ path, content }, ctx) { return guardedWrite(path, content, true, ctx); },
});

export const vaultTools = [vaultRead, vaultList, vaultSearch, vaultWrite, vaultAppend];
