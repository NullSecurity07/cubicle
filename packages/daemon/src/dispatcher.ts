import {
  type Vault, listInbox, readJob, updateJob, cancelJob, listJobs, nowIso, parseNote, stringifyNote, createJob, idFromKey, RoleFrontmatter, type InboxFrontmatter, type JobFrontmatter,
  loadOrg, resolveRole, divisionLeadOf, officeHolder, type Org,
  FOUNDER_BRIEF, missingBriefSections, readIdea, updateIdea, ideaBand, bandReason, ideaOutcome, IDEA_SLUG_SRC, IDEA_DECISIONS, LEDGER_PATH, type IdeaBand, type IdeaDecision,
  trustDecision, TRUST_PENDING_HOLD, CLASSIFIER_UNAVAILABLE_HOLD, type TrustDecision,
} from '@cubicle/core';
import { createRoleToolClient, resolveMode, type ToolRegistry, type ToolsConfig, type ToolContext, type SchedulerApi } from '@cubicle/tools';
import { findAnswer, messagePath, isClassifierUnavailable, classifierUnavailableNow } from '@cubicle/tools';
import { PLAN_WAIT_BUDGET_MS, soleStreamForShip } from './heartbeat.js';
import { cancelPointlessTrustReviews, trustGatesForNote, retryOnNextPass } from './trust.js';
import { applyHire, applyFire, applyReorg, charterDiffSection } from './evolution.js';
import { briefRejectionComment, enqueueRejectionDiscovery } from './discovery.js';
import { isValidRoleId, isOwnerOwned, normalizeRel, isSecretPath } from '@cubicle/core';
import { appendObservation } from '@cubicle/harness';

/** `Ideas/<slug>.md`, built from core's slug pattern so this never drifts from `isValidIdeaSlug`. */
const IDEA_TARGET_RE = new RegExp('^Ideas/' + IDEA_SLUG_SRC + '\\.md$');

/** kind → allowed targets. Everything else leaves the note unresolved with a warning (an approval must mean what its title says). */
export function validateTarget(kind: string, target: string, hasCall: boolean): string | null {
  let t: string;
  try { t = normalizeRel(target); } catch (err) { return (err as Error).message; }
  if (!t) return 'empty target';
  if (isSecretPath(t) || t.startsWith('.cubicle/')) return `target ${t} is not writable by proposals`;
  if (kind === 'brand_change') return t.startsWith('Brand/') ? null : `brand_change may only target Brand/ (got ${t})`;
  if (kind === 'charter_change') { const m = t.match(/^Roles\/([^/]+)\.md$/); return m && isValidRoleId(m[1]) ? null : `charter_change may only target Roles/<role>.md (got ${t})`; }
  // The founder brief is the one Memory/ file an agent may propose: every plan is written against it, so it is
  // the owner's to adopt — but it is not owner-*owned*, because the dispatcher is what writes it.
  if (kind === 'founder_brief') return t === FOUNDER_BRIEF ? null : `founder_brief may only target ${FOUNDER_BRIEF} (got ${t})`;
  if (kind === 'idea_verdict') return IDEA_TARGET_RE.test(t) ? null : `idea_verdict may only target Ideas/<slug>.md (got ${t})`;
  if (kind === 'file_change') {
    if (t.startsWith('00 Inbox/') || t.startsWith('Jobs/') || t.startsWith('Messages/')) return `file_change may not target ${t}`;
    if ((t === 'Memory/constitution.md' || t === 'Memory/owner_preferences.md') && !hasCall) return `${t} can only be changed through a harness-generated file_change (with a stored call)`;
    return null;
  }
  return `kind ${kind} does not take a target`;
}

