import { z } from 'zod';
import { defineTool } from '../registry.js';
import { isOwnerOwned, createProposal, OwnerOwnedPathError } from '@cubicle/core';
import { policyFor, proposalKindFor } from '../registry.js';

const MAX_READ = 60_000;

export const vaultRead = defineTool({
  name: 'vault.read',
  description: 'Read a note or file from the vault by relative path (e.g. "Plans/plan.md").',
  schema: { path: z.string().describe('vault-relative path') },
  async handler({ path }, ctx) {
    const text = ctx.vault.readTextOrNull(path);
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

/** Shared write path: owner-owned targets become file_change proposals when policy says `propose`. */
async function guardedWrite(path: string, content: string, append: boolean, ctx: Parameters<typeof vaultRead.handler>[1]) {
  const toolName = append ? 'vault.append' : 'vault.write';
  if (isOwnerOwned(path, ctx.vault.constitution().never_modify)) {
    const mode = policyFor(ctx.config, toolName).owner_owned_mode ?? 'propose';
    if (mode === 'never') {
      ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: toolName, path, reason: 'owner-owned path' } });
      return { ok: false, text: `blocked: ${path} is owner-owned and this tool is set to never for it` };
    }
    const current = ctx.vault.readTextOrNull(path) ?? '';
    const proposed = append ? current + (current.endsWith('\n') || !current ? '' : '\n') + content : content;
    const { id, path: p } = createProposal(ctx.vault, {
      kind: proposalKindFor(ctx.config, toolName) === 'outbound_batch' ? 'file_change' : (proposalKindFor(ctx.config, toolName) as 'file_change'),
      from: ctx.roleId, target: path, job: ctx.jobId ?? undefined,
      title: `Proposed change to ${path}`,
      body: `${ctx.roleId} wants to ${append ? 'append to' : 'rewrite'} \`${path}\`.\n\n## Proposed content\n\n\`\`\`\n${proposed}\n\`\`\`\n\nSet \`approved: true\` to apply.`,
    }, ctx.roleId);
    return { ok: true, text: `proposed: ${path} is owner-owned; filed proposal ${id} at ${p} for the owner to approve`, data: { status: 'proposed', proposal: id } };
  }
  try {
    const sha = append ? ctx.vault.appendText(path, content, ctx.roleId, { job: ctx.jobId }) : ctx.vault.writeText(path, content, ctx.roleId, { job: ctx.jobId });
    return { ok: true, text: `wrote ${path} (sha ${sha.slice(0, 8)})`, data: { sha } };
  } catch (err) {
    if (err instanceof OwnerOwnedPathError) return { ok: false, text: err.message };
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
