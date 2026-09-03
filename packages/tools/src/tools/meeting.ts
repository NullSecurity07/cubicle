import { z } from 'zod';
import { defineTool } from '../registry.js';
import { makeId, idFromKey, nowIso, stringifyNote, RoleFrontmatter, isValidRoleId, stampForFilename, loadOrg, can } from '@cubicle/core';

const MAX_ROUNDS = 3;
const TURN_TOKENS = 300;

export const meetingOpen = defineTool({
  name: 'meeting.open',
  description: 'Hold a round-robin meeting (max 3 rounds, short turns). The facilitator (you) closes with decisions written to Decisions/. Returns the Meetings/ note path.',
  schema: {
    room: z.enum(['board', 'meeting']).default('meeting'),
    participants: z.array(z.string()).min(1).max(6).describe('role ids'),
    agenda: z.string(),
    rounds: z.number().int().min(1).max(MAX_ROUNDS).default(2),
  },
  async handler({ room, participants, agenda, rounds }, ctx) {
    if (!can(loadOrg(ctx.vault), ctx.roleId, 'meeting')) return { ok: false, text: `${ctx.roleId} may not open meetings; ask your lead` };
    if (!ctx.router) return { ok: false, text: 'no model router available for meetings' };
    for (const p of participants) { if (!isValidRoleId(p) || !ctx.vault.exists(`Roles/${p}.md`)) return { ok: false, text: `unknown role ${p}` }; const rf = RoleFrontmatter.safeParse(ctx.vault.readNoteOrNull(`Roles/${p}.md`)?.data); if (rf.success && !rf.data.active) return { ok: false, text: `${p} is not active` }; }
    const id = ctx.idempotencyKey ? idFromKey('meet', ctx.idempotencyKey) : makeId('meet');
    const rel = `Meetings/${stampForFilename()}-${room}-${id.slice(-6)}.md`;
    if (ctx.vault.list('Meetings', { ext: '.md' }).some((r) => r.endsWith(`-${id.slice(-6)}.md`))) return { ok: true, text: `meeting ${id} already held (replayed step)` };
    const all = [ctx.roleId, ...participants.filter((p) => p !== ctx.roleId)];
    const charters = Object.fromEntries(all.map((r) => { const n = ctx.vault.readNoteOrNull(`Roles/${r}.md`); return [r, { data: n ? RoleFrontmatter.safeParse(n.data) : null, body: n?.body ?? '' }]; }));
    const constitution = ctx.vault.readTextOrNull('Memory/constitution.md') ?? '';
    const plan = (ctx.vault.readTextOrNull('Plans/plan.md') ?? '').slice(0, 3000);
    ctx.events.emit({ type: 'meeting.opened', agent: ctx.roleId, job: ctx.jobId, payload: { id, room, participants: all, agenda: agenda.slice(0, 200), path: rel } });
    const transcript: { round: number; role: string; text: string }[] = [];
    const say = async (role: string, prompt: string, tier: 'strong' | 'medium' | 'cheap' | 'local', maxTokens: number) => {
      const c = charters[role];
      const system = `# Constitution\n${constitution}\n\n# Your charter (${role})\n${c?.body ?? ''}\n\n# Current plan\n${plan}\n\nYou are in a ${room} meeting. Speak as ${role}, in at most 4 sentences, concrete and specific. No preamble.`;
      const r = await ctx.router!.chat({ tier, needsTools: false, roleId: role }, { messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], maxTokens });
      return r.content.trim();
    };
    for (let round = 1; round <= rounds; round++) {
      for (const role of all) {
        const so_far = transcript.map((t) => `${t.role}: ${t.text}`).join('\n');
        const tier = charters[role]?.data?.success ? charters[role].data!.data.model_tier : 'medium';
        let text: string;
        try { text = await say(role, `Agenda: ${agenda}\n\nRound ${round} of ${rounds}. Transcript so far:\n${so_far || '(none)'}\n\nYour turn.`, tier, TURN_TOKENS); }
        catch (err) { text = `(no model available: ${(err as Error).message.slice(0, 80)})`; }
        transcript.push({ round, role, text });
        ctx.events.emit({ type: 'meeting.turn', agent: role, job: ctx.jobId, payload: { id, round, text: text.slice(0, 280) } });
        // Persist after every turn (spec §1.2): a kill mid-meeting keeps the transcript so far.
        ctx.vault.writeText(rel, stringifyNote({ id, room, opened: nowIso(), facilitator: ctx.roleId, participants: all, status: 'in_progress' }, `# ${room === 'board' ? 'Board' : 'Meeting'}: ${agenda.split('\n')[0].slice(0, 80)}\n\n## Agenda\n\n${agenda}\n\n## Transcript\n\n${transcript.map((t) => `**Round ${t.round} — ${t.role}:** ${t.text}`).join('\n\n')}\n`), ctx.roleId, { job: ctx.jobId, silent: true });
      }
    }
    let decisions = '';
    try {
      decisions = await say(ctx.roleId, `Agenda: ${agenda}\n\nTranscript:\n${transcript.map((t) => `${t.role}: ${t.text}`).join('\n')}\n\nAs facilitator, close the meeting. Output markdown with sections: ## Context, ## Options considered, ## Chosen, ## Why, ## Expected effect, ## Review date (ISO date about two weeks out). Be decisive.`, 'strong', 700);
    } catch { decisions = ''; }
    const required = ['## Context', '## Options considered', '## Chosen', '## Why', '## Expected effect', '## Review date'];
    if (!required.every((h) => decisions.includes(h))) {
      const review = new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10);
      decisions = `## Context\n\n${agenda}\n\n## Options considered\n\n${transcript.map((t) => `- ${t.role}: ${t.text.slice(0, 200)}`).join('\n')}\n\n## Chosen\n\n${decisions.trim() || '(no model summary available; the facilitator must decide from the transcript)'}\n\n## Why\n\nSee transcript.\n\n## Expected effect\n\nTo be verified by the COO.\n\n## Review date\n\n${review}`;
    }
    const decId = idFromKey('dec', id);
    const decRel = `Decisions/${stampForFilename()}-${decId.slice(-6)}.md`;
    ctx.vault.writeText(decRel, stringifyNote({ id: decId, decided_by: ctx.roleId, cycle: ctx.jobId ?? '', status: 'adopted', inputs: [`[[${rel.replace(/\.md$/, '')}]]`], owner_rating: null }, `# Decision from ${room} meeting\n\n${decisions}\n`), ctx.roleId, { job: ctx.jobId });
    const body = `# ${room === 'board' ? 'Board' : 'Meeting'}: ${agenda.split('\n')[0].slice(0, 80)}\n\n## Agenda\n\n${agenda}\n\n## Transcript\n\n${transcript.map((t) => `**Round ${t.round} — ${t.role}:** ${t.text}`).join('\n\n')}\n\n## Decisions\n\nSee [[${decRel.replace(/\.md$/, '')}]].\n`;
    ctx.vault.writeText(rel, stringifyNote({ id, room, opened: nowIso(), facilitator: ctx.roleId, participants: all, decision: decId }, body), ctx.roleId, { job: ctx.jobId });
    ctx.events.emit({ type: 'meeting.closed', agent: ctx.roleId, job: ctx.jobId, payload: { id, path: rel, decision: decRel, turns: transcript.length } });
    return { ok: true, text: `meeting held: ${rel}; decision recorded at ${decRel}\n\n${decisions.slice(0, 1500)}`, data: { path: rel, decision: decRel } };
  },
});
