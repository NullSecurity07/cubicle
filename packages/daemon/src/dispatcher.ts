import {
  type Vault, listInbox, readJob, updateJob, listJobs, nowIso, parseNote, stringifyNote, createJob, idFromKey, RoleFrontmatter, type InboxFrontmatter, type JobFrontmatter,
} from '@cubicle/core';
import { createRoleToolClient, resolveMode, type ToolRegistry, type ToolsConfig, type ToolContext, type SchedulerApi } from '@cubicle/tools';
import { findAnswer, messagePath } from '@cubicle/tools';
import { PLAN_WAIT_BUDGET_MS } from './heartbeat.js';
import { applyHire, applyFire, applyReorg, charterDiffSection } from './evolution.js';
import { isValidRoleId, isOwnerOwned, normalizeRel, isSecretPath } from '@cubicle/core';

/** kind → allowed targets. Everything else leaves the note unresolved with a warning (an approval must mean what its title says). */
export function validateTarget(kind: string, target: string, hasCall: boolean): string | null {
  let t: string;
  try { t = normalizeRel(target); } catch (err) { return (err as Error).message; }
  if (!t) return 'empty target';
  if (isSecretPath(t) || t.startsWith('.cubicle/')) return `target ${t} is not writable by proposals`;
  if (kind === 'brand_change') return t.startsWith('Brand/') ? null : `brand_change may only target Brand/ (got ${t})`;
  if (kind === 'charter_change') { const m = t.match(/^Roles\/([^/]+)\.md$/); return m && isValidRoleId(m[1]) ? null : `charter_change may only target Roles/<role>.md (got ${t})`; }
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
  onRoleHired?: (role: string) => void;
  onRoleFired?: (role: string) => void;
  /** How long a question may go unanswered before it escalates to the CEO; defaults to two heartbeat intervals. */
  questionWaitMs?: number;
  guardrails?: { check(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string | null> | string | null }[];
}

function fenced(body: string): string | null {
  const m = body.match(/## Proposed content\s*\n+```[a-z]*\n([\s\S]*?)\n```/);
  return m ? m[1] + (m[1].endsWith('\n') ? '' : '\n') : null;
}

/**
 * Leave a proposal unresolved with a reason. The footer write is a system write (sha now matches), so the owner's
 * approval is remembered via `refused_sha`/`refused_at`: the note is retried when the owner edits it again or after 10 minutes.
 */
function refuseNote(vault: Vault, note: { path: string; data: InboxFrontmatter }, why: string, extra: Record<string, unknown> = {}): void {
  vault.events.emit({ type: 'guardrail.blocked', payload: { proposal: note.data.id, kind: note.data.kind, reason: why, ...extra } });
  vault.updateNote(note.path, (nn) => ({ data: { ...nn.data, refused: why, refused_at: nowIso() }, body: nn.body.replace(/\n\n---\n_Not applied:[^\n]*_\n?$/s, '').trimEnd() + `\n\n---\n_Not applied: ${why}. Fix it and set approved again (retried automatically every 10 minutes)._\n` }), 'daemon');
  const sha = vault.currentSha(note.path);
  if (sha) vault.db.prepare('INSERT OR REPLACE INTO refusals(path, sha, at) VALUES (?, ?, ?)').run(note.path, sha, nowIso());
}

function retryDue(vault: Vault, note: { path: string; data: InboxFrontmatter }): boolean {
  const row = vault.db.prepare('SELECT sha, at FROM refusals WHERE path = ?').get(note.path) as { sha: string; at: string } | undefined;
  if (!row) return false;
  return vault.currentSha(note.path) !== row.sha || Date.now() - Date.parse(row.at) > 10 * 60_000;
}

/** Execute a stored call as the daemon, with the original role's permissions and the stored idempotency key. */
export async function executeStoredCall(deps: DispatcherDeps, note: { path: string; data: InboxFrontmatter }): Promise<{ ok: boolean; text: string }> {
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
  // call anyway, but only after the idempotency key was spent — and an approval the owner has since revoked in
  // the config must leave the key intact, so re-approving works once the mode is relaxed again.
  const mode = resolveMode(call.tool, deps.toolsConfig, role, deps.vault.ownerPreferences());
  if (mode === 'never') {
    const reason = `${call.tool} is set to mode never; the owner's configuration outranks this approval`;
    deps.vault.events.emit({ type: 'guardrail.blocked', agent: roleId, job: jobId, payload: { tool: call.tool, reason, approved: true } });
    return { ok: false, text: `blocked even though approved: ${reason}` };
  }
  // At-most-once: mark the note (and the job) BEFORE running the external call.
  if ((note.data as { executing_at?: string }).executing_at) return { ok: false, text: 'a previous attempt was interrupted after starting this call; not re-running it (lost result)' };
  deps.vault.updateNote(note.path, (n) => ({ data: { ...n.data, executing_at: nowIso() }, body: n.body }), 'daemon');
  const job = jobId ? readJob(deps.vault, jobId) : null;
  if (job && job.data.side_effects_done.includes(call.idempotency_key)) return { ok: true, text: 'already executed (idempotency key recorded)' };
  if (job) updateJob(deps.vault, job.data.id, { side_effects_done: [...job.data.side_effects_done, call.idempotency_key] }, 'daemon', `- ${nowIso()}: ${call.tool} ATTEMPTING by the daemon after owner approval (${call.idempotency_key})`);
  const ctx: ToolContext = { vault: deps.vault, events: deps.vault.events, roleId, role, jobId, config: deps.toolsConfig, env: deps.env, scheduler: deps.scheduler, workspace: `.cubicle/workspace/${jobId ?? 'daemon'}`, now: () => new Date(), idempotencyKey: call.idempotency_key, guardrails: deps.guardrails };
  const def = deps.registry.get(call.tool);
  if (!def) return { ok: false, text: `unknown tool ${call.tool}` };
  for (const g of deps.guardrails ?? []) { const v = await g.check(call.tool, call.args, ctx); if (v) { deps.vault.events.emit({ type: 'guardrail.blocked', agent: roleId, job: jobId, payload: { tool: call.tool, reason: v, approved: true } }); return { ok: false, text: `blocked even though approved: ${v}` }; } }
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
    // Constitution autonomy flags: the owner pre-approved these kinds; the daemon approves agent-created notes itself.
    const c = vault.constitution();
    const autoApproved = d.approved === null && ((d.kind === 'hire' && c.auto_approve_hire && d.from === 'ceo') || (d.kind === 'charter_change' && c.auto_approve_charter_changes && d.from === 'cto') || (d.kind === 'reorg' && c.auto_approve_reorg && d.from === 'ceo'));
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
      if (d.approved === false) {
        outcome = 'rejected';
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
                // Auto-approval covers only the CTO's compression output (spec §9.2) and may not widen tools or loosen approvals.
                const widened = parsed.data.tools.filter((t) => !cur.data.tools.some((c) => c === t || (c.endsWith('.*') && t.startsWith(c.slice(0, -1)))));
                const order: Record<string, number> = { auto: 0, propose: 1, ask: 2, never: 3 };
                const loosened = Object.entries(parsed.data.approval_overrides).filter(([k, v]) => k in cur.data.approval_overrides && order[v] < order[cur.data.approval_overrides[k]]);
                if (d.from !== 'cto') { refuse(`auto_approve_charter_changes applies to the CTO's compression proposals only (this one is from ${d.from})`); continue; }
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
              if (!open) createJob(vault, { type: 'engineer.ship', title: 'Reconcile site with brand', assigned: 'engineer', priority: 2, goal: `${target} changed (owner approved a proposal). Read Brand/ and update Site/ to match. Never revert owner edits under Site/.` }, 'daemon');
            }
            break;
          }
          case 'spend': {
            if (!d.call) { outcome = 'no stored call'; break; }
            const r = await executeStoredCall(deps, note);
            outcome = `${d.call.tool}: ${r.ok ? 'ok' : 'failed'} — ${r.text.slice(0, 200)}`;
            break;
          }
          case 'outbound_batch':
            // The blocked job executes the stored call itself on resume (R30); just wake it.
            outcome = 'approved; the waiting job resumes';
            break;
        }
      }
    } catch (err) {
      outcome = `dispatch error: ${(err as Error).message}`;
      vault.events.emit({ type: 'daemon.warning', payload: { where: 'dispatcher', proposal: d.id, message: outcome } });
    }
    vault.updateNote(note.path, (nn) => { const { refused: _r, refused_at: _a, ...rest } = nn.data as Record<string, unknown>; return { data: { ...rest, resolved_at: nowIso() }, body: nn.body.trimEnd() + `\n\n---\n_Resolved ${nowIso()}: ${outcome}_\n` }; }, 'daemon');
    vault.db.prepare('DELETE FROM refusals WHERE path = ?').run(note.path);
    vault.events.emit({ type: 'proposal.resolved', agent: 'owner', job: d.job ?? null, payload: { id: d.id, kind: d.kind, approved: d.approved, outcome } });
    n++;
  }
  n += requeueUnblocked(vault, deps.questionWaitMs);
  if (n) deps.wake?.();
  return n;
}

