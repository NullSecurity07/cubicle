import { z } from 'zod';
import { defineTool } from '../registry.js';
import { createProposal, ProposalKind, idFromKey, loadOrg, can } from '@cubicle/core';

export const proposalCreate = defineTool({
  name: 'proposal.create',
  description: 'File a proposal for the owner in 00 Inbox/ (hire, fire, brand_change, charter_change, file_change, spend, reorg, threat_model) or a message to the owner (kind=message).',
  schema: {
    kind: ProposalKind,
    title: z.string(),
    body: z.string().describe('markdown; for charter/brand/file changes include the full proposed content'),
    target: z.string().optional().describe('vault path the proposal changes, if any'),
  },
  async handler({ kind, title, body, target }, ctx) {
    // Two kinds belong to the system, not to an agent. A hand-written `plan_verdict` would be read by the next
    // heartbeat as a plan waiting for the owner (see openPlanVerdict) and would hold back the company's planning.
    if (kind === 'outbound_batch') return { ok: false, text: 'outbound_batch proposals are created by the tool layer, not directly' };
    if (kind === 'plan_verdict') return { ok: false, text: 'plan_verdict proposals are filed by the heartbeat when the board has read the plan, not directly' };
    const org = loadOrg(ctx.vault);
    if ((kind === 'hire' || kind === 'fire') && !can(org, ctx.roleId, kind)) return { ok: false, text: `${ctx.roleId} may not file ${kind} proposals` };
    if (kind === 'reorg') {
      if (ctx.roleId !== 'ceo') return { ok: false, text: 'reorg proposals are filed by the CEO' };
      if (!/```ya?ml\s*\n[\s\S]*?\bteams:\s*\n[\s\S]*?```/.test(body)) return { ok: false, text: 'a reorg proposal must contain a ```yaml fence with a teams: map ({ <team>: { lead, members } })' };
    }
    if (kind === 'hire') {
      const links = (body.match(/\[\[job_[^\]]+\]\]/g) ?? []).length;
      if (links < 2) return { ok: false, text: 'a hire proposal must link at least 2 blocked or repeated jobs ([[job_…]]) as justification' };
      if (!/```(?:markdown|md)?\s*\n---\n/.test(body)) return { ok: false, text: 'a hire proposal must contain the full charter in a ```markdown fence starting with a --- frontmatter block (role, display, model_tier, tools)' };
      const active = ctx.vault.list('Roles', { ext: '.md' }).filter((r) => !r.includes('/archive/')).length;
      if (active >= ctx.vault.constitution().max_roles) return { ok: false, text: `constitution max_roles (${ctx.vault.constitution().max_roles}) is already reached` };
    }
    // A threat model covers one change (§27), and `approvedThreatModel` matches it to the job that filed it.
    if (kind === 'threat_model' && !ctx.jobId) return { ok: false, text: 'a threat_model belongs to a job; file it from the job whose change it covers' };
    const { id, path } = createProposal(ctx.vault, { id: ctx.idempotencyKey ? idFromKey(kind === 'message' ? 'msg' : 'prop', ctx.idempotencyKey) : undefined, kind, from: ctx.roleId, to: 'owner', title, body, target, job: ctx.jobId ?? undefined }, ctx.roleId);
    if (kind === 'message') return { ok: true, text: `message ${id} sent to the owner at ${path}; this job is blocked until they answer`, data: { id, path }, block: { kind: 'message', id } };
    if (kind === 'threat_model') return { ok: true, text: `threat model ${id} filed at ${path}; this job is blocked until the owner approves it`, data: { id, path }, block: { kind: 'proposal', id } };
    return { ok: true, text: `proposal ${id} filed at ${path}; the owner decides`, data: { id, path } };
  },
});
