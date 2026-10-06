import { resolve } from 'node:path';
import { unreachedFor } from '../tools/unread.ts';
import { LEAD_STAGES, leadName, leadsChannel, STAGE_NAMES, type Lead, type LeadsEvent } from '../../shared/leads.ts';
import { now as clockNow, shortDay } from '../clock.ts';
import { hub } from '../events.ts';
import type { Slice } from '../install.ts';
import { createOutreach, fakeRunner, outreachEnv, uvxRunner } from '../leads/openoutreach.ts';
import { EMAIL, isStage, leadsCardIds, leadsFor, type Leads } from '../leads/store.ts';
import { createThread } from '../leads/thread.ts';
import { metricsFor } from '../metrics/store.ts';
import { draftId, draftOf } from '../../shared/maildraft.ts';
import { wired } from '../prompt.ts';
import { withSystem, type Handler } from '../seams.ts';
import { offerWhenWired } from '../slice-kit.ts';
import { text, type Tool, type ToolContext } from '../tools/registry.ts';

// The Leads card: the founder's list of people to sell to, a light CRM on the stage. People wired to it add, score,
// note and move leads, and may find new ones with OpenOutreach. Only the founder marks a lead contacted, by hand or
// by saying yes to an email that went to them: reaching out is theirs.

export const NO_CARD = 'no Leads card is connected to your room. The founder adds one from the dock and draws a wire to it.';
export const LEAD_TOOLS = ['add_lead', 'score_lead', 'note_lead', 'move_lead', 'list_leads', 'find_leads'];
export const FIND_MAX = 25;
const HINT = '- A Leads card: the founder\'s list of people to sell to. Read it with list_leads, add with add_lead, score with score_lead (the icp-fit skill), '
  + 'write down evidence with note_lead, move with move_lead. Only the founder marks a lead contacted. find_leads finds new ones with OpenOutreach.';

const cardsOf = leadsCardIds;
const cardOf = (context: ToolContext) => wired(context.stage, context.roomId, cardsOf(context.stage))[0];
const need = (context: ToolContext) => { const id = cardOf(context); if (!id) throw new Error(NO_CARD); return id; };
const nameOf = (context: ToolContext) => context.stage.rooms.find((room) => room.id === context.roomId)?.name ?? 'a person';