/** Two heartbeat intervals (spec §8: 6 h) — the same default `defaultConfig` computes. */
export const DEFAULT_QUESTION_WAIT_MS = 12 * 3600_000;

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
 * A colleague who has not answered across two whole heartbeat intervals is not going to. Rather than leave the
 * asker blocked forever (the only other exit is the owner), hand the question to the CEO: the asker is requeued so
 * it can proceed or re-ask, the CEO gets the question in `Messages/ceo.md` and a `colleague.answer` job for it.
 */
function escalateQuestionToCeo(vault: Vault, job: JobFrontmatter, id: string): void {
  const q = findQuestion(vault, id);
  const recipient = q?.to ?? 'unknown';
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
    if (superseded) updateJob(vault, owed, { status: 'cancelled' }, 'daemon', `- ${nowIso()}: cancelled; ${job.assigned}'s question ${id} went unanswered and was escalated to ceo as ${answerJob}`);
    const handover = superseded
      ? `${recipient}'s own answer job [[${owed}]] has been cancelled, so this question is yours alone.`
      : recipientJob
        ? `${recipient} is still working on [[${owed}]], so check there before answering — you would both be replying to the same question.`
        : `${recipient} has no open job for it.`;
    vault.appendText(messagePath('ceo'), `\n## ${nowIso()} from daemon (handoff) <!-- id:msg_${answerJob} job:${job.id} -->\n\n${job.assigned} asked ${recipient} a question on job [[${job.id}]] and ${recipient} has not answered it. The question (${id}):\n\n> ${question.split('\n').join('\n> ')}\n\n${handover} Answer it yourself or reassign it; ${job.assigned} has been requeued in the meantime.\n`, 'daemon', { job: job.id });
    createJob(vault, {
      id: answerJob, type: 'colleague.answer', assigned: 'ceo', priority: 2,
      title: `Answer ${job.assigned} (escalated): ${question.slice(0, 60)}`,
      parent: job.id, links: [`[[${job.id}]]`],
      goal: `${job.assigned} asked ${recipient} this question ${Math.round((Date.now() - Date.parse(job.blocked_on?.since ?? nowIso())) / 3600_000)} h ago and got no answer, so it is yours now:\n\n> ${question.split('\n').join('\n> ')}\n\nAnswer with colleague.message(to: "${job.assigned}", body: "re:${id} <your answer>"). The "re:${id}" prefix is what unblocks their job, so keep it exactly.`,
      done_when: `${job.assigned} has an answer to ${id} in Messages/${job.assigned}.md.`,
    }, 'daemon');
  }
  vault.events.emit({ type: 'daemon.warning', agent: 'daemon', job: job.id, payload: { where: 'question_timeout', message: `${recipient} never answered ${job.assigned}'s question ${id}; escalated to ceo as ${answerJob}`, id, escalated_to: 'ceo' } });
}

