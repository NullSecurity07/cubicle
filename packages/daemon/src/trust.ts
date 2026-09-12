import {
  type Vault, type InboxFrontmatter, type JobFrontmatter, type GateTable, type Org,
  listInbox, createJob, cancelJob, jobPath, readJob, loadOrg, loadGates, nowIso,
  trustReviewsFor, trustState, trustReviewerFor, trustJobId, trustGateGoal, trustGateLabel, recordTrustVerdict, type TrustState,
} from '@cubicle/core';
import type { ToolsConfig } from '@cubicle/tools';

/**
 * The trust sweep: deterministic, no model call, one slot in the daemon tick.
 *
 * Three jobs, in this order. It files the two reviews for every outbound call waiting in `00 Inbox/`; it closes a
 * proposal a review has returned, unsent, so the waiting job resumes and is told why; and it says once, out loud,
 * when a review can never answer — an office with nobody to run it, or a review job that ended without a verdict —
 * because a gate that fails closed in silence is indistinguishable from a bug. The two cases differ in what they
 * can do about it: nobody to review means the call stays refused until the owner staffs the office, while a
 * review that ended is recorded as a return, which closes the call and frees its author to file a fresh one.
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
const warned = new Set<string>();

/** Say a thing once per process. Both of the sweep's warnings are about a state that does not change on its own. */
function warnOnce(vault: Vault, mark: string, job: string | null, payload: Record<string, unknown>): void {
  if (warned.has(mark)) return;
  warned.add(mark);
  vault.events.emit({ type: 'daemon.warning', job, payload });
}

/**
 * Why a review job will never answer, or null while it still might.
 *
 * `cancelled` and `failed` are plain. `blocked` is the one that needs care: a review waiting on a quota, on a
 * colleague's answer or on the owner's approval of one of its own calls is still on its way — `requeueUnblocked`
 * and the harness's own resume will wake it. A job that *finished* as blocked is the opposite: nothing requeues
 * it but the owner (`loop.ts`'s entry guard says so in the same words), so its gate would stay pending for ever.
 */
function reviewEnded(j: JobFrontmatter): string | null {
  if (j.status === 'cancelled' || j.status === 'failed') return j.status;
  if (j.status === 'blocked' && j.approval !== 'pending' && (!j.blocked_on || j.blocked_on.kind === 'owner')) return 'blocked';
  return null;
}

/**
 * A review that ended without a verdict is a **return**, for the same reason Decision 14 makes a failed review
 * one: an unfinished review must never become a pass, and — the part that costs more — it must never become a
 * silent hold either. Without this the gate stays pending for ever, the dispatcher holds the proposal for ever,
 * the author's job stays blocked for ever, and nothing in the vault connects the stuck job to the reason. The
 * sweep will not re-file the review (its deterministic id already exists), so nobody else can notice.
 *
 * Returns the state as it stands after any verdict this wrote.
 */
function returnEndedReviews(vault: Vault, note: { path: string; data: InboxFrontmatter }, need: string[], st: TrustState): TrustState {
  const call = note.data.call!;
  let wrote = false;
  for (const gate of st.pending) {
    const id = trustJobId(call.idempotency_key, gate);
    const job = readJob(vault, id);
    if (!job) continue;                       // never filed (an unstaffed office) — that path warns on its own
    const ended = reviewEnded(job.data);
    if (!ended) continue;
    const why = `the ${gate} review ended ${ended} without a verdict`;
    recordTrustVerdict(vault, { key: call.idempotency_key, proposal: note.data.id, gate, verdict: 'return', findings: [why], job: id, by: 'daemon' });
    warnOnce(vault, `ended:${gate}:${note.data.id}`, note.data.job ?? null, {
      where: 'trust.review', gate, proposal: note.data.id, job: id, tool: call.tool,
      message: `${why}, so \`${call.tool}\` in ${note.data.id} is returned unsent rather than held for ever. Requeue ${id} if the office should still read it; the author has to file a fresh call either way.`,
    });
    wrote = true;
  }
  return wrote ? trustState(vault.events, call.idempotency_key, need) : st;
}

/** The gates one stored call owes, or `[]`. The flag is the owner's file; the refinement is the call's own arguments. */
export function trustGatesForNote(cfg: ToolsConfig, d: InboxFrontmatter): string[] {
  if (!d.call) return [];
  return trustReviewsFor(cfg.tools[d.call.tool], d.call.tool, d.call.args);
}

/** The state of a proposal's reviews, or null when it owes none. */
export function trustStateForNote(vault: Vault, cfg: ToolsConfig, d: InboxFrontmatter): TrustState | null {
  const gates = trustGatesForNote(cfg, d);
  if (!gates.length || !d.call) return null;
  return trustState(vault.events, d.call.idempotency_key, gates);
}

/**
 * Drop the reviews a *closed* call no longer needs, and say so in each cancelled job's log.
 *
 * A call whose proposal is resolved can never leave the company — the owner turned it down, or a review already
 * returned it — so a review still sitting in the queue would spend a cheap model call reading something that
 * cannot run, which is exactly the cost Ruling Q14 avoids on the filing side. Only a `queued` review is
 * cancelled: one that is running may be a moment from its verdict, and yanking a job mid-step loses the work.
 * Returns the ids it cancelled (usually none: on the happy path both reviews are long done).
 */
export function cancelPointlessTrustReviews(vault: Vault, gates: string[], key: string, why: string): string[] {
  const out: string[] = [];
  for (const gate of gates) {
    const id = trustJobId(key, gate);
    const job = readJob(vault, id);
    if (!job || job.data.status !== 'queued') continue;
    cancelJob(vault, id, 'daemon', why);
    out.push(id);
  }
  return out;
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
    // A review that has ended without answering is read as a return before anything else, so the call is closed
    // in the same pass rather than held until somebody notices the stuck job.
    let st = trustState(vault.events, call.idempotency_key, need);
    if (st.pending.length) st = returnEndedReviews(vault, note, need, st);
    if (st.returned.length) {
      closeReturned(vault, note, st);
      // The other office's review, if it is still in the queue, is now reading a call that cannot run.
      cancelPointlessTrustReviews(vault, need, call.idempotency_key, `${d.id} was returned by ${st.returned.join(' and ')} and closed unsent, so there is nothing left to review`);
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
        warnOnce(vault, `${gate}:${d.id}`, d.job ?? null, { where: 'trust', gate, proposal: d.id, tool: call.tool, message: `nobody but ${author} can run ${gate}, so \`${call.tool}\` in ${d.id} stays refused and nothing is sent. Staff the office in Memory/constitution.md, or hire into it.` });
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
export function resetTrustWarnings(): void { warned.clear(); }
