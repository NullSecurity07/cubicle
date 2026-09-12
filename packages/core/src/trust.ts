import type { Vault } from './vault.js';
import type { EventLog } from './events.js';
import { officeHolder, leadOf, type Org } from './org.js';
import { idFromKey } from './fs.js';
import type { Office } from './schemas.js';

/**
 * Trust gates: nothing leaves the company without the compliance office and the security office having read the
 * exact thing that is leaving (spec §1).
 *
 * Two rules carry the whole sub-project. **The gate list comes from `config/tools.yaml` plus the call's own
 * arguments**, neither of which an agent can write — so no prompt decides whether a send is reviewed. And **the
 * verdict record is the event log**, which is the only store here that no agent can touch: a reviewer may write
 * its own job note, and `proposal.create` lets any role mint a `00 Inbox/` note with a body of its choosing, so
 * a verdict kept in either place would be forgeable by the very role whose send it gates. `.cubicle/` is both a
 * cache path (`isCachePath`) and a secret path (`isSecretPath`), so the log is out of reach.
 */

/** The two reviews, in the order they are filed. Both are enqueued at once; neither waits for the other. */
export const TRUST_GATES = ['office:compliance.review', 'office:security.review'] as const;
export type TrustGate = (typeof TRUST_GATES)[number];

/** Which office runs each gate. Gates are named by office and resolved by office — never by a role id. */
export const TRUST_GATE_OFFICE: Record<TrustGate, Office> = {
  'office:compliance.review': 'compliance',
  'office:security.review': 'security',
};

/** The one field SP5 adds to a `config/tools.yaml` entry. Typed here so `core` never imports `tools`. */
export interface TrustToolPolicy { trust_review?: boolean }

/**
 * The reviews one call owes, or `[]`.
 *
 * The flag is the owner's (`config/tools.yaml`); the refinement by argument is a fact about the tool, not a
 * policy the owner should have to restate. A `deploy.site` preview or canary is an internal step of progressive
 * delivery, and a `rollback` republishes bytes a live deploy already passed — an incident recovery that has to
 * wait for two review jobs is an incident that lasts longer.
 *
 * Absent `stage` reads as `preview`, which is the tool's own schema default, so the harness pre-check (raw args)
 * and the tool layer (parsed args) always agree.
 */
export function trustReviewsFor(pol: TrustToolPolicy | undefined, tool: string, args: Record<string, unknown>): TrustGate[] {
  if (!pol?.trust_review) return [];
  if (tool === 'deploy.site') {
    if (args.rollback === true) return [];
    if (String(args.stage ?? 'preview') !== 'live') return [];
  }
  return [...TRUST_GATES];
}

export type TrustVerdictKind = 'pass' | 'return';
export interface TrustReview { gate: string; verdict: TrustVerdictKind; at: string; findings: string[] }
export interface TrustState { passed: string[]; returned: string[]; pending: string[]; reviews: TrustReview[]; findings: string[] }

/**
 * How far back the log is read for verdicts. Bounded because `EventLog.query` with no limit reads every row:
 * a limited query keeps the **newest** N, which is what "has this call been cleared" asks. Two review events
 * per outbound call means this covers the last thousand calls, and a verdict older than that belongs to a
 * proposal nobody is still waiting on.
 */
export const TRUST_LOOKBACK = 2000;

/**
 * The verdicts on one call, keyed on its **idempotency key** rather than on the proposal id (Decision 17): the
 * key is what `ToolContext` carries and what the at-most-once ledger already uses, so one identifier gates the
 * call on every path (harness resume, dispatcher, tool layer) with no `00 Inbox/` scan from inside a handler.
 * The proposal id travels in the payload for the owner's trail.
 *
 * The newest event per gate wins, so a re-review overrides an earlier verdict. Ordinary chain reviews carry no
 * `key` and are therefore invisible here — `office:security.review` is both a chain gate and a trust gate, and
 * the two must never be mistaken for each other.
 */
export function trustState(events: EventLog, key: string, gates: readonly string[] = TRUST_GATES): TrustState {
  const newest = new Map<string, TrustReview>();
  for (const e of events.query({ types: ['review.passed', 'review.returned'], limit: TRUST_LOOKBACK, order: 'asc' })) {
    const p = e.payload as { key?: unknown; gate?: unknown; findings?: unknown };
    if (!key || String(p.key ?? '') !== key) continue;
    const gate = String(p.gate ?? '');
    if (!gates.includes(gate)) continue;
    newest.set(gate, {
      gate,
      verdict: e.type === 'review.passed' ? 'pass' : 'return',
      at: e.ts,
      findings: Array.isArray(p.findings) ? p.findings.map(String) : [],
    });
  }
  const reviews = gates.flatMap((g) => { const r = newest.get(g); return r ? [r] : []; });
  return {
    passed: reviews.filter((r) => r.verdict === 'pass').map((r) => r.gate),
    returned: reviews.filter((r) => r.verdict === 'return').map((r) => r.gate),
    pending: gates.filter((g) => !newest.has(g)),
    reviews,
    findings: reviews.filter((r) => r.verdict === 'return').flatMap((r) => r.findings),
  };
}

