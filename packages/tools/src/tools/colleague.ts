import { z } from 'zod';
import { defineTool } from '../registry.js';
import { nowIso, makeId } from '@cubicle/core';

export const MessageKind = z.enum(['fyi', 'question', 'handoff', 'meeting_request']);

export function messagePath(role: string): string {
  return `Messages/${role}.md`;
}

export const colleagueMessage = defineTool({
  name: 'colleague.message',
  description: 'Send a message to another role. kind=question blocks your job until they answer; handoff also creates a job for them.',
  schema: { to: z.string().describe('role id, e.g. "cto"'), body: z.string(), kind: MessageKind.default('fyi') },
  async handler({ to, body, kind }, ctx) {
    const rolePath = `Roles/${to}.md`;
    if (!ctx.vault.exists(rolePath)) return { ok: false, text: `unknown role: ${to}` };
    const id = makeId('msg');
    const ts = nowIso();
    const section = `\n## ${ts} from ${ctx.roleId} (${kind}) <!-- id:${id}${ctx.jobId ? ` job:${ctx.jobId}` : ''} -->\n\n${body.trim()}\n`;
    ctx.vault.appendText(messagePath(to), section, ctx.roleId, { job: ctx.jobId });
    ctx.events.emit({ type: 'agent.spoke', agent: ctx.roleId, job: ctx.jobId, payload: { to, kind, text: body.slice(0, 280), id } });
    if (kind === 'handoff') {
      const jobId = ctx.scheduler.enqueue({ type: 'custom', title: `Handoff from ${ctx.roleId}: ${body.slice(0, 60)}`, assigned: to, goal: body, parent: ctx.jobId ?? undefined, links: ctx.jobId ? [`[[${ctx.jobId}]]`] : [] });
      return { ok: true, text: `handed off to ${to} as job ${jobId}`, data: { id, jobId } };
    }
    if (kind === 'question') {
      return { ok: true, text: `question sent to ${to} (${id}); this job is now blocked until they answer`, data: { id }, block: { kind: 'message', id } };
    }
    if (kind === 'meeting_request') {
      ctx.scheduler.enqueue({ type: 'custom', title: `Meeting requested by ${ctx.roleId}`, assigned: 'ceo', goal: `${ctx.roleId} requests a meeting with ${to}:\n\n${body}\n\nDecide whether to call meeting.open.`, priority: 2 });
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
  if (changed) vault.writeText(rel, rebuilt.join('\n'), role, { silent: true });
  return out;
}

/** Find an answer to a question id: a later section in the asker's inbox that references `re:<id>`. */
export function findAnswer(vault: import('@cubicle/core').Vault, asker: string, questionId: string): { from: string; body: string } | null {
  const text = vault.readTextOrNull(messagePath(asker));
  if (!text) return null;
  const re = new RegExp(`## \\S+ from (\\S+) \\(\\w+\\) <!-- id:\\S+[^>]*-->\\n([\\s\\S]*?)(?=\\n## |$)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[2].includes(`re:${questionId}`)) return { from: m[1], body: m[2].replace(/re:\S+/, '').trim() };
  }
  return null;
}