export interface DispatcherDeps {
  vault: Vault;
  registry: ToolRegistry;
  toolsConfig: ToolsConfig;
  scheduler: SchedulerApi;
  env: NodeJS.ProcessEnv;
  /** Phase 7 wires real hire/fire; until then they resolve with a warning. */
  onHire?: (note: { path: string; data: InboxFrontmatter; body: string }) => Promise<string>;
  onFire?: (note: { path: string; data: InboxFrontmatter; body: string }) => Promise<string>;
  /** Called after a proposal is resolved so workers wake. */
  wake?: () => void;
  /**
   * Ruling S-2: the owner's "no" on a founder brief is an instruction, and somebody has to answer it in words.
   * The dispatcher does the half that costs nothing — it reads the comment and queues the re-run — and hands
   * this the half that needs a model: one short paragraph from the chief executive saying what the company will
   * do, and the three fresh ideas when the comment asked for a different one.
   *
   * Optional because the dispatcher must never depend on an LLM to close a note: with no hook wired (every
   * dispatcher-only test, and a daemon whose model is down) the rejection is still collected, the re-run is
   * still queued and the note is still resolved — the owner simply gets no paragraph.
   */
  onBriefRejected?: (note: { path: string; data: InboxFrontmatter; body: string }, ctx: { comment: string; brief: string; discoveryJob: string }) => Promise<void> | void;
  onRoleHired?: (role: string) => void;
  onRoleFired?: (role: string) => void;
  /** How long a question may go unanswered before it escalates to the CEO; defaults to two heartbeat intervals. */
  questionWaitMs?: number;
  /** When this daemon process started; a question's wait is only counted while the daemon was up. */
  startedAt?: number;
  /**
   * True when the company has spent the capital the owner put in (SP4 §5). A dormant company applies no
   * proposal that spends real money: the approval stands and is retried, it is not rejected. Absent means never
   * dormant, which is what every test and every unfunded company wants.
   */
  dormant?: () => boolean;
  guardrails?: { check(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string | null> | string | null }[];
}

/**
 * Why an approved `spend` is not executed while the company is dormant. A fixed string, because it is also the
 * mark: a note already carrying it is left alone rather than rewritten on every retry for the length of the
 * dormancy (see the `spend` case).
 */
export const DORMANT_SPEND_REFUSAL = `the company is out of money and dormant, so nothing is spent; add a \`capital\` row to ${LEDGER_PATH} and this is applied on its own`;

/**
 * The `## Proposed content` block, closed by a fence of exactly the length it opened with. The length matters:
 * a founder brief that quotes a config file or a snippet carries a ``` fence of its own, and a wrapper that
 * closed at the first ``` anywhere would hand the dispatcher a truncated brief — refused, a moment later, for
 * "missing ## Constraints", which tells the owner nothing about the real cause. `founderBriefProposalBody`
 * opens with four backticks for exactly this reason; three-backtick blocks (file_change, brand_change) read the
 * same way they always did.
 */
function fenced(body: string): string | null {
  const m = body.match(/## Proposed content\s*\n+(`{3,})[a-z]*\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/);
  return m ? m[2] + (m[2].endsWith('\n') ? '' : '\n') : null;
}

/**
 * The same block, for callers outside this module. The rejected-brief path (ruling S-2) has to hand the research
 * office the brief the owner turned down, and it must be the *same* bytes the apply path would have written —
 * a second reader with its own fence regex is how the two quietly drift apart.
 */
export function proposedContent(body: string): string | null { return fenced(body); }

/**
 * Leave a proposal unresolved with a reason. The footer write is a system write (sha now matches), so the owner's
 * approval is remembered via `refused_sha`/`refused_at`: the note is retried when the owner edits it again or after 10 minutes.
 *
 * `closing` is the sentence after the reason, and it is a parameter because the default one is wrong for a hold:
 * "fix it and set approved again" is the one thing the owner must *not* do under a trust hold, where the note is
 * correct, the approval already stands, and the only thing missing is two verdicts nobody at the keyboard can
 * supply. A refusal the owner can act on keeps the default.
 */
const FIX_IT = 'Fix it and set approved again (retried automatically every 10 minutes).';
/** Under a hold there is nothing to fix and nothing to re-approve: the sweep releases it the moment both offices answer. */
const NOTHING_TO_DO = 'Nothing to do: this is applied on its own as soon as both reviews are in, and closed unsent if either returns it.';
/**
 * Same shape as the trust hold: nothing is wrong with the note, so "fix it and approve again" is the wrong
 * advice — and, like the trust hold, it is retried on the *next* pass rather than on the ten-minute timer, so
 * it does not promise the owner a wait it no longer takes.
 */
const NOTHING_TO_FIX = 'Nothing to do: it is sent on its own on the next cycle, as soon as a model answers the guardrail again.';

function refuseNote(vault: Vault, note: { path: string; data: InboxFrontmatter }, why: string, extra: Record<string, unknown> = {}): void {
  const closing = why === TRUST_PENDING_HOLD ? NOTHING_TO_DO : why === CLASSIFIER_UNAVAILABLE_HOLD ? NOTHING_TO_FIX : FIX_IT;
  // A classifier that could not run refused nothing — it decided nothing at all — so it gets its own event.
  // `guardrail.blocked` is rendered as "not allowed", with a worried face, which is the exact opposite of
  // what this note's own footer tells the owner (re-review 1, minor).
  const type = why === CLASSIFIER_UNAVAILABLE_HOLD ? 'guardrail.deferred' as const : 'guardrail.blocked' as const;
  vault.events.emit({ type, payload: { proposal: note.data.id, kind: note.data.kind, reason: why, ...extra } });
  vault.updateNote(note.path, (nn) => ({ data: { ...nn.data, refused: why, refused_at: nowIso() }, body: nn.body.replace(/\n\n---\n_Not applied:[^\n]*_\n?$/s, '').trimEnd() + `\n\n---\n_Not applied: ${why}. ${closing}_\n` }), 'daemon');
  const sha = vault.currentSha(note.path);
  if (sha) vault.db.prepare('INSERT OR REPLACE INTO refusals(path, sha, at) VALUES (?, ?, ?)').run(note.path, sha, nowIso());
}

/**
 * Hold a note the constitution guardrail could not check, and leave it due on the next pass.
 *
 * The whole point of the hold is that nothing was decided: `approved` stands, the idempotency key is unspent,
 * `resolved_at` is never stamped and the `refusals` row (which is what carries the approval across the hold)
 * is kept. Written once per episode — a model outage can run for a while, and re-writing the note and its
 * autocommit on every pass over a fact that has not changed is the churn the dormancy refusal and the trust
 * hold are both written once for.
 */
function holdForClassifier(vault: Vault, note: { path: string; data: InboxFrontmatter }): void {
  if ((note.data as { refused?: string }).refused !== CLASSIFIER_UNAVAILABLE_HOLD) refuseNote(vault, note, CLASSIFIER_UNAVAILABLE_HOLD);
  retryOnNextPass(vault, note.path);
}

/**
 * True when the constitution guardrail cannot check this note's stored call *right now*, because its
 * classifier could not reach a model.
 *
 * Only that one answer is acted on here. A real refusal — a banned tactic, a banned channel, a daily cap — is
 * left to whoever executes the call, exactly as it was before: for a `spend` that is `executeStoredCall` a
 * few lines later, and for an `outbound_batch` it is the waiting job's own resume, which records the block on
 * the job where the author can read it. This function exists only so that a call nobody could check is not
 * closed on its way past.
 */
async function classifierCannotCheck(deps: DispatcherDeps, note: { path: string; data: InboxFrontmatter }): Promise<boolean> {
  const call = note.data.call;
  if (!call || !deps.guardrails?.length) return false;
  // The classifier's own round trip is bounded at 20 s and runs *inside* the tick. Asking it once per held
  // note per pass was a minute of tick against a thirty-second interval for three held notes, which delays
  // `requeueUnblocked` — the only requeue path in the repo — for every blocked job in the company (re-review
  // 2, I2). One probe per outage per memo window answers for all of them: whoever gets here first pays for
  // it, everyone else reads the answer.
  if (classifierUnavailableNow()) return true;
  const roleId = call.role ?? note.data.from;
  const roleNote = deps.vault.readNoteOrNull(`Roles/${roleId}.md`);
  if (!roleNote) return false;
  const jobId = call.job ?? note.data.job ?? null;
  const ctx: ToolContext = { vault: deps.vault, events: deps.vault.events, roleId, role: RoleFrontmatter.parse(roleNote.data), jobId, config: deps.toolsConfig, env: deps.env, scheduler: deps.scheduler, workspace: `.cubicle/workspace/${jobId ?? 'daemon'}`, now: () => new Date(), idempotencyKey: call.idempotency_key, guardrails: deps.guardrails };
  for (const g of deps.guardrails) {
    const v = await g.check(call.tool, call.args, ctx);
    if (v) return isClassifierUnavailable(v);
  }
  return false;
}

function retryDue(vault: Vault, note: { path: string; data: InboxFrontmatter }): boolean {
  const row = vault.db.prepare('SELECT sha, at FROM refusals WHERE path = ?').get(note.path) as { sha: string; at: string } | undefined;
  if (!row) return false;
  return vault.currentSha(note.path) !== row.sha || Date.now() - Date.parse(row.at) > 10 * 60_000;
}

/**
 * The trust state of a stored call, or null when it owes no review. The dispatcher's whole part in SP5: it never
 * *closes* a returned call (the sweep does, whatever the approval flag says — Decision 19) and it never sends a
 * pending one.
 */
function trustGuard(deps: DispatcherDeps, d: InboxFrontmatter): TrustDecision | null {
  return d.call ? trustDecision(deps.vault.events, deps.toolsConfig.tools[d.call.tool], d.call) : null;
}

/**
 * True when the dispatcher must not apply this leaving call on this pass, having left whatever mark it owes.
 *
 * Two states, one answer — leave the note unresolved:
 *
 * - **hold**: the reviews are still out. Refused once per episode with a fixed reason and retried, so the owner's
 *   approval stands, nothing is spent, and the idempotency key is still there when the verdicts land.
 * - **returned**: a verdict landed between this tick's sweep and this moment. The sweep owns the close
 *   (Decision 19, Ruling Q9), so the note is left exactly as it is and the next sweep — seconds away, and always
 *   ahead of the dispatcher — writes the resolution footer that says the call was returned and nothing was sent.
 *   Resolving it here would stamp "approved; the waiting job resumes" on a call that was refused, which is the
 *   one sentence the owner must never read on it; and on a `spend` it would burn the idempotency key to reach a
 *   refusal the tool layer was always going to give.
 */
function trustDefers(deps: DispatcherDeps, note: { path: string; data: InboxFrontmatter }, trust: TrustDecision | null): boolean {
  if (!trust || trust.kind === 'clear') return false;
  if (trust.kind === 'hold' && (note.data as { refused?: string }).refused !== TRUST_PENDING_HOLD) refuseNote(deps.vault, note, TRUST_PENDING_HOLD);
  return true;
}

/**
 * Execute a stored call as the daemon, with the original role's permissions and the stored idempotency key.
 *
 * `deferred` means the call was neither made nor refused: something transient stopped it, the note must be
 * held rather than resolved, and the next sweep tries again. Only the constitution classifier's
 * "nobody could check this" sets it today.
 */
export async function executeStoredCall(deps: DispatcherDeps, note: { path: string; data: InboxFrontmatter }): Promise<{ ok: boolean; text: string; deferred?: boolean }> {
  const call = note.data.call!;
  // A guardrail refused this call inside the tool layer after the owner approved it. The handler provably
  // never ran, but the idempotency key is already in the job's at-most-once ledger and that ledger is
  // append-only, so the call cannot be retried under this approval. Say so, rather than reporting it as
  // interrupted or already executed; the owner needs a fresh proposal once the reason no longer applies.
  const vetoed = (note.data as { blocked_by_guardrail?: string }).blocked_by_guardrail;
  if (vetoed) return { ok: false, text: `blocked by a guardrail after approval and not executed (${vetoed}); its idempotency key is spent, so file a fresh proposal once that no longer applies` };
  const roleId = call.role ?? note.data.from;
  const roleNote = deps.vault.readNoteOrNull(`Roles/${roleId}.md`);
  if (!roleNote) return { ok: false, text: `no charter for ${roleId}` };
  const role = RoleFrontmatter.parse(roleNote.data);
  const jobId = call.job ?? note.data.job ?? null;
  // The approval is older than the config: the tool's mode may have moved to `never` (in tools.yaml, in this
  // role's charter, or in the owner's preferences) since the proposal was filed. The wrapper would refuse the
  // call anyway, but only after the idempotency key was spent, so the check happens here instead and the key
  // stays unspent. Note that the proposal itself is finished either way: `dispatchProposals` stamps `resolved_at`
  // on the note straight after this returns, so relaxing the mode does not re-dispatch it — the owner has to
  // clear `resolved_at` (or file a fresh proposal) for the unspent key to be worth anything (M7).
  const mode = resolveMode(call.tool, deps.toolsConfig, role, deps.vault.ownerPreferences());
  if (mode === 'never') {
    const reason = `${call.tool} is set to mode never; the owner's configuration outranks this approval`;
    deps.vault.events.emit({ type: 'guardrail.blocked', agent: roleId, job: jobId, payload: { tool: call.tool, reason, approved: true } });
    return { ok: false, text: `blocked even though approved: ${reason}` };
  }
  // Everything above and below this line is read-only, up to the `executing_at` stamp: nothing may spend the
  // idempotency key until the call is actually about to be made.
  if ((note.data as { executing_at?: string }).executing_at) return { ok: false, text: 'a previous attempt was interrupted after starting this call; not re-running it (lost result)' };
  const job = jobId ? readJob(deps.vault, jobId) : null;
  if (job && job.data.side_effects_done.includes(call.idempotency_key)) return { ok: true, text: 'already executed (idempotency key recorded)' };
  const ctx: ToolContext = { vault: deps.vault, events: deps.vault.events, roleId, role, jobId, config: deps.toolsConfig, env: deps.env, scheduler: deps.scheduler, workspace: `.cubicle/workspace/${jobId ?? 'daemon'}`, now: () => new Date(), idempotencyKey: call.idempotency_key, guardrails: deps.guardrails };
  const def = deps.registry.get(call.tool);
  if (!def) return { ok: false, text: `unknown tool ${call.tool}` };
  // The guardrail pre-check runs **before** the key is spent, for the same reason the `mode: never` check
  // above does: a guardrail that refuses proves the handler never ran, and spending the key on a call that
  // never happened destroys the owner's approval for nothing.
  //
  // It matters more now that the constitution's classifier can fail closed. Its refusal has two kinds, and
  // they end very differently (review round 1, CRITICAL): a rule that was broken is a standing answer and the
  // call is finished, but a classifier that could not reach a model has decided nothing at all. The second
  // used to be indistinguishable from the first here, so a single 20-second model outage killed an
  // owner-approved send for good — and the re-dispatch said "a previous attempt was interrupted after
  // starting this call (lost result)", which was flatly untrue: nothing had started. Now the approval, the
  // note and the key all survive it, `dispatchProposals` holds the note instead of resolving it, and the
  // next sweep tries again.
  for (const g of deps.guardrails ?? []) {
    const v = await g.check(call.tool, call.args, ctx);
    if (!v) continue;
    if (isClassifierUnavailable(v)) return { ok: false, deferred: true, text: CLASSIFIER_UNAVAILABLE_HOLD };
    deps.vault.events.emit({ type: 'guardrail.blocked', agent: roleId, job: jobId, payload: { tool: call.tool, reason: v, approved: true } });
    return { ok: false, text: `blocked even though approved: ${v}` };
  }
  // At-most-once: mark the note (and the job) BEFORE running the external call.
  deps.vault.updateNote(note.path, (n) => ({ data: { ...n.data, executing_at: nowIso() }, body: n.body }), 'daemon');
  if (job) updateJob(deps.vault, job.data.id, { side_effects_done: [...job.data.side_effects_done, call.idempotency_key] }, 'daemon', `- ${nowIso()}: ${call.tool} ATTEMPTING by the daemon after owner approval (${call.idempotency_key})`);
  const client = await createRoleToolClient([def], ctx);
  try {
    const res = await client.call(call.tool, call.args, { idempotencyKey: call.idempotency_key });
    // The wrapper can still veto a call this function's pre-check cleared (a guardrail whose answer moved
    // between the two). Record that on the note so a re-approval reports the block instead of the spent key.
    if (res.guardrailBlocked) deps.vault.updateNote(note.path, (n) => ({ data: { ...n.data, blocked_by_guardrail: res.guardrailBlocked }, body: n.body }), 'daemon');
    if (job) updateJob(deps.vault, job.data.id, {}, 'daemon', `- ${nowIso()}: ${call.tool} → ${res.guardrailBlocked ? `BLOCKED (${res.guardrailBlocked})` : res.ok ? 'ok' : 'failed'}`);
    return { ok: res.ok, text: res.text };
  } finally {
    await client.close();
  }
}

/**
 * A founder brief the owner turned down (ruling S-2). Three things happen, in the order that survives a kill:
 *
 * 1. the re-run is queued — deterministic id, so a replayed tick re-finds it rather than queueing a second;
 * 2. the chief executive answers the comment in the owner's inbox, through `onBriefRejected`;
 * 3. the note is resolved by the caller, saying which of the two got done.
 *
 * The queue comes first because it is the part that must not be lost: a model that is down (or a hook nobody
 * wired) costs the owner a paragraph, and the company still reads their words on the next cycle. The answer is
 * wrapped because a failing model call must not leave the note unresolved and re-dispatched every tick.
 *
 * Planning stays where ruling S-1 put it: there is no brief, so `hasApprovedBrief` is false and the heartbeat's
 * four planning steps wait. Nothing here has to say so.
 */
async function rejectBrief(deps: DispatcherDeps, note: { path: string; data: InboxFrontmatter; body: string }, d: InboxFrontmatter): Promise<string> {
  const vault = deps.vault;
  const comment = briefRejectionComment(note);
  const brief = fenced(note.body) ?? '';
  let job: string;
  try {
    job = enqueueRejectionDiscovery(vault, loadOrg(vault), { proposalId: d.id, comment, brief });
  } catch (err) {
    vault.events.emit({ type: 'daemon.warning', payload: { where: 'dispatcher.founder_brief_rejected', proposal: d.id, message: `could not queue the re-run: ${String((err as Error).message ?? err).slice(0, 200)}` } });
    return 'rejected; the re-run could not be queued';
  }
  let answered = false;
  try {
    if (deps.onBriefRejected) { await deps.onBriefRejected(note, { comment, brief, discoveryJob: job }); answered = true; }
  } catch (err) {
    vault.events.emit({ type: 'daemon.warning', payload: { where: 'dispatcher.founder_brief_rejected', proposal: d.id, message: `the CEO could not answer the rejection: ${String((err as Error).message ?? err).slice(0, 200)}` } });
  }
  return `rejected; discovery re-runs as ${job} on what you said${answered ? ', and the CEO has answered it in 00 Inbox/' : ''}`;
}

/**
 * R31: for every inbox note with `approved` set and no `resolved_at`, dispatch by kind, stamp `resolved_at`,
 * emit `proposal.resolved`. Also requeues blocked jobs whose wait condition is now satisfied.
 */
export async function dispatchProposals(deps: DispatcherDeps): Promise<number> {
  const vault = deps.vault;
  let n = 0;
  for (const note of listInbox(vault)) {
    const d = note.data;
    // Only the owner flips approvals: the note's sha must differ from the last system write (agents cannot write 00 Inbox/ at all).
    const ownerFlipped = vault.isOwnerChanged(note.path);
    // Owner answered an agent's question (kind: message, to: owner)
    if (d.kind === 'message' && d.to === 'owner' && d.from !== 'owner' && d.answered && !d.resolved_at) {
      if (!ownerFlipped) { vault.events.emit({ type: 'guardrail.blocked', payload: { proposal: d.id, reason: 'answered flag was not set by the owner' } }); continue; }
      const answer = (note.body.split('## Owner')[1] ?? note.body.split('\n').slice(-8).join('\n')).trim();
      if (!answer) { vault.events.emit({ type: 'daemon.warning', payload: { proposal: d.id, reason: 'answered: true but no answer text under "## Owner"' } }); continue; }
      vault.appendText(`Messages/${d.from}.md`, `\n## ${nowIso()} from owner (fyi) <!-- id:msg_${d.id} -->\n\nre:${d.id} ${answer}\n`, 'daemon');
      vault.updateNote(note.path, (nn) => ({ data: { ...nn.data, resolved_at: nowIso() }, body: nn.body }), 'daemon');
      vault.events.emit({ type: 'proposal.resolved', agent: 'owner', job: d.job ?? null, payload: { id: d.id, kind: 'message', answered: true } });
      n++;
      continue;
    }
    if (d.kind === 'message' || d.resolved_at) continue;
    // D6: the owner should not have to diff a charter by eye. An unapproved charter_change gets a `## Diff`
    // block written above its "## Proposed content" showing exactly what the rewrite changes. Only unapproved
    // notes are touched, so this system write never lands between the owner's flip and `isOwnerChanged`.
    if (d.kind === 'charter_change' && d.approved === null && d.target && !/^## Diff$/m.test(note.body)) {
      const section = charterDiffSection(vault, d.target, fenced(note.body));
      // The section is written even when there is nothing to diff: it tells the owner why, and its `## Diff`
      // heading is what stops this being recomputed on every tick while the note waits for approval.
      // Function replacement, not a string: a diff line containing `$&` or `$1` must land verbatim.
      vault.updateNote(note.path, (nn) => ({
        data: nn.data,
        body: nn.body.includes('## Proposed content')
          ? nn.body.replace('## Proposed content', () => section + '## Proposed content')
          : nn.body.trimEnd() + '\n\n' + section.trimEnd() + '\n',
      }), 'daemon');
    }
    // Constitution autonomy flags: the owner pre-approved these kinds; the daemon approves agent-created notes
    // itself. Which seat each flag trusts is an office lookup, not a role id (M6): `auto_approve_hire` and
    // `auto_approve_reorg` mean "what the chief executive files" and `auto_approve_charter_changes` means "the
    // engineering office's compression output" (spec §9.2), so re-staffing either seat must move the trust with
    // it rather than quietly switching the flag off for the live holder and leaving it on for a retired id.
    const c = vault.constitution();
    const chiefExecutive = officeHolder(loadOrg(vault), 'chief_executive');
    const engineering = officeHolder(loadOrg(vault), 'engineering');
    const autoApproved = d.approved === null && ((d.kind === 'hire' && c.auto_approve_hire && d.from === chiefExecutive) || (d.kind === 'charter_change' && c.auto_approve_charter_changes && d.from === engineering) || (d.kind === 'reorg' && c.auto_approve_reorg && d.from === chiefExecutive));
    if (d.approved === null && !autoApproved) continue;
    const previouslyRefused = !!(d as { refused?: string }).refused;
    if (autoApproved) {
      vault.updateNote(note.path, (nn) => ({ data: { ...nn.data, approved: true, approved_by: 'constitution' }, body: nn.body }), 'daemon');
      d.approved = true;
    } else if (previouslyRefused) {
      if (!retryDue(vault, note)) continue; // the owner's earlier flip stands; retry on edit or every 10 min
    } else if (!ownerFlipped) {
      vault.events.emit({ type: 'guardrail.blocked', payload: { proposal: d.id, reason: 'approval flag was not set by the owner (sha matches a system write); ignoring' } });
      continue;
    }
    let outcome = '';
    try {
      // A rejected proposal is closed and nothing is executed — except an idea_verdict, where `approved: false`
      // is itself a decision (the owner parks the idea) rather than a refusal to act.
      if (d.approved === false && d.kind !== 'idea_verdict') {
        outcome = 'rejected';
        // …except a founder brief, where "rejected" on its own was the whole of the live run's second failure
        // (finding S1): the owner typed "rejected make it better or get a new idea" into the note, the company
        // closed it without reading a word of that, planned anyway, and nobody ever went back to the brief.
        // A rejection is a rewrite request, so it buys exactly what an approval buys — a job, and an answer.
        if (d.kind === 'founder_brief') outcome = await rejectBrief(deps, note, d);
      } else {
        switch (d.kind) {
          case 'hire':
          case 'fire': {
            const r = d.kind === 'hire' ? (deps.onHire ? await deps.onHire(note) : await applyHire(vault, note, deps.onRoleHired, { autoApproved })) : (deps.onFire ? await deps.onFire(note) : await applyFire(vault, note, deps.onRoleFired));
            if (!/^(hired|fired) /.test(r)) { refuseNote(vault, note, r); continue; }
            outcome = r;
            break;
          }
          case 'reorg': {
            const r = await applyReorg(vault, note);
            if (!/^applied/.test(r)) { refuseNote(vault, note, r); continue; }
            outcome = r;
            break;
          }
          case 'brand_change':
          case 'charter_change':
          case 'file_change': {
            const target = d.target;
            if (!target) { outcome = 'no target path on proposal'; break; }
            const invalid = validateTarget(d.kind, target, !!d.call);
            if (invalid) { refuseNote(vault, note, invalid, { target }); continue; }
            let content = (d.call?.tool === 'vault.write' && typeof d.call.args.content === 'string') ? String(d.call.args.content) : fenced(note.body);
            if (d.kind === 'brand_change' && target === 'Brand/name.md' && !content) {
              const options = note.body.split('\n').filter((l) => /^\s*\d+\.\s/.test(l));
              const line = d.chosen ? options.find((l) => new RegExp(`^\\s*${d.chosen}\\.\\s`).test(l)) : undefined;
              if (options.length && !line) { refuseNote(vault, note, d.chosen ? `chosen: ${d.chosen} matches no option; set chosen: 1..${options.length}` : `set chosen: 1..${options.length} to pick an option`); continue; }
              if (line) {
                const clean = (x: string) => x.replace(/[*_`]/g, '').trim();
                const name = clean(line.replace(/^\s*\d+\.\s*/, '').split(/\s+—\s+|\s+-\s+|:/)[0]);
                const tagline = clean(line.split(/\s+—\s+|\s+-\s+/)[1] ?? '');
                content = stringifyNote({ name, tagline, url: '' }, `# ${name}\n\n${tagline}\n`);
              }
            }
            if (!content) { outcome = 'no "## Proposed content" block found'; break; }
            if (d.kind === 'charter_change') {
              // A charter change edits the *body* and tools of an existing role. Identity and staffing fields belong to the
              // owner (spec §11) and to hire/fire (§9.5): they are carried over from the current note, never taken from the proposal.
              const current = vault.readNoteOrNull(target);
              const cur = current && RoleFrontmatter.safeParse(current.data);
              const refuse = (why: string) => refuseNote(vault, note, why, { target });
              if (!cur || !cur.success) { refuse('charter_change may only edit an existing role (use a hire proposal to add one)'); continue; }
              const incoming = parseNote(content);
              const parsed = RoleFrontmatter.safeParse({ ...incoming.data, role: cur.data.role, desk: cur.data.desk, hired: cur.data.hired, sprite: cur.data.sprite, active: cur.data.active, model_tier: cur.data.model_tier, display: cur.data.display });
              if (!parsed.success) { refuse('charter frontmatter does not validate'); continue; }
              if (autoApproved) {
                // Auto-approval covers only the engineering office's compression output (spec §9.2) and may not widen tools or loosen approvals.
                const widened = parsed.data.tools.filter((t) => !cur.data.tools.some((c) => c === t || (c.endsWith('.*') && t.startsWith(c.slice(0, -1)))));
                const order: Record<string, number> = { auto: 0, propose: 1, ask: 2, never: 3 };
                const loosened = Object.entries(parsed.data.approval_overrides).filter(([k, v]) => k in cur.data.approval_overrides && order[v] < order[cur.data.approval_overrides[k]]);
                if (d.from !== engineering) { refuse(`auto_approve_charter_changes applies to the engineering office's (${engineering}) compression proposals only (this one is from ${d.from})`); continue; }
                if (widened.length) { refuse(`auto-approved charter changes may not add tools (${widened.join(', ')}); the owner must approve this one`); continue; }
                if (loosened.length) { refuse(`auto-approved charter changes may not loosen approval overrides (${loosened.map(([k]) => k).join(', ')})`); continue; }
                if (!incoming.body.trim() || incoming.body.length > (current!.body.length + 200)) { refuse('auto-approved compression must not lengthen the charter (or empty it)'); continue; }
              }
              content = stringifyNote(parsed.data as Record<string, unknown>, incoming.body);
            }
            vault.writeText(target, content, 'daemon', { job: d.job ?? null });
            outcome = `applied to ${target}`;
            if (target.startsWith('Brand/')) {
              const open = listJobs(vault, { status: ['queued', 'running', 'blocked'] }).some((j) => j.type === 'engineer.ship' && /reconcile site with brand/i.test(j.title));
              // Ruling S-6b, and the same rule the heartbeat's own reconcile step applies (`soleStreamForShip`):
              // an `engineer.ship` with no stream is refused by the CI gate *after* the work is done, so the
              // stream is settled before the job exists. None or several to choose from and nothing is queued —
              // the approval still applied, and the note's footer says why no job followed it.
              if (!open) {
                const s = soleStreamForShip(vault);
                if (s.refuse) {
                  outcome = `${outcome}; no reconcile job: ${s.refuse}`;
                  vault.events.emit({ type: 'daemon.warning', payload: { where: 'dispatcher.reconcile_brand', proposal: d.id, message: s.refuse } });
                } else {
                  createJob(vault, { type: 'engineer.ship', title: 'Reconcile site with brand', assigned: resolveRole(loadOrg(vault), 'engineer'), priority: 2, stream: s.stream, goal: `${target} changed (owner approved a proposal). Read Brand/ and update Site/ to match. Never revert owner edits under Site/.` }, 'daemon');
                }
              }
            }
            break;
          }
          case 'spend': {
            // Before the dormancy check: a proposal with nothing to execute is finished in one pass whatever the
            // money says, rather than being held for a spend that could never have happened.
            if (!d.call) { outcome = 'no stored call'; break; }
            // A dormant company does not spend. The owner approved this before the money ran out, so the note is
            // held rather than rejected: `refuseNote` keeps `approved: true` and records the refusal, and
            // `retryDue` re-admits the note ten minutes later, so the `capital` row that ends the dormancy is
            // what applies it — with no second approval to give and the idempotency key still unspent.
            //
            // Written **once** per episode, however long the dormancy lasts. A dormancy can run for days, and
            // rewriting the note body and emitting `guardrail.blocked` every ten minutes for all of them would
            // churn the vault (and its autocommits) over a fact that has not changed. Every other refusal reason
            // is something the owner can fix in seconds, which is why they can afford to repeat themselves.
            //
            // As everywhere else in SP4, a dormancy check that throws reads as "not dormant" — the failure mode
            // is a company that keeps working, never one that silently stops.
            let dormant = false;
            try { dormant = deps.dormant?.() ?? false; } catch { dormant = false; }
            if (dormant) {
              if ((d as { refused?: string }).refused !== DORMANT_SPEND_REFUSAL) refuseNote(vault, note, DORMANT_SPEND_REFUSAL);
              continue;
            }
            // Spec §3: nothing is spent while the reviews are out. The hold is written once per episode, like the
            // dormancy refusal above and for the same reason — the fact has not changed, and re-writing the note
            // every ten minutes would churn the vault and its autocommits over it. See `trustDefers`.
            if (trustDefers(deps, note, trustGuard(deps, d))) continue;
            const r = await executeStoredCall(deps, note);
            // Nothing was sent and nothing was decided — the guardrail could not reach a model. Hold the
            // note exactly as the dormancy and trust cases do: the approval stands, the key is unspent, and
            // the footer is written once per episode, for the same reason theirs are.
            //
            // But it is due on the **next pass**, not in ten minutes. The refusal machinery's timer was
            // chosen for a dormancy that lasts days; a model outage clears in seconds, and making an
            // owner-approved send wait ten minutes for a twenty-second interruption is the same complaint
            // SP5's I1 made about the trust hold. Same lever, `retryOnNextPass`: the row stays — it is what
            // carries the owner's standing approval — and only its clock is moved.
            if (r.deferred) { holdForClassifier(vault, note); continue; }
            outcome = `${d.call.tool}: ${r.ok ? 'ok' : 'failed'} — ${r.text.slice(0, 200)}`;
            break;
          }
          case 'outbound_batch': {
            // The same two deferrals as `spend`: an approved send whose reviews are still out is left exactly as
            // it is — unresolved, its job still blocked, its idempotency key unspent — and one a verdict returned
            // in the last few seconds is left to the sweep, which says so in its own footer.
            const trust = trustGuard(deps, d);
            if (trustDefers(deps, note, trust)) continue;
            // A third deferral, and the one that matters most here: **every** tool the constitution's
            // classifier reads is an `outbound_batch` (`email.send`, `social.post`, `mock.outbound`,
            // `browser.submit`), so this is the branch a classifier outage actually lands on — the `spend`
            // tools carry no outbound copy and never reach the classifier at all (re-review 1, CRITICAL).
            // Resolving the note here while no model can check the call would close the owner's approval on
            // a send that was never decided about: the waiting job resumes a moment later, finds a note it
            // can no longer be held by, and records a permanent "blocked even though approved" for a
            // twenty-second outage. Hold it instead, and let the next cycle send it.
            if (await classifierCannotCheck(deps, note)) { holdForClassifier(vault, note); continue; }
            // The blocked job executes the stored call itself on resume (R30); just wake it. A call that owed
            // reviews says which decision released it: on that note "approved" is only the owner's half, and the
            // footer is the one place the owner can read that the offices agreed too.
            outcome = trust ? 'cleared by the compliance and security offices; the waiting job resumes' : 'approved; the waiting job resumes';
            break;
          }
          case 'threat_model':
            // Nothing to execute: the approval is the decision (§27). The blocked job resumes on the next tick
            // either way — `d.approved` is always true here, since `d.approved === false` was handled above,
            // before this switch, as a plain 'rejected' outcome common to every proposal kind.
            outcome = 'threat model accepted; the job may finish';
            break;
          case 'founder_brief': {
            const target = d.target ?? FOUNDER_BRIEF;
            const invalid = validateTarget('founder_brief', target, !!d.call);
            if (invalid) { refuseNote(vault, note, invalid, { target }); continue; }
            const content = fenced(note.body);
            if (!content) { outcome = 'no "## Proposed content" block found'; break; }
            // The owner may have edited the block before approving it; a brief that lost a section on the way
            // is refused rather than adopted, because every plan from here on is written against this file.
            // The proposal's own `created`, so a brief filed before the pressure test existed is adopted on
            // the owner's click rather than refused for a section the company had not thought of (spec §4).
            // `## Pressure test` counts only when it is written: a brief carrying the heading with the
            // template's own instructions under it has not taken the test, and §4 is that the brief takes it
            // once (ruling H5). The other seven are still judged on the heading.
            const missing = missingBriefSections(content, String(note.data.created ?? ''));
            if (missing.length) { refuseNote(vault, note, `the founder brief has not written ${missing.join(', ')}; write the section(s) and approve again`, { target }); continue; }
            vault.writeText(target, content, 'daemon', { job: d.job ?? null });
            outcome = `founder brief adopted at ${target}`;
            break;
          }
          case 'idea_verdict': {
            const target = d.target ?? '';
            const invalid = validateTarget('idea_verdict', target, !!d.call);
            if (invalid) { refuseNote(vault, note, invalid, { target }); continue; }
            const slug = target.slice('Ideas/'.length).replace(/\.md$/, '');
            const card = readIdea(vault, slug);
            if (!card) { refuseNote(vault, note, `no idea card at ${target}`, { target }); continue; }
            // The band the owner was *shown*, stamped on the note when the board filed it — not a fresh
            // recomputation. The note's body says "Set approved: true to take the recommendation (**keep**)";
            // if any office re-filed the card between the session and the click (a corrected value, a research
            // re-file), a recomputation would apply `park`, or `scrap`, on the same click. The after-hours
            // closer already rules on `note.data.band` for this reason; one rule, both closers. A note filed
            // before the stamp existed carries none, and falls back to the card as it stands.
            const stamped = (d as { band?: string }).band;
            const band = (IDEA_DECISIONS.includes(stamped as IdeaDecision) && stamped !== 'undecided' ? stamped as IdeaBand : undefined)
              ?? (card.data.score === null
                ? 'park'   // unscored and ruled on anyway: park it rather than invent a recommendation
                : ideaBand(card.data.score, { value: card.data.score_inputs.value ?? 3, board: card.data.board_verdict }));
            // ideaOutcome can also return 'pending' (approved === null), but the dispatcher never reaches this
            // switch for that case — approved === null is skipped above unless auto-approved, which never
            // applies to idea_verdict, so `decision` here is always a real IdeaBand.
            const decision = ideaOutcome({ approved: d.approved, chosen: d.chosen, band }) as IdeaBand;
            // The sentence the owner was shown, stamped beside the band it explains — not a recomputation. On
            // the very case the stamped band exists for (a card re-filed between the session and the click) a
            // fresh `bandReason` would print arithmetic that recommends something other than the decision
            // written directly above it.
            const stampedReason = typeof (d as { band_reason?: unknown }).band_reason === 'string' ? String((d as { band_reason?: string }).band_reason) : '';
            const reason = stampedReason || (card.data.score === null ? 'The card was never scored.' : bandReason(card.data.score, { value: card.data.score_inputs.value ?? 3, board: card.data.board_verdict }));
            const why = d.approved === false
              ? 'The owner turned it down. Parked, not scrapped: the research behind it survives for a later cycle.'
              : d.chosen !== null
                ? `The owner overruled the recommendation (${band}) with \`chosen: ${d.chosen}\`.`
                : `The owner took the recommendation. ${reason}`;
            updateIdea(vault, slug, {
              decision, decided_by: 'owner', decided_at: nowIso(),
              status: decision === 'scrap' ? 'rejected' : decision === 'keep' ? 'accepted' : 'triaged',
            }, 'daemon', { heading: '## Decision', content: `**${decision}** — the owner, ${nowIso().slice(0, 10)}.\n\n${why}` });
            outcome = `idea ${slug}: ${decision}`;
            break;
          }
          case 'plan_verdict':
            // Stamping `resolved_at` is all the dispatcher owes this kind, and the common write below does that:
            // the heartbeat reads `approved` on its next pass, fans the plan out and stamps `fanned_out` itself
            // (see openPlanVerdict). `d.approved` is always true here — a rejection took the 'rejected' branch
            // above — and a rejected note needs nothing further: unfanned and rejected is already closed.
            outcome = 'plan approved: the divisions plan against it';
            break;
        }
      }
    } catch (err) {
      outcome = `dispatch error: ${(err as Error).message}`;
      vault.events.emit({ type: 'daemon.warning', payload: { where: 'dispatcher', proposal: d.id, message: outcome } });
    }
    vault.updateNote(note.path, (nn) => { const { refused: _r, refused_at: _a, ...rest } = nn.data as Record<string, unknown>; return { data: { ...rest, resolved_at: nowIso() }, body: nn.body.trimEnd() + `\n\n---\n_Resolved ${nowIso()}: ${outcome}_\n` }; }, 'daemon');
    vault.db.prepare('DELETE FROM refusals WHERE path = ?').run(note.path);
    // The note is closed, so its call can never run — above all when the owner said no while the two reviews were
    // still out (C1). A review left in the queue would spend a cheap model call on a call nobody can send.
    if (d.call) cancelPointlessTrustReviews(vault, trustGatesForNote(deps.toolsConfig, d), d.call.idempotency_key, `${d.id} was closed (${outcome.slice(0, 100)}) before this review ran, so there is nothing left to review`);
    vault.events.emit({ type: 'proposal.resolved', agent: 'owner', job: d.job ?? null, payload: { id: d.id, kind: d.kind, approved: d.approved, outcome } });
    n++;
  }
  n += requeueUnblocked(vault, deps.questionWaitMs, {
    sinceFloor: deps.startedAt ?? DAEMON_STARTED_AT,
    trustHeld: (d) => trustGuard(deps, d)?.kind === 'hold',
  });
  if (n) deps.wake?.();
  return n;
}

/** Two heartbeat intervals (spec §8: 6 h) — the same default `defaultConfig` computes. */
export const DEFAULT_QUESTION_WAIT_MS = 12 * 3600_000;
/** Process start: the dispatcher tick's floor for question waits (see requeueUnblocked). */
const DAEMON_STARTED_AT = Date.now();

/** The colleague question `id` as it was written into some role's `Messages/` note: who asked, who owes an answer, and what was asked. */
export function findQuestion(vault: Vault, id: string): { to: string; from: string; body: string } | null {
  const marker = `<!-- id:${id}`;
  for (const rel of vault.list('Messages', { ext: '.md' })) {
    const text = vault.readTextOrNull(rel);
    if (!text || !text.includes(marker)) continue;
    const to = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '');
    const section = text.split(/\n(?=## )/).find((s) => s.includes(marker));
    const m = section?.match(/^## \S+ from (\S+) \(\w+\)[^\n]*\n([\s\S]*)$/);
    return { to, from: m?.[1] ?? 'unknown', body: (m?.[2] ?? '').trim() };
  }
  return null;
}

/**
 * Who a stale question goes to: the asker's own division lead first, because they own the work and usually know
 * the answer, and the CEO when there is no usable one — the asker is itself the division lead, the division lead
 * is the colleague who never answered, or the asker sits in a team that holds no division (executive, board,
 * security).
 */
export function escalationTarget(org: Org, asker: string, recipient: string): string {
  const lead = divisionLeadOf(org, asker);
  const ceo = officeHolder(org, 'chief_executive');
  if (lead && lead !== asker && lead !== recipient && lead !== ceo && org.roles[lead]) return lead;
  return ceo;
}

/**
 * A colleague who has not answered across two whole heartbeat intervals is not going to. Rather than leave the
 * asker blocked forever (the only other exit is the owner), hand the question to the asker's division lead — or
 * the CEO when there is no usable one (see `escalationTarget`): the asker is requeued so it can proceed or
 * re-ask, the target gets the question in `Messages/<target>.md` and a `colleague.answer` job for it.
 */
function escalateQuestion(vault: Vault, job: JobFrontmatter, id: string): string {
  const org = loadOrg(vault);
  const q = findQuestion(vault, id);
  const recipient = q?.to ?? 'unknown';
  const target = escalationTarget(org, job.assigned, recipient);
  const question = q?.body ?? '(the question text is no longer in Messages/)';
  const answerJob = idFromKey('job', `escalate:${id}`);
  const already = !!readJob(vault, answerJob);
  if (!already) {
    // The recipient still holds the colleague.answer job this question created (packages/tools/src/tools/
    // colleague.ts). Left alive, two roles would answer the same question: two models spend quota on it and two
    // `re:<id>` sections land on an asker that is no longer blocked. Cancel it — unless it is already running or
    // finished, because yanking a job mid-step loses work and the answer may be seconds away.
    const owed = idFromKey('job', `answer:${id}`);
    const recipientJob = readJob(vault, owed);
    const superseded = !!recipientJob && ['queued', 'blocked'].includes(recipientJob.data.status);
    // The target's job is the re-entry guard for this whole escalation, so it is created first (M2). Written after
    // the handoff, a kill in between re-ran everything on the next tick: the handoff was appended a second time,
    // and because the recipient's job had by then been cancelled, that second copy told the target the recipient
    // "is still working on" a job nothing was working on. Creating it first makes a repeat a no-op instead.
    createJob(vault, {
      id: answerJob, type: 'colleague.answer', assigned: target, priority: 2,
      title: `Answer ${job.assigned} (escalated): ${question.slice(0, 60)}`,
      parent: job.id, links: [`[[${job.id}]]`],
      goal: `${job.assigned} asked ${recipient} this question ${Math.round((Date.now() - Date.parse(job.blocked_on?.since ?? nowIso())) / 3600_000)} h ago and got no answer, so it is yours now:\n\n> ${question.split('\n').join('\n> ')}\n\nAnswer with colleague.message(to: "${job.assigned}", body: "re:${id} <your answer>"). The "re:${id}" prefix is what unblocks their job, so keep it exactly.`,
      done_when: `${job.assigned} has an answer to ${id} in Messages/${job.assigned}.md.`,
    }, 'daemon');
    if (superseded) cancelJob(vault, owed, 'daemon', `${job.assigned}'s question ${id} went unanswered and was escalated to ${target} as ${answerJob}`);
    const handover = superseded
      ? `${recipient}'s own answer job [[${owed}]] has been cancelled, so this question is yours alone.`
      : recipientJob
        ? `${recipient} is still working on [[${owed}]], so check there before answering — you would both be replying to the same question.`
        : `${recipient} has no open job for it.`;
    vault.appendText(messagePath(target), `\n## ${nowIso()} from daemon (handoff) <!-- id:msg_${answerJob} job:${job.id} -->\n\n${job.assigned} asked ${recipient} a question on job [[${job.id}]] and ${recipient} has not answered it. The question (${id}):\n\n> ${question.split('\n').join('\n> ')}\n\n${handover} Answer it yourself or reassign it; ${job.assigned} has been requeued in the meantime.\n`, 'daemon', { job: job.id });
  }
  // The asker is requeued without an answer. Its transcript ends with "this job is now blocked until they answer",
  // and resumed on that alone, two live jobs (2026-09-09/10) simply called finish(blocked) and stranded themselves
  // on the owner. Tell it, in the transcript it resumes from, what happened and that it must not wait.
  appendObservation(vault, job.id, { step: job.checkpoint_step, kind: 'system', ts: nowIso(), text: `Your question ${id} to ${recipient} was not answered in time, so the daemon handed it to ${target} (job ${answerJob}) and requeued you. Do not wait for it: continue on a stated assumption (say which in your summary), hand the work to a teammate, or finish. If the answer arrives later it will show up in your messages.` });
  vault.events.emit({ type: 'daemon.warning', agent: 'daemon', job: job.id, payload: { where: 'question_timeout', message: `${recipient} never answered ${job.assigned}'s question ${id}; escalated to ${target} as ${answerJob}`, id, escalated_to: target } });
  return target;
}

/**
 * Requeue blocked jobs whose wait condition (answered message, finished sub-job, resolved proposal) is satisfied.
 * `sinceFloor` is the earliest moment a question wait may count from (the dispatcher tick passes the daemon's start):
 * a colleague cannot answer while the daemon is down, and the first tick after a 14 h outage (2026-09-10) otherwise
 * escalated a question whose answer job had never had a chance to run. Without it the wait is pure wall-clock.
 */
export function requeueUnblocked(vault: Vault, questionWaitMs = DEFAULT_QUESTION_WAIT_MS, opts: { sinceFloor?: number; trustHeld?: (d: InboxFrontmatter) => boolean } = {}): number {
  const floor = opts.sinceFloor ?? 0;
  let n = 0;
  for (const j of listJobs(vault, { status: 'blocked' })) {
    const b = j.blocked_on;
    if (!b) { if (j.approval === 'pending') { updateJob(vault, j.id, { status: 'queued' }, 'daemon'); n++; } continue; } // no blocked_on = owner paused it
    if (b.kind === 'owner') continue; // finished as blocked; the owner requeues by setting status: queued
    let ready = false;
    if (b.kind === 'proposal') {
      const p = listInbox(vault).find((x) => x.data.id === b.id);
      // A job waiting on a leaving call is not ready until both offices have answered: waking it would only have
      // the harness re-block it a moment later, once per tick, for as long as the reviews take.
      //
      // `resolved_at` counts as an answer even with `approved: null`, and that clause is what stops the one
      // stranding the trust sweep exists to prevent (Decision 19): a call an office returned is closed unsent
      // whether or not the owner ever reached the inbox, and its author has to be resumed and told why.
      //
      // **A resolved note can never send, so it must never hold its author** (C1). `trustHeld` only asks whether
      // the two gates have answered, and the sweep skips a resolved note outright — so on the ordinary path where
      // the owner says *no* while the reviews are out, the gates stay pending for ever, and without this clause
      // the author sat `blocked` on a closed proposal for the life of the vault, in no "What needs you" row and
      // with no warning anywhere. The rejection (or the sweep's verdict footer) is the answer the job resumes on.
      //
      // The constitution hold is the same shape as the trust hold and skips for the same reason: while no
      // model can check the call, waking the author would only have the harness re-block it a moment later,
      // once per tick, writing an "unblocked (proposal …)" line into the job note each time for as long as
      // the outage lasts.
      //
      // It is the one hold that outlives `resolved_at`, and deliberately (re-review 2, I1). The marker is
      // written by **both** sides: the dispatcher before it resolves a note, and the harness when the model
      // goes down in the window between that check and the job's own resume — by which time the note is
      // already closed. Skipping a resolved note there would have left exactly the loop this guard exists to
      // prevent, unbounded, for the length of the outage. The resolved note cannot strand its author either,
      // because the release is not the note's: `classifierUnavailableNow()` stops being true the moment a
      // model answers (the era moves) or the memo window lapses, whichever comes first, and the author is
      // woken on that pass.
      const classifierHeld = !!p && (p.data as { refused?: string }).refused === CLASSIFIER_UNAVAILABLE_HOLD && classifierUnavailableNow();
      const held = !!p && ((!p.data.resolved_at && (opts.trustHeld?.(p.data) ?? false)) || classifierHeld);
      ready = !!p && (p.data.approved !== null || !!p.data.resolved_at) && !held;
    } else if (b.kind === 'job') {
      const sub = readJob(vault, b.id);
      ready = (!!sub && ['done', 'failed', 'cancelled'].includes(sub.data.status)) || Date.now() - Date.parse(b.since) > PLAN_WAIT_BUDGET_MS;
    } else if (b.kind === 'message') {
      ready = !!findAnswer(vault, j.assigned, b.id) || !!listInbox(vault).find((x) => x.data.id === b.id && x.data.answered);
      if (!ready && Date.now() - Math.max(Date.parse(b.since), floor) > questionWaitMs) {
        const target = escalateQuestion(vault, j, b.id);
        updateJob(vault, j.id, { status: 'queued', blocked_on: undefined }, 'daemon', `- ${nowIso()}: unanswered question ${b.id} escalated to ${target}`);
        n++;
        continue;
      }
    } else if (b.kind === 'quota') {
      const retries = Number((b as { retries?: number }).retries ?? 0);
      ready = Date.now() - Date.parse(b.since) > Math.min(10 * 2 ** retries, 240) * 60_000; // 10 → 20 → 40 … ≤ 240 min
      if (ready) { updateJob(vault, j.id, { status: 'queued', blocked_on: { ...b, retries: retries + 1 } as typeof b }, 'daemon'); n++; continue; }
    }
    if (ready) { updateJob(vault, j.id, { status: 'queued' }, 'daemon', `- ${nowIso()}: unblocked (${b.kind} ${b.id})`); n++; }
  }
  return n;
}
