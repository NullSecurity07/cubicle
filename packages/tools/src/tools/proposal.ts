import { z } from 'zod';
import { defineTool, type ToolContext } from '../registry.js';
import {
  createProposal, ProposalKind, idFromKey, loadOrg, can, officeHolder, listInbox, type Vault,
  checkFounderBrief, briefCheckContext, briefFromProposalBody, hasProposedContentFence, founderBriefProposalBody, citedPaths,
  withProposedContent, withFounderBriefTitle,
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

/**
 * The founder brief this job already filed and the owner has not finished with, or null.
 *
 * Ruling W3-4, out of the third live run: one discovery job filed the brief at step 31 and again at step 33.
 * Two proposals, two board sessions on the same document (32 model calls), two question messages to the owner,
 * and two notes to adopt — of which adopting either leaves the other open for ever. The job is the key because
 * that is the unit the company works in: a *second* discovery job (the owner rejected the first brief and the
 * research office wrote another) is a genuinely new document and gets its own note.
 *
 * Unresolved, not undecided: a note the owner has ruled on but the dispatcher has not applied yet is still the
 * brief they are looking at, and is handled a step above rather than here.
 */
function openFounderBrief(vault: Vault, job: string | null | undefined): { path: string; data: Record<string, unknown> } | null {
  if (!job) return null;
  const note = listInbox(vault).find((n) => n.data.kind === 'founder_brief' && n.data.job === job && !n.data.resolved_at);
  return note ? { path: note.path, data: note.data as unknown as Record<string, unknown> } : null;
}

/** Said on every path that ends with a brief already in the inbox, so the author stops writing and finishes. */
const DO_NOT_FILE_AGAIN = 'do not file again — finish the job';

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
      // Ruling W6-1 (c): the gate that can still refuse this at approve time is stated on the note, in the
      // owner's words, *before* they press the button. The links are checked again when the hire is applied —
      // a job that has since finished no longer justifies anything — and the live run's owner read the rule for
      // the first time in a `refused:` field, after their click, written in daemon vocabulary.
      body = `${body.trimEnd()}\n\n_Before you approve: this hire is applied only if at least two of the jobs linked above are still blocked, failed or retried when you press the button — that is the evidence the company owes you for a new salary. If they have all since finished, send it back and ask for a fresh case._\n`;
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
      // Ruling W6-12, and the same "the bytes are still ours to shape" moment: the brief's own H1 is two facts
      // the vault holds, not a title for the author to choose. The third dry-run's author echoed the fence it
      // was told to use — `# Proposed content` — and that became the heading of `Memory/founder-brief.md`, the
      // reader's title and its accessible name. Applied whether or not the fence had to be added, because the
      // placeholder arrives inside a correctly fenced brief just as easily.
      const titled = withFounderBriefTitle(briefFromProposalBody(body), ctx.vault);
      body = hasProposedContentFence(body)
        ? withProposedContent(body, titled)
        : founderBriefProposalBody(titled, citedPaths(titled));
      // One open brief per discovery job (ruling W3-4). The check runs **after** the truth check above, so the
      // note the owner sees is always a brief that passed it, and so the two-returns rule keeps working on the
      // same document rather than being reset by a second note.
      const open = openFounderBrief(ctx.vault, ctx.jobId);
      if (open) {
        const at = `(${open.path})`;
        const data = { id: String(open.data.id ?? ''), path: open.path };
        // Decided already, even if the dispatcher has not applied it yet: what the owner said yes or no to is
        // the document on screen, and rewriting it underneath their decision is the one thing worse than a
        // duplicate (the reason `runBriefBoardSession` re-reads before its own write, ruling R-T3-3).
        if (open.data.approved != null || open.data.chosen != null) {
          return { ok: true, text: `the brief you already filed ${at} is with the owner and they have ruled on it; ${DO_NOT_FILE_AGAIN}`, data };
        }
        // The board has written its pressure test into that note (`board_pending` cleared). A rewrite would
        // throw away sixteen model calls of argument and put the author's draft section back, so it does not
        // happen: the brief on file stands and the owner reads it.
        if (open.data.board_pending === false) {
          return { ok: true, text: `the board has already pressure-tested the brief you filed ${at} and its findings are in it; a rewrite would throw them away, so ${DO_NOT_FILE_AGAIN}`, data };
        }
        ctx.vault.updateNote(open.path, (n) => ({ data: n.data, body: `# ${title.trim()}\n\n${body.trim()}\n` }), ctx.roleId, { job: ctx.jobId ?? null });
        return { ok: true, text: `updated the brief you already filed ${at}; ${DO_NOT_FILE_AGAIN}`, data };
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
    // Said on the way out, not only on the way back in (ruling W3-4): the live run's job filed the brief and
    // then filed it again two steps later, so the successful result is where "that is done" belongs.
    if (kind === 'founder_brief') return { ok: true, text: `founder brief ${id} filed at ${path}; the owner decides. Filed; ${DO_NOT_FILE_AGAIN}`, data: { id, path } };
    return { ok: true, text: `proposal ${id} filed at ${path}; the owner decides`, data: { id, path } };
  },
});