// One line a lead, short enough for a weak model to hold twenty of them.
export function leadLine(lead: Lead): string {
  const who = [lead.person.name, lead.person.title].filter(Boolean).join(', ');
  const last = lead.notes.at(-1);
  return `- [${lead.stage}] ${who} at ${lead.company.name}${lead.fit ? ` · fit ${lead.fit.score}/10` : ''}${lead.person.email ? ` · ${lead.person.email}` : ''}`
    + ` · added ${shortDay(lead.addedAt)}${last ? ` · last note ${shortDay(last.at)}: ${last.text.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
}

export function leadTools(leads: Leads, outreach: ReturnType<typeof createOutreach>): Tool[] {
  return [
    {
      name: 'add_lead', perTurn: 5,
      description: 'Add a person to the Leads card wired to you. Name them and their company. Give their email when you know it; for someone already on the card, it sets theirs.',
      parameters: { type: 'object', properties: { person: { type: 'string', description: 'Full name' }, company: { type: 'string' }, email: { type: 'string', description: 'Their work email, if known' }, why: { type: 'string', description: 'Why they may buy, with a link' } }, required: ['person', 'company'] },
      async run(args, context) {
        const id = need(context);
        const why = typeof args.why === 'string' ? args.why : '';
        const email = typeof args.email === 'string' ? args.email.trim() : '';
        if (email && !EMAIL.test(email)) return { text: `"${email.slice(0, 200)}" is not an email address. Add them without it, or with the right one.` };
        const company = text(args, 'company', 120);
        // A lead whose page did not load this turn carries that, not a fit nothing read supports.
        const unread = context.reads ? unreachedFor(company, why, context.reads()) : null;
        const note = unread ? `Page not reachable: ${unread} did not load, so nothing read says why ${company} fits yet.` : why;
        const { lead, added } = await leads.add(id, { name: text(args, 'person', 120), company, source: 'person', ...(email ? { email } : {}), ...(note.trim() ? { note: { by: nameOf(context), text: note } } : {}) });
        if (added && unread) return { text: `Added ${leadName(lead)}. ${unread} was not reachable, so its note says "page not reachable" instead of why they fit. Read another source before you score them or say they fit.` };
        if (added) return { text: `Added ${leadName(lead)}.` };
        // Already here: an email given now fills in, or corrects, the one on the card.
        if (email && email !== lead.person.email) {
          await leads.email(id, lead.id, email);
          return { text: `${leadName(lead)} is already here, in ${STAGE_NAMES[lead.stage]}. Their email is now ${email}.` };
        }
        return { text: `${leadName(lead)} is already here, in ${STAGE_NAMES[lead.stage]}.` };
      },
    },
    {
      name: 'score_lead', perTurn: 5,
      description: 'Score how well a lead fits, 0 to 10, with the reason. Use the icp-fit skill. 7 or more moves a new lead to Fit.',
      parameters: { type: 'object', properties: { lead: { type: 'string', description: 'Name, or "name at company"' }, score: { type: 'number', description: '0 to 10' }, why: { type: 'string', description: 'The evidence, with links' } }, required: ['lead', 'score', 'why'] },
      async run(args, context) {
        const id = need(context);
        const lead = await leads.find(id, text(args, 'lead', 200));
        const scored = await leads.score(id, lead.id, Number(args.score), text(args, 'why', 1000));
        return { text: `Scored ${leadName(scored)} ${scored.fit!.score}/10. Now in ${STAGE_NAMES[scored.stage]}.` };
      },
    },
    {
      name: 'note_lead', perTurn: 5,
      description: 'Write a note on a lead: evidence, what was said, what comes next.',
      parameters: { type: 'object', properties: { lead: { type: 'string', description: 'Name, or "name at company"' }, text: { type: 'string' } }, required: ['lead', 'text'] },
      async run(args, context) {
        const id = need(context);
        const lead = await leads.find(id, text(args, 'lead', 200));
        await leads.note(id, lead.id, nameOf(context), text(args, 'text', 2000));
        return { text: `Noted on ${leadName(lead)}.` };
      },
    },
    {
      name: 'move_lead', perTurn: 5,
      description: 'Move a lead to another stage, e.g. replied or meeting when the founder says so. Only the founder marks one contacted.',
      parameters: { type: 'object', properties: { lead: { type: 'string', description: 'Name, or "name at company"' }, stage: { type: 'string', enum: [...LEAD_STAGES] } }, required: ['lead', 'stage'] },
      async run(args, context) {
        const id = need(context);
        const stage = args.stage;
        if (!isStage(stage)) throw new Error(`a stage is one of ${LEAD_STAGES.join(', ')}`);
        if (stage === 'contacted') throw new Error('only the founder marks a lead contacted, once they have sent the message. Draft it, and let them send it.');
        const lead = await leads.find(id, text(args, 'lead', 200));
        await leads.move(id, lead.id, stage);
        return { text: `Moved ${leadName(lead)} to ${STAGE_NAMES[stage]}.` };
      },
    },
    {
      name: 'list_leads', perTurn: 2,
      description: 'Read the Leads card wired to you, one line a lead. Give a stage to see only that one.',
      parameters: { type: 'object', properties: { stage: { type: 'string', enum: [...LEAD_STAGES] } } },
      async run(args, context) {
        const all = await leads.list(need(context));
        const shown = isStage(args.stage) ? all.filter((lead) => lead.stage === args.stage) : all;
        if (!shown.length) return { text: all.length ? `No leads in ${STAGE_NAMES[args.stage as Lead['stage']]}.` : 'The Leads card is empty.' };
        return { text: shown.map(leadLine).join('\n') };
      },
    },
    {
      name: 'find_leads', perTurn: 1,
      description: 'Find new leads that fit the founder\'s ideal customer, with OpenOutreach. Takes minutes. Ask for emails only when the founder wants them.',
      parameters: { type: 'object', properties: { count: { type: 'number', description: `How many new leads, 1 to ${FIND_MAX}` }, emails: { type: 'boolean', description: 'Also buy verified emails. Costs credits. Default false' } }, required: ['count'] },
      ready: () => outreach.ready(),
      approval: async (args) => `Find ${countOf(args)} leads with OpenOutreach? Plain finding spends nothing; verified emails cost 1 credit each (40 free).${args.emails === true ? ' This one buys emails.' : ''}`,
      async run(args, context) {
        const id = need(context);
        const { leads: found, short } = await outreach.find(countOf(args), args.emails === true, context.signal);
        let added = 0;
        for (const one of found) if ((await leads.add(id, one)).added) added++;
        const already = found.length - added;
        return { text: `${added} new lead${added === 1 ? '' : 's'} on the card${already ? `, ${already} already there` : ''}.${short ? ` OpenOutreach stopped short: ${short}.` : ''}${added ? ' Next: score them with score_lead.' : ''}` };
      },
    },
  ];
}
const countOf = (args: Record<string, unknown>) => Math.max(1, Math.min(FIND_MAX, Math.round(Number(args.count) || 5)));

export default {
  name: 'leads',
  install(deps) {
    const say = (cardId: string, event: LeadsEvent) => hub.say(leadsChannel(cardId), event);
    const leads = leadsFor(deps.workspace, say);
    const outreach = createOutreach({ run: deps.fake ? fakeRunner : uvxRunner(), env: () => outreachEnv(process.env, deps.root ?? resolve('.')) });
    // Once at start, so the first person to ask is not the one kept waiting. The made-up one is always ready.
    if (deps.fake) outreach.ready = () => null;
    else void outreach.check();
    const onStage = async () => cardsOf(await deps.store.loadStage());

    // A window that opens late gets every leads card's list at once.
    const opening = async () => Promise.all((await onStage()).map(async (id) => ({ channel: leadsChannel(id), data: await leads.read(id) })));
    const unopen = hub.open(opening);

    // A person wired to a Leads card is told it is there, in one line, beside the other cards they can reach.
    const before: Handler<'turn:before'> = async (payload, next) => {
      if (payload.messages[0]?.role !== 'system') return next(payload);
      const stage = await deps.store.loadStage().catch(() => null);
      if (!stage || !wired(stage, payload.roomId, cardsOf(stage)).length) return next(payload);
      return next(withSystem(payload, HINT));
    };
    // An email the founder said yes to, to somebody on a wired Leads card, is the founder contacting them; one a
    // person drafted is written on the thread of whoever it is to, so the founder opening it in Gmail can count too.
    const thread = createThread({ leads, boards: deps.boards, metrics: () => metricsFor(deps.workspace), loadStage: () => deps.store.loadStage(), now: clockNow });
    const after: Handler<'tool:after'> = async (payload, next) => {
      const { event, roomId } = payload;
      if ((event.name === 'send_email' || event.name === 'draft_email') && event.ok) {
        const to = String(event.args.to ?? '').toLowerCase().split(/[,;\s]+/).map((one) => one.trim()).filter(Boolean);
        const subject = String(event.args.subject ?? '');
        const stage = await deps.store.loadStage().catch(() => null);
        if (stage && event.name === 'send_email') await thread.sent(stage, wired(stage, roomId, cardsOf(stage)), { to, subject, room: roomId, via: event.args.from === 'founder' ? 'gmail' : 'agentmail' }).catch(() => {});
        const draft = draftOf(event.args);
        if (stage && draft && event.name === 'draft_email') await thread.drafted(stage, { to, subject, draft: draftId(draft), room: roomId }).catch(() => {});
      }
      return next(payload);
    };
    const off = deps.seams ? [deps.seams.on('turn:before', before), deps.seams.on('tool:after', after)] : [];

    return {
      tools: leadTools(leads, outreach),
      // Offered only to a person with a Leads card wired to them.
      offer: offerWhenWired('leads', LEAD_TOOLS),
      async route(req, res, path) {
        const asked = /^\/api\/leads\/([a-z0-9][a-z0-9-]{0,63})(?:\/(lead-[a-z0-9]{1,40})(?:\/(notes))?)?$/.exec(path);
        if (!asked) return false;
        const [, cardId, leadId, part] = asked;
        if (!(await onStage()).includes(cardId)) { deps.json(res, 404, { error: 'there is no Leads card by that name' }); return true; }
        const method = req.method ?? 'GET';
        try {
          if (!leadId && method === 'GET') { deps.json(res, 200, await leads.read(cardId)); return true; }
          // The founder adds by hand: a name, a company and one line, which becomes the first note.
          if (!leadId && method === 'POST') {
            const sent = await deps.body(req);
            const line = typeof sent?.line === 'string' ? sent.line : '';
            const email = typeof sent?.email === 'string' && EMAIL.test(sent.email.trim()) ? sent.email.trim() : '';
            const { lead, added } = await leads.add(cardId, { name: String(sent?.name ?? ''), company: String(sent?.company ?? ''), source: 'founder', ...(email ? { email } : {}), ...(line.trim() ? { note: { by: 'Founder', text: line } } : {}) });
            if (added) deps.json(res, 200, lead);
            else deps.json(res, 409, { error: `${leadName(lead)} is already here` });
            return true;
          }
          if (leadId && part === 'notes' && method === 'POST') { deps.json(res, 200, await leads.note(cardId, leadId, 'Founder', String((await deps.body(req))?.text ?? ''))); return true; }
          if (leadId && !part && method === 'PATCH') {
            const sent = await deps.body(req);
            if (!isStage(sent?.stage)) { deps.json(res, 400, { error: `a stage is one of ${LEAD_STAGES.join(', ')}` }); return true; }
            deps.json(res, 200, await leads.move(cardId, leadId, sent.stage));
            return true;
          }
          if (leadId && !part && method === 'DELETE') { await leads.remove(cardId, leadId); deps.json(res, 200, { ok: true }); return true; }
        } catch (error) { deps.json(res, 400, { error: (error as Error).message }); return true; }
        return false;
      },
      async close() {
        for (const stop of off) stop();
        unopen();
        await leads.settled();
      },
    };
  },
} satisfies Slice;