/** Every gate has passed: the only state in which a leaving call may run. */
export function trustCleared(st: TrustState, gates: readonly string[]): boolean {
  return gates.length > 0 && st.passed.length === gates.length;
}

export interface NewTrustVerdict {
  key: string;
  proposal: string;
  gate: string;
  verdict: TrustVerdictKind;
  findings?: string[];
  job?: string | null;
  by: string;
}

/** How many findings a verdict carries into the log, and how long each may be (in-world text limits). */
export const TRUST_MAX_FINDINGS = 6;
export const TRUST_FINDING_CHARS = 300;

/**
 * Write one verdict to the record. The event log and nothing else (Decision 18): a note write to an unresolved
 * `00 Inbox/` proposal would re-record `written_sha`, and `isOwnerChanged` — which is how the dispatcher tells
 * the owner's approval from a system write — would then read the owner's next flip as the daemon's own. The owner
 * reads the verdict in the proposal's resolution footer and in the reviewer's job note.
 */
export function recordTrustVerdict(vault: Vault, o: NewTrustVerdict): void {
  vault.events.emit({
    type: o.verdict === 'pass' ? 'review.passed' : 'review.returned',
    agent: o.by,
    job: o.job ?? null,
    payload: {
      gate: o.gate,
      key: o.key,
      proposal: o.proposal,
      trust: true,
      findings: (o.findings ?? []).map((f) => String(f).slice(0, TRUST_FINDING_CHARS)).slice(0, TRUST_MAX_FINDINGS),
    },
  });
}

/**
 * The verdict a finished review job records, or null when the job is not a trust review. Keeps the harness's
 * `finishWith` to two lines, and puts Decision 14 in one testable place: **a reviewer's failed job is a return**,
 * because an unfinished review must not become a pass because the reviewer ran out of steps. A review that
 * finishes `blocked` records nothing and stays pending — it is waiting on the owner, not on the author.
 */
export function trustVerdictFor(
  job: { id: string; type: string; assigned: string; trust_key?: unknown; trust_proposal?: unknown },
  result: { status: string; verdict?: TrustVerdictKind; findings?: string[]; blockers?: string[]; summary?: string },
): NewTrustVerdict | null {
  const key = typeof job.trust_key === 'string' ? job.trust_key : '';
  const proposal = typeof job.trust_proposal === 'string' ? job.trust_proposal : '';
  if (!key || !proposal) return null;
  const base = { key, proposal, gate: job.type, job: job.id, by: job.assigned };
  if (result.status === 'failed') {
    const blockers = result.blockers ?? [];
    return { ...base, verdict: 'return', findings: blockers.length ? blockers : [result.summary || 'the reviewer could not complete the review'] };
  }
  if (result.status !== 'done') return null;
  return { ...base, verdict: result.verdict === 'return' ? 'return' : 'pass', findings: result.findings ?? [] };
}

/**
 * Who reviews. The office holder, unless that is the author of the send — then the author's lead, then the chief
 * executive, which is the order `secondPairOfEyes` already uses. `null` means there is genuinely nobody else:
 * no review job is enqueued, the review stays pending for ever and the call stays refused. Failing closed is the
 * only honest default for a gate whose purpose is to stop things.
 */
export function trustReviewerFor(org: Org, gate: string, author: string): string | null {
  const office = TRUST_GATE_OFFICE[gate as TrustGate];
  const candidates = [
    office ? officeHolder(org, office) : null,
    leadOf(org, author),
    officeHolder(org, 'chief_executive'),
  ];
  return candidates.find((c) => !!c && c !== author && !!org.roles[c]) ?? null;
}

/** The review job's id: deterministic, so a replayed sweep re-finds its own job instead of filing a second one. */
export function trustJobId(key: string, gate: string): string {
  return idFromKey('job', `trust:${gate}:${key}`);
}

