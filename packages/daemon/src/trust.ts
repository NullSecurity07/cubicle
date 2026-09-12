import {
  type Vault, type InboxFrontmatter, type GateTable, type Org,
  listInbox, createJob, jobPath, loadOrg, loadGates, nowIso,
  trustReviewsFor, trustState, trustReviewerFor, trustJobId, trustGateGoal, trustGateLabel, type TrustState, type TrustToolPolicy,
} from '@cubicle/core';
import type { ToolsConfig } from '@cubicle/tools';

/**
 * The trust sweep: deterministic, no model call, one slot in the daemon tick.
 *
 * Three jobs, in this order. It files the two reviews for every outbound call waiting in `00 Inbox/`; it closes a
 * proposal a review has returned, unsent, so the waiting job resumes and is told why; and it says once, out loud,
 * when an office has nobody to run its review — because that call now stays refused for ever, and a gate that
 * fails closed in silence is indistinguishable from a bug.
 *
 * It runs *before* `dispatchProposals` in the tick (Decision 19), for a reason the dispatcher cannot fix itself:
 * `dispatchProposals` never looks at an unapproved note, so a returned `email.send` whose owner has not reached
 * the inbox yet would leave its job blocked for ever. The sweep closes it whatever the approval flag says; the
 * dispatcher's only job is the hold.
 */

export interface TrustSweepDeps {
  vault: Vault;
  toolsConfig: ToolsConfig;
  gates?: GateTable;
}

export interface TrustSweepResult { reviews: string[]; closed: string[] }

/** One warning per office per proposal per process. A tick every few seconds would otherwise repeat it for ever. */
const warnedUnstaffed = new Set<string>();

/**
 * The gates one stored call owes, or `[]`. The flag is the owner's file; the refinement is the call's own arguments.
 *
 * The cast reads `trust_review` off a `ToolPolicy`: `TrustToolPolicy` is all-optional, so TypeScript's weak-type
 * rule wants one property in common, and `core` cannot import `tools` to declare the overlap itself.
 */
export function trustGatesForNote(cfg: ToolsConfig, d: InboxFrontmatter): string[] {
  if (!d.call) return [];
  return trustReviewsFor(cfg.tools[d.call.tool] as TrustToolPolicy | undefined, d.call.tool, d.call.args);
}

/** The state of a proposal's reviews, or null when it owes none. */
export function trustStateForNote(vault: Vault, cfg: ToolsConfig, d: InboxFrontmatter): TrustState | null {
  const gates = trustGatesForNote(cfg, d);
  if (!gates.length || !d.call) return null;
  return trustState(vault.events, d.call.idempotency_key, gates);
}

export function sweepTrustReviews(deps: TrustSweepDeps): TrustSweepResult {
  const vault = deps.vault;
  const gates = deps.gates ?? loadGates();
  const out: TrustSweepResult = { reviews: [], closed: [] };
  let org: Org | null = null;
  for (const note of listInbox(vault)) {
    const d = note.data;
    if (d.resolved_at || !d.call) continue;
    const need = trustGatesForNote(deps.toolsConfig, d);
    if (!need.length) continue;
    const call = d.call;
    const st = trustState(vault.events, call.idempotency_key, need);
    if (st.returned.length) {
      closeReturned(vault, note, st);
      out.closed.push(d.id);
      continue;
    }
    // A call the owner has already turned down owes no reviews: the dispatcher closes it as rejected on its next
    // pass, nothing leaves the company either way, and two review jobs would spend two model calls reading a call
    // that can never run (Ruling Q14). The close above is deliberately *not* behind this: a returned call is
    // closed whatever the approval flag says, which is the whole of Decision 19.
    if (d.approved === false) continue;
    const author = call.role ?? d.from;
    org ??= loadOrg(vault);
    for (const gate of need) {
      if (st.passed.includes(gate)) continue;
      const id = trustJobId(call.idempotency_key, gate);
      if (vault.exists(jobPath(id))) continue;
      const reviewer = trustReviewerFor(org, gate, author);
      if (!reviewer) {
        // Failing closed is the only honest default for a gate whose purpose is to stop things, but it must be
        // loud: the review is pending for ever and the call never runs until the owner staffs the office.
        const mark = `${gate}:${d.id}`;
        if (!warnedUnstaffed.has(mark)) {
          warnedUnstaffed.add(mark);
          vault.events.emit({ type: 'daemon.warning', job: d.job ?? null, payload: { where: 'trust', gate, proposal: d.id, tool: call.tool, message: `nobody but ${author} can run ${gate}, so \`${call.tool}\` in ${d.id} stays refused and nothing is sent. Staff the office in Memory/constitution.md, or hire into it.` } });
        }
        continue;
      }
      out.reviews.push(createJob(vault, {
        id, type: gate, title: `${trustGateLabel(gate)}: ${call.tool}`, assigned: reviewer,
        priority: 2, model_tier: 'cheap', links: [`[[${d.id}]]`], privacy: 'cloud',
        trust_key: call.idempotency_key, trust_proposal: d.id,
        done_when: 'the verdict is pass, or return with findings that name the line to change',
        goal: trustGateGoal({ gate, tool: call.tool, args: call.args, proposal: d.id, path: note.path, author, criteria: gates[gate]?.criteria ?? '' }),
      }, 'daemon'));
    }
  }
  return out;
}

/** What the owner reads on a call an office sent back. */
export function trustReturnedOutcome(st: TrustState): string {
  const why = st.findings.slice(0, 3).map((f) => f.replace(/\s*\r?\n\s*/g, ' ').slice(0, 200)).join('; ') || 'no findings given';
  return `returned unsent by ${st.returned.join(' and ')}: ${why}`;
}

/**
 * Close a proposal a review returned. The verdict reaches the owner in the resolution footer rather than in the
 * note's frontmatter: this is the one write that is safe, because the note is *resolved* by it — a system write to
 * a waiting proposal would re-record `written_sha`, and `isOwnerChanged` would then read the owner's next approval
 * as the daemon's own (Decision 18).
 */
function closeReturned(vault: Vault, note: { path: string; data: InboxFrontmatter }, st: TrustState): void {
  const outcome = trustReturnedOutcome(st);
  vault.updateNote(note.path, (nn) => {
    const { refused: _r, refused_at: _a, ...rest } = nn.data as Record<string, unknown>;
    return { data: { ...rest, resolved_at: nowIso() }, body: nn.body.trimEnd() + `\n\n---\n_Resolved ${nowIso()}: ${outcome}. **Nothing was sent.** Fix what the review named and file a fresh call._\n` };
  }, 'daemon');
  vault.db.prepare('DELETE FROM refusals WHERE path = ?').run(note.path);
  vault.events.emit({ type: 'proposal.resolved', agent: 'daemon', job: note.data.job ?? null, payload: { id: note.data.id, kind: note.data.kind, approved: note.data.approved, outcome, trust: true } });
}

/** Test seam: the once-per-process warning memo. */
export function resetTrustWarnings(): void { warnedUnstaffed.clear(); }