/** Requeue blocked jobs whose wait condition (answered message, finished sub-job, resolved proposal) is satisfied. */
export function requeueUnblocked(vault: Vault, questionWaitMs = DEFAULT_QUESTION_WAIT_MS): number {
  let n = 0;
  for (const j of listJobs(vault, { status: 'blocked' })) {
    const b = j.blocked_on;
    if (!b) { if (j.approval === 'pending') { updateJob(vault, j.id, { status: 'queued' }, 'daemon'); n++; } continue; } // no blocked_on = owner paused it
    if (b.kind === 'owner') continue; // finished as blocked; the owner requeues by setting status: queued
    let ready = false;
    if (b.kind === 'proposal') {
      const p = listInbox(vault).find((x) => x.data.id === b.id);
      ready = !!p && p.data.approved !== null;
    } else if (b.kind === 'job') {
      const sub = readJob(vault, b.id);
      ready = (!!sub && ['done', 'failed', 'cancelled'].includes(sub.data.status)) || Date.now() - Date.parse(b.since) > PLAN_WAIT_BUDGET_MS;
    } else if (b.kind === 'message') {
      ready = !!findAnswer(vault, j.assigned, b.id) || !!listInbox(vault).find((x) => x.data.id === b.id && x.data.answered);
      if (!ready && Date.now() - Date.parse(b.since) > questionWaitMs) {
        escalateQuestionToCeo(vault, j, b.id);
        updateJob(vault, j.id, { status: 'queued', blocked_on: undefined }, 'daemon', `- ${nowIso()}: unanswered question ${b.id} escalated to ceo`);
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