/** `office:compliance.review` → `Compliance review`. For a job title, never for routing. */
export function trustGateLabel(gate: string): string {
  const words = gate.replace(/^office:/, '').replace(/[._]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** How much of a call's arguments the reviewer is shown. A review of a summary is not a review; a review of 80 kB is not one either. */
export const TRUST_ARGS_CHARS = 4000;

export interface TrustGoalInputs {
  gate: string;
  tool: string;
  args: Record<string, unknown>;
  proposal: string;
  path: string;
  author: string;
  criteria: string;
}

/** The reviewer's goal: the exact stored call, verbatim, and the criteria from `config/gates.yaml`. */
export function trustGateGoal(o: TrustGoalInputs): string {
  let json: string;
  try { json = JSON.stringify(o.args, null, 2); } catch { json = String(o.args); }
  const body = json.length > TRUST_ARGS_CHARS ? `${json.slice(0, TRUST_ARGS_CHARS)}\n… (cut at ${TRUST_ARGS_CHARS} characters; read \`${o.path}\` for the rest)` : json;
  // The blank strings below are the blank lines of the rendered goal; only the criteria line is optional, so the
  // filter drops `null` rather than `''` — filtering empty strings would have collapsed every paragraph break.
  const lines: (string | null)[] = [
    `Review the call below as the ${o.gate} gate before it leaves the company. ${o.author} filed it as proposal [[${o.proposal}]] (\`${o.path}\`).`,
    '',
    `Tool: \`${o.tool}\``,
    '',
    '```json',
    body,
    '```',
    '',
    o.criteria ? `What good looks like: ${o.criteria}` : null,
    '',
    'Judge the exact text and arguments above, not a summary of them. Finish with status done and verdict pass, or verdict return with findings that name the line to change. A return is final for this attempt: the call is closed unsent and the author files a fresh one.',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

/** What the tool layer says when a leaving call arrives with no filed proposal at all. */
export function trustRefusalNoKey(tool: string): string {
  return `${tool} leaves the company, and this call carries no filed proposal, so no office can have reviewed it. Nothing was sent. File it with the owner and let the compliance and security offices read it first.`;
}

/** What every refusal of a leaving call says — the same words in the tool layer, the harness and the dispatcher. */
export function trustRefusal(tool: string, st: TrustState): string {
  if (st.returned.length) {
    const why = st.findings.slice(0, 3).join('; ') || 'no findings given';
    return `${tool} was returned by ${st.returned.join(' and ')}: ${why}. Nothing was sent. Fix what the review named and file a fresh call.`;
  }
  const outstanding = st.pending.length ? st.pending.join(' and ') : 'the trust reviews';
  return `${tool} leaves the company, so it runs only once ${outstanding} ${st.pending.length === 1 ? 'has' : 'have'} passed it. Nothing was sent.`;
}

/** The fixed hold the dispatcher writes on a proposal whose reviews are still out. Fixed, so it is written once per episode. */
export const TRUST_PENDING_HOLD = 'the compliance and security offices are still reviewing this, so nothing is sent yet; it is applied on its own once both have passed';

/**
 * What the tool layer needs to answer "may this run?". `ToolContext` satisfies it structurally, so the check in
 * `mcp.ts` is one line and takes no new dependency — and being unconditional rather than an injectable
 * `Guardrail` is the point (Decision 4): a guardrail list is something a caller can forget, and the guarantee is
 * that the harness *cannot* bypass it.
 */
export interface TrustCheckCtx {
  config: { tools: Record<string, TrustToolPolicy> };
  events: EventLog;
  idempotencyKey?: string;
}

/** The last check: null to allow, a reason to refuse. Called before any handler runs, on every path. */
export function trustVeto(ctx: TrustCheckCtx, tool: string, args: Record<string, unknown>): string | null {
  const gates = trustReviewsFor(ctx.config.tools[tool], tool, args);
  if (!gates.length) return null;
  if (!ctx.idempotencyKey) return trustRefusalNoKey(tool);
  const st = trustState(ctx.events, ctx.idempotencyKey, gates);
  return trustCleared(st, gates) ? null : trustRefusal(tool, st);
}

export type TrustDecision =
  | { kind: 'clear'; st: TrustState }
  | { kind: 'hold'; st: TrustState }
  | { kind: 'returned'; st: TrustState; reason: string };

/**
 * The three-way answer the harness's resume path and the dispatcher both need, and null when the call owes no
 * reviews at all. `hold` is the one that matters: nothing is spent while the reviews are out, so the idempotency
 * key stays unspent and a verdict that lands ten minutes later still sends.
 */
export function trustDecision(
  events: EventLog,
  pol: TrustToolPolicy | undefined,
  call: { tool: string; args: Record<string, unknown>; idempotency_key: string },
): TrustDecision | null {
  const gates = trustReviewsFor(pol, call.tool, call.args);
  if (!gates.length) return null;
  const st = trustState(events, call.idempotency_key, gates);
  if (st.returned.length) return { kind: 'returned', st, reason: trustRefusal(call.tool, st) };
  return trustCleared(st, gates) ? { kind: 'clear', st } : { kind: 'hold', st };
}
