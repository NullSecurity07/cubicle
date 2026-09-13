import { z } from 'zod';
import { defineTool, type ToolContext } from '../registry.js';
import {
  createProposal, ProposalKind, idFromKey, loadOrg, can, officeHolder,
  checkFounderBrief, briefCheckContext, briefFromProposalBody, hasProposedContentFence, founderBriefProposalBody, citedPaths,
} from '@cubicle/core';

/**
 * How many times one author may be handed its own findings back before the tool stops inviting a fix.
 *
 * Two, because the findings are specific enough to act on ("Brand/name.md carries an empty name") and a third
 * identical refusal is a model rewriting the same sentence rather than reading the file. After that the tool
 * refuses outright and says so: the honest brief — the one that writes "unstated" where nothing is established
 * — is always available, and a job that cannot write it should finish saying so rather than keep trying.
 */
export const BRIEF_CHECK_TRIES = 2;

/**
 * Refusals per author, this process. Keyed by vault and job so two jobs (and two test vaults) never share a
 * count. In-memory on purpose: a restart hands the author its tries back, which errs towards letting a brief
 * be filed after a fix rather than towards refusing one for a count nobody can see.
 */
const briefTries = new Map<string, number>();

function briefKey(ctx: ToolContext): string {
  return `${ctx.vault.root}:${ctx.jobId ?? ctx.roleId}`;
}

/** Forget every count. Tests only — the daemon never needs it. */
export function resetBriefTries(): void { briefTries.clear(); }

export const proposalCreate = defineTool({
  name: 'proposal.create',
  description: 'File a proposal for the owner in 00 Inbox/ (hire, fire, brand_change, charter_change, file_change, spend, reorg, threat_model) or a message to the owner (kind=message).',
  schema: {
    kind: ProposalKind,
    title: z.string(),
    body: z.string().describe('markdown; for charter/brand/file changes include the full proposed content'),
    target: z.string().optional().describe('vault path the proposal changes, if any'),
  },
  async handler({ kind, title, body: rawBody, target }, ctx) {
    let body = rawBody;
    // Two kinds belong to the system, not to an agent. A hand-written `plan_verdict` would be read by the next
    // heartbeat as a plan waiting for the owner (see openPlanVerdict) and would hold back the company's planning.
    if (kind === 'outbound_batch') return { ok: false, text: 'outbound_batch proposals are created by the tool layer, not directly' };
    if (kind === 'plan_verdict') return { ok: false, text: 'plan_verdict proposals are filed by the heartbeat when the board has read the plan, not directly' };
    const org = loadOrg(ctx.vault);
    if ((kind === 'hire' || kind === 'fire') && !can(org, ctx.roleId, kind)) return { ok: false, text: `${ctx.roleId} may not file ${kind} proposals` };
    if (kind === 'reorg') {
      const ceo = officeHolder(org, 'chief_executive');
      if (ctx.roleId !== ceo) return { ok: false, text: `reorg proposals are filed by the chief executive (${ceo})` };
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
    // The founder brief is checked against the vault before the owner is asked to adopt it (ruling FR-4): every
    // cited file exists, no name while `Brand/name.md` has none, no answers while the interview has none, and a
    // pressure test that ends on a verdict. The findings come back here, as this tool's own output, so the
    // author fixes the brief in the same turn rather than the owner reading a beautiful and false document.
    if (kind === 'founder_brief') {
      const check = checkFounderBrief(ctx.vault, briefFromProposalBody(body), briefCheckContext(ctx.vault));
      if (!check.ok) {
        const key = briefKey(ctx);
        const tries = (briefTries.get(key) ?? 0) + 1;
        briefTries.set(key, tries);
        const found = check.findings.map((f) => `- ${f}`).join('\n');
        return tries > BRIEF_CHECK_TRIES
          ? { ok: false, text: `This brief was returned ${BRIEF_CHECK_TRIES} times for the same kind of claim and is refused. Do not file it again. What the files do not establish is not a gap to fill in prose: write "unstated" under the section that would have carried it, put the rest under "## What we do not know", and finish saying which claims you could not support.\n${found}` }
          : { ok: false, text: `The brief is not filed: it says things the vault does not. Fix these and call proposal.create again (${BRIEF_CHECK_TRIES - tries} more ${BRIEF_CHECK_TRIES - tries === 1 ? 'try' : 'tries'}):\n${found}` };
      }
      briefTries.delete(briefKey(ctx));
      // Ruling C1: `founderBriefProposalBody` is the **only** shape this note ever has. Three readers depend on
      // the `## Proposed content` fence — the dispatcher adopts what is inside it, the rejection path hands the
      // research office the brief out of it, and `briefRejectionComment` reads the owner's own words as what
      // lies outside it — and until now nothing put it there: `vault.write` only *instructs* the author to use
      // one, and the dispatcher notices a missing fence at approve time and never on the rejection path. The
      // live run's brief had none, so the owner's "rejected make it better or get a new idea" was invisible and
      // a thousand characters of the company's own prose went back to them as their words. A brief that arrives
      // without the fence is wrapped here, once, where the bytes are still ours to shape.
      if (!hasProposedContentFence(body)) {
        const brief = briefFromProposalBody(body);
        body = founderBriefProposalBody(brief, citedPaths(brief));
      }
    }
    const { id, path } = createProposal(ctx.vault, { id: ctx.idempotencyKey ? idFromKey(kind === 'message' ? 'msg' : 'prop', ctx.idempotencyKey) : undefined, kind, from: ctx.roleId, to: 'owner', title, body, target, job: ctx.jobId ?? undefined }, ctx.roleId);
    // SP8 ruling P8-6: under `board_dialogue: full` the brief is not finished when it is filed — the board
    // pressure-tests it and its findings become the `## Pressure test` section. A tool cannot hold a board
    // session, so it says so instead, and the daemon's discovery step finishes the document and takes the flag
    // off. Until then the owner is not asked to rule on a half-written brief.
    if (kind === 'founder_brief' && ctx.vault.constitution().board_dialogue !== 'brief') {
      ctx.vault.updateNote(path, (n) => ({ data: { ...n.data, board_pending: true }, body: n.body }), ctx.roleId);
    }
    if (kind === 'message') return { ok: true, text: `message ${id} sent to the owner at ${path}; this job is blocked until they answer`, data: { id, path }, block: { kind: 'message', id } };
    if (kind === 'threat_model') return { ok: true, text: `threat model ${id} filed at ${path}; this job is blocked until the owner approves it`, data: { id, path }, block: { kind: 'proposal', id } };
    return { ok: true, text: `proposal ${id} filed at ${path}; the owner decides`, data: { id, path } };
  },
});
