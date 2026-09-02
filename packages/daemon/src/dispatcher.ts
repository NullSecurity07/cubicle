import {
  type Vault, listInbox, readJob, updateJob, listJobs, nowIso, parseNote, stringifyNote, createJob, RoleFrontmatter, type InboxFrontmatter,
} from '@cubicle/core';
import { createRoleToolClient, type ToolRegistry, type ToolsConfig, type ToolContext, type SchedulerApi } from '@cubicle/tools';
import { findAnswer } from '@cubicle/tools';

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
}

function fenced(body: string): string | null {
  const m = body.match(/## Proposed content\s*\n+```[a-z]*\n([\s\S]*?)\n```/);
  return m ? m[1] + (m[1].endsWith('\n') ? '' : '\n') : null;
}

/** Execute a stored call as the daemon, with the original role's permissions and the stored idempotency key. */
export async function executeStoredCall(deps: DispatcherDeps, note: { data: InboxFrontmatter }): Promise<{ ok: boolean; text: string }> {
  const call = note.data.call!;
  const roleId = call.role ?? note.data.from;
  const roleNote = deps.vault.readNoteOrNull(`Roles/${roleId}.md`);
  if (!roleNote) return { ok: false, text: `no charter for ${roleId}` };
  const role = RoleFrontmatter.parse(roleNote.data);
  const jobId = call.job ?? note.data.job ?? null;
  const job = jobId ? readJob(deps.vault, jobId) : null;
  if (job && job.data.side_effects_done.includes(call.idempotency_key)) return { ok: true, text: 'already executed (idempotency key recorded)' };
  const ctx: ToolContext = { vault: deps.vault, events: deps.vault.events, roleId, role, jobId, config: deps.toolsConfig, env: deps.env, scheduler: deps.scheduler, workspace: `.cubicle/workspace/${jobId ?? 'daemon'}`, now: () => new Date(), idempotencyKey: call.idempotency_key };
  const def = deps.registry.get(call.tool);
  if (!def) return { ok: false, text: `unknown tool ${call.tool}` };
  const client = await createRoleToolClient([def], ctx);
  try {
    const res = await client.call(call.tool, call.args, { idempotencyKey: call.idempotency_key });
    if (job) updateJob(deps.vault, job.data.id, { side_effects_done: [...job.data.side_effects_done, call.idempotency_key] }, 'daemon', `- ${nowIso()}: ${call.tool} executed by the daemon after owner approval → ${res.ok ? 'ok' : 'failed'}`);
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
      const answer = (note.body.split('## Owner')[1] ?? '').trim();
      vault.appendText(`Messages/${d.from}.md`, `\n## ${nowIso()} from owner (fyi) <!-- id:msg_${d.id} -->\n\nre:${d.id} ${answer}\n`, 'daemon');
      vault.updateNote(note.path, (nn) => ({ data: { ...nn.data, resolved_at: nowIso() }, body: nn.body }), 'daemon');
      vault.events.emit({ type: 'proposal.resolved', agent: 'owner', job: d.job ?? null, payload: { id: d.id, kind: 'message', answered: true } });
      n++;
      continue;
    }
    if (d.kind === 'message' || d.approved === null || d.resolved_at) continue;
    if (!ownerFlipped) {
      vault.events.emit({ type: 'guardrail.blocked', payload: { proposal: d.id, reason: 'approval flag was not set by the owner (sha matches a system write); ignoring' } });
      continue;
    }
    let outcome = '';
    try {
      if (d.approved === false) {
        outcome = 'rejected';
      } else {
        switch (d.kind) {
          case 'hire': outcome = deps.onHire ? await deps.onHire(note) : 'hire dispatch arrives in Phase 7; resolved without action'; break;
          case 'fire': outcome = deps.onFire ? await deps.onFire(note) : 'fire dispatch arrives in Phase 7; resolved without action'; break;
          case 'brand_change':
          case 'charter_change':
          case 'file_change': {
            const target = d.target;
            if (!target) { outcome = 'no target path on proposal'; break; }
            let content = (d.call?.tool === 'vault.write' && typeof d.call.args.content === 'string') ? String(d.call.args.content) : fenced(note.body);
            if (d.kind === 'brand_change' && target === 'Brand/name.md' && d.chosen && !content) {
              const line = note.body.split('\n').find((l) => new RegExp(`^\\s*${d.chosen}\\.\\s`).test(l));
              const name = line?.replace(/^\s*\d+\.\s*/, '').split(/\s+—\s+|\s+-\s+|:/)[0].trim() ?? 'Untitled Co';
              const tagline = line?.split(/\s+—\s+|\s+-\s+/)[1]?.trim() ?? '';
              content = stringifyNote({ name, tagline, url: '' }, `# ${name}\n\n${tagline}\n`);
            }
            if (!content) { outcome = 'no "## Proposed content" block found'; break; }
            vault.writeText(target, content, 'daemon', { job: d.job ?? null });
            outcome = `applied to ${target}`;
            if (target.startsWith('Brand/')) {
              const open = listJobs(vault, { status: ['queued', 'running', 'blocked'] }).some((j) => j.type === 'engineer.ship' && /reconcile site with brand/i.test(j.title));
              if (!open) createJob(vault, { type: 'engineer.ship', title: 'Reconcile site with brand', assigned: 'engineer', priority: 2, goal: `${target} changed (owner approved a proposal). Read Brand/ and update Site/ to match. Never revert owner edits under Site/.` }, 'daemon');
            }
            if (target.startsWith('Roles/')) {
              const parsed = RoleFrontmatter.safeParse(parseNote(content).data);
              if (!parsed.success) outcome += ' (warning: charter frontmatter does not validate)';
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
    vault.updateNote(note.path, (nn) => ({ data: { ...nn.data, resolved_at: nowIso() }, body: nn.body.trimEnd() + `\n\n---\n_Resolved ${nowIso()}: ${outcome}_\n` }), 'daemon');
    vault.events.emit({ type: 'proposal.resolved', agent: 'owner', job: d.job ?? null, payload: { id: d.id, kind: d.kind, approved: d.approved, outcome } });
    n++;
  }
  n += requeueUnblocked(vault);
  if (n) deps.wake?.();
  return n;
}

/** Requeue blocked jobs whose wait condition (answered message, finished sub-job, resolved proposal) is satisfied. */
export function requeueUnblocked(vault: Vault): number {
  let n = 0;
  for (const j of listJobs(vault, { status: 'blocked' })) {
    const b = j.blocked_on;
    if (!b) { updateJob(vault, j.id, { status: 'queued' }, 'daemon'); n++; continue; }
    if (b.kind === 'owner') continue; // finished as blocked; the owner requeues by setting status: queued
    let ready = false;
    if (b.kind === 'proposal') {
      const p = listInbox(vault).find((x) => x.data.id === b.id);
      ready = !!p && p.data.approved !== null;
    } else if (b.kind === 'job') {
      const sub = readJob(vault, b.id);
      ready = !!sub && ['done', 'failed', 'cancelled'].includes(sub.data.status);
    } else if (b.kind === 'message') {
      ready = !!findAnswer(vault, j.assigned, b.id) || !!listInbox(vault).find((x) => x.data.id === b.id && x.data.answered);
    } else if (b.kind === 'quota') {
      ready = Date.now() - Date.parse(b.since) > 10 * 60_000; // retry every 10 minutes
    }
    if (ready) { updateJob(vault, j.id, { status: 'queued' }, 'daemon', `- ${nowIso()}: unblocked (${b.kind} ${b.id})`); n++; }
  }
  return n;
}
