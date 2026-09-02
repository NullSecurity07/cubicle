import { z } from 'zod';
import { defineTool } from '../registry.js';
import { createProposal, ProposalKind, idFromKey } from '@cubicle/core';

export const proposalCreate = defineTool({
  name: 'proposal.create',
  description: 'File a proposal for the owner in 00 Inbox/ (hire, fire, brand_change, charter_change, file_change, spend) or a message to the owner (kind=message).',
  schema: {
    kind: ProposalKind,
    title: z.string(),
    body: z.string().describe('markdown; for charter/brand/file changes include the full proposed content'),
    target: z.string().optional().describe('vault path the proposal changes, if any'),
  },
  async handler({ kind, title, body, target }, ctx) {
    if (kind === 'outbound_batch') return { ok: false, text: 'outbound_batch proposals are created by the tool layer, not directly' };
    if ((kind === 'hire' || kind === 'fire') && ctx.roleId !== 'ceo') return { ok: false, text: `${kind} proposals are filed by the CEO (spec §9.5); message the CEO instead` };
    if (kind === 'hire') {
      const links = (body.match(/\[\[job_[^\]]+\]\]/g) ?? []).length;
      if (links < 2) return { ok: false, text: 'a hire proposal must link at least 2 blocked or repeated jobs ([[job_…]]) as justification' };
      if (!/```(?:markdown|md)?\s*\n---\n/.test(body)) return { ok: false, text: 'a hire proposal must contain the full charter in a ```markdown fence starting with a --- frontmatter block (role, display, model_tier, tools)' };
      const active = ctx.vault.list('Roles', { ext: '.md' }).filter((r) => !r.includes('/archive/')).length;
      if (active >= ctx.vault.constitution().max_roles) return { ok: false, text: `constitution max_roles (${ctx.vault.constitution().max_roles}) is already reached` };
    }
    const { id, path } = createProposal(ctx.vault, { id: ctx.idempotencyKey ? idFromKey(kind === 'message' ? 'msg' : 'prop', ctx.idempotencyKey) : undefined, kind, from: ctx.roleId, to: 'owner', title, body, target, job: ctx.jobId ?? undefined }, ctx.roleId);
    if (kind === 'message') return { ok: true, text: `message ${id} sent to the owner at ${path}; this job is blocked until they answer`, data: { id, path }, block: { kind: 'message', id } };
    return { ok: true, text: `proposal ${id} filed at ${path}; the owner decides`, data: { id, path } };
  },
});
