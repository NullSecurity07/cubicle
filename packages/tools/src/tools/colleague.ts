import { z } from 'zod';
import { defineTool } from '../registry.js';
import { unknownRoleText } from './scheduler.js';
import { nowIso, makeId, idFromKey, isValidRoleId, parseNote, RoleFrontmatter, loadOrg, can, teamOf, createJob } from '@cubicle/core';

export const MessageKind = z.enum(['fyi', 'question', 'handoff', 'meeting_request']);

export function messagePath(role: string): string {
  return `Messages/${role}.md`;
}

export const colleagueMessage = defineTool({
  name: 'colleague.message',
  description: 'Send a message to another role. kind=question blocks your job until they answer and queues them a colleague.answer job; handoff also creates a job for them.',
  schema: { to: z.string().describe('role id, e.g. "cto"'), body: z.string(), kind: MessageKind.default('fyi') },
  async handler({ to, body, kind }, ctx) {
    if (!isValidRoleId(to)) return { ok: false, text: `invalid role id: ${JSON.stringify(to)}` };
    const rolePath = `Roles/${to}.md`;
    const roleNote = ctx.vault.readNoteOrNull(rolePath);
    if (!roleNote) return { ok: false, text: unknownRoleText(loadOrg(ctx.vault), to, 'unknown role') };
    const parsedRole = RoleFrontmatter.safeParse(roleNote.data);
    if (parsedRole.success && !parsedRole.data.active) return { ok: false, text: `${to} is no longer active` };
    if (kind === 'handoff') {
      const org = loadOrg(ctx.vault);
      if (!can(org, ctx.roleId, 'schedule', to)) return { ok: false, text: `handoff only to a teammate (${teamOf(org, ctx.roleId)?.members.join(', ') ?? 'none'}); cross-team needs go through your lead` };
    }
    const id = ctx.idempotencyKey ? idFromKey('msg', ctx.idempotencyKey) : makeId('msg');
    const existing = ctx.vault.readTextOrNull(messagePath(to)) ?? '';
    if (existing.includes(`<!-- id:${id}`)) return { ok: true, text: `message ${id} already delivered to ${to} (replayed step)`, data: { id }, block: kind === 'question' ? { kind: 'message', id } : undefined };
    const ts = nowIso();
    const section = `\n## ${ts} from ${ctx.roleId} (${kind}) <!-- id:${id}${ctx.jobId ? ` job:${ctx.jobId}` : ''} -->\n\n${body.trim()}\n`;
    ctx.vault.appendText(messagePath(to), section, ctx.roleId, { job: ctx.jobId });
    ctx.events.emit({ type: 'agent.spoke', agent: ctx.roleId, job: ctx.jobId, payload: { to, kind, text: body.slice(0, 280), id } });
    if (kind === 'handoff') {
      const jobId = ctx.scheduler.enqueue({ id: ctx.idempotencyKey ? idFromKey('job', ctx.idempotencyKey) : undefined, type: 'custom', title: `Handoff from ${ctx.roleId}: ${body.slice(0, 60)}`, assigned: to, goal: body, parent: ctx.jobId ?? undefined, links: ctx.jobId ? [`[[${ctx.jobId}]]`] : [] });
      return { ok: true, text: `handed off to ${to} as job ${jobId}`, data: { id, jobId } };
    }
    if (kind === 'question') {
      // A question blocks the asker, so answering it is real work: the recipient gets a job for it rather than
      // a line in Messages/ nobody is accountable for. The job id derives from the message id, so a replayed
      // step (same idempotency key) reuses the job instead of queueing a second one.
      const answerJob = createJob(ctx.vault, {
        id: idFromKey('job', `answer:${id}`), type: 'colleague.answer', assigned: to, priority: 2,
        title: `Answer ${ctx.roleId}: ${body.trim().slice(0, 60)}`,
        parent: ctx.jobId ?? undefined, links: ctx.jobId ? [`[[${ctx.jobId}]]`] : [],
        goal: `${ctx.roleId} asked you a question and is blocked until you answer:\n\n> ${body.trim().split('\n').join('\n> ')}\n\nAnswer with colleague.message(to: "${ctx.roleId}", body: "re:${id} <your answer>"). The "re:${id}" prefix is what unblocks their job, so keep it exactly.`,
      }, ctx.roleId);
      return { ok: true, text: `question sent to ${to} (${id}); job ${answerJob} queued for them; this job is now blocked until they answer`, data: { id, jobId: answerJob }, block: { kind: 'message', id } };
    }
    if (kind === 'meeting_request') {
      ctx.scheduler.enqueue({ id: ctx.idempotencyKey ? idFromKey('job', ctx.idempotencyKey + ':m') : undefined, type: 'custom', title: `Meeting requested by ${ctx.roleId}`, assigned: 'ceo', goal: `${ctx.roleId} requests a meeting with ${to}:\n\n${body}\n\nDecide whether to call meeting.open.`, priority: 2 });
    }
    return { ok: true, text: `message sent to ${to} (${id})`, data: { id } };
  },
});

/** Unread sections addressed to a role. Marks them read by appending a marker when `mark` is true. */
export function unreadMessages(vault: import('@cubicle/core').Vault, role: string, mark = false): { id: string; from: string; kind: string; ts: string; body: string; job?: string }[] {
  const rel = messagePath(role);
  const text = vault.readTextOrNull(rel);
  if (!text) return [];
  const parts = text.split(/\n(?=## )/);
  const out = [];
  let changed = false;
  const rebuilt: string[] = [];
  for (const part of parts) {
    const m = part.match(/^## (\S+) from (\S+) \((\w+)\) <!-- id:(\S+)(?: job:(\S+))? -->\n([\s\S]*)$/);
    if (!m) { rebuilt.push(part); continue; }
    const [, ts, from, kind, id, job, body] = m;
    if (/<!-- read:/.test(body)) { rebuilt.push(part); continue; }
    out.push({ id, from, kind, ts, body: body.trim(), job });
    rebuilt.push(mark ? part.trimEnd() + `\n<!-- read:${nowIso()} -->\n` : part);
    if (mark) changed = true;
  }
  if (changed) vault.writeText(rel, rebuilt.join('\n'), role, { generated: true });
  return out;
}

/** Render unread messages for a prompt, including the reply convention that unblocks questions. */
export function renderMessages(msgs: { id: string; from: string; kind: string; ts: string; body: string }[]): string {
  return msgs.map((m) => `From ${m.from} (${m.kind}, ${m.ts}, id ${m.id}):\n${m.body}${m.kind === 'question' ? `\n→ Answer with colleague.message(to: "${m.from}", body: "re:${m.id} <your answer>")` : ''}`).join('\n\n');
}

/** Find an answer to a question id: a later section in the asker's inbox that references `re:<id>`. */
export function findAnswer(vault: import('@cubicle/core').Vault, asker: string, questionId: string): { from: string; body: string } | null {
  const text = vault.readTextOrNull(messagePath(asker));
  if (!text) return null;
  const re = new RegExp(`## \\S+ from (\\S+) \\(\\w+\\) <!-- id:\\S+[^>]*-->\\n([\\s\\S]*?)(?=\\n## |$)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[2].includes(`re:${questionId}`)) return { from: m[1], body: m[2].replace(new RegExp(`re:${questionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '').trim() };
  }
  return null;
}
