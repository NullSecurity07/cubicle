import { now as clockNow } from '../clock.ts';
import { leadName } from '../../shared/leads.ts';
import { readAskId, replyAsk, waitingReply } from '../../shared/leads-thread.ts';
import type { Slice } from '../install.ts';
import { leadsCardIds, leadsFor } from '../leads/store.ts';
import { createThread, drafterOf } from '../leads/thread.ts';
import { createMail, type Mail } from '../mail.ts';
import { metricsFor } from '../metrics/store.ts';
import { healthRows } from '../openends/health.ts';

// A lead's thread as the founder works it: "They replied" with what they wrote, "Meeting set" with a day, the notes
// after it, and "Open in Gmail" on a drafted email. Needs you carries what waits (a reply to answer, a meeting's notes,
// a reading to log), and with a mail key the people's inboxes are read every ten minutes for replies from leads.
// The moves themselves live in `leads/thread.ts`.

export const POLL_EVERY = 10 * 60_000;
export const BY_HAND = 'by hand (no mail key)';

export function threadSlice(make: { mail?: () => Pick<Mail, 'received' | 'ways'>; now?: () => number } = {}): Slice {
  return {
    name: 'leads-thread',
    // After the Leads card, whose store this shares, and the Metrics card, whose store a reading is logged in.
    order: 120,
    install(deps) {
      // Until the one clock lands, the moment comes from here, so a test can move it.
      const now = make.now ?? clockNow;
      // In fake mode there is never a mailbox to read: replies come in by hand, as they do without a key.
      const mail = make.mail ? make.mail() : deps.fake ? createMail({}) : createMail();
      const thread = createThread({ leads: leadsFor(deps.workspace), boards: deps.boards, metrics: () => metricsFor(deps.workspace), loadStage: () => deps.store.loadStage(), now });
      deps.attention?.source(() => thread.asks());
      const changed = () => deps.attention?.refresh().catch(() => {});

      const keyed = () => mail.ways().agentmail;
      healthRows.set('replies', () => ({
        name: 'Replies', ok: true, fix: '',
        detail: keyed() ? 'read from your people\'s AgentMail inboxes every 10 minutes, from lead addresses only' : `${BY_HAND}: press "They replied" on a lead and paste what they wrote`,
      }));

      let last = 0;
      async function tick() {
        if (!keyed() || now() - last < POLL_EVERY) return;
        last = now();
        if (await thread.poll(mail).catch(() => 0)) await changed();
      }

      return {
        tick,
        async route(req, res, path) {
          if (req.method !== 'POST') return false;
          // A drafted email the founder opened in Gmail, from the chat or from Needs you.
          if (path === '/api/leads-thread/opened') {
            const sent = await deps.body(req);
            const draft = typeof sent?.id === 'string' ? sent.id : '';
            const to = typeof sent?.to === 'string' ? sent.to.split(/[,;\s]+/) : [];
            if (!draft.startsWith('mail-draft:')) { deps.json(res, 400, { error: 'that is not a drafted email' }); return true; }
            const moved = await thread.opened(await deps.store.loadStage(), draft, to);
            if (moved.length) await changed();
            deps.json(res, 200, { moved });
            return true;
          }
          // An answer to something in Needs you: a reading logged or declined, an ask waved away, a reply to draft.
          if (path === '/api/leads-thread/answer') {
            const sent = await deps.body(req);
            const named = readAskId(String(sent?.id ?? ''));
            if (!named || !leadsCardIds(await deps.store.loadStage()).includes(named.cardId)) { deps.json(res, 400, { error: 'that is not on a Leads card' }); return true; }
            try {
              if (sent?.do === 'dismiss') {
                if (named.kind === 'lead-reading') await thread.answer(named.cardId, named.leadId, named.at, false);
                else await thread.close(named.cardId, named.leadId, named.kind === 'lead-replied' ? 'replied' : 'notes');
                await changed();
                deps.json(res, 200, { ok: true });
              } else if (sent?.do === 'log' && named.kind === 'lead-reading') {
                await thread.answer(named.cardId, named.leadId, named.at, true);
                await changed();
                deps.json(res, 200, { ok: true });
              } else if (sent?.do === 'notes' && named.kind === 'lead-notes') {
                await thread.notes(named.cardId, named.leadId, String(sent?.text ?? ''));
                await changed();
                deps.json(res, 200, { ok: true });
              } else deps.json(res, 400, { error: 'say what to do with it' });
            } catch (error) { deps.json(res, 400, { error: (error as Error).message }); }
            return true;
          }
          const asked = /^\/api\/leads\/([a-z0-9][a-z0-9-]{0,63})\/(lead-[a-z0-9]{1,40})\/(replied|meeting|meeting-notes|reply-ask)$/.exec(path);
          if (!asked) return false;
          const [, cardId, leadId, part] = asked;
          const stage = await deps.store.loadStage();
          if (!leadsCardIds(stage).includes(cardId)) { deps.json(res, 404, { error: 'there is no Leads card by that name' }); return true; }
          const sent = await deps.body(req);
          try {
            if (part === 'replied') deps.json(res, 200, await thread.replied(cardId, leadId, String(sent?.text ?? '')));
            else if (part === 'meeting') {
              const { lead, board } = await thread.meeting(cardId, leadId, String(sent?.day ?? ''), typeof sent?.time === 'string' ? sent.time : '');
              deps.json(res, 200, { lead, board });
            } else if (part === 'meeting-notes') deps.json(res, 200, await thread.notes(cardId, leadId, String(sent?.text ?? '')));
            else {
              // The words for the person who drafts the answer, worked out from the reply as it is now.
              const lead = (await leadsFor(deps.workspace).list(cardId)).find((one) => one.id === leadId);
              const reply = lead ? waitingReply(lead) ?? [...(lead.thread ?? [])].reverse().find((event) => event.kind === 'replied') : null;
              const drafter = drafterOf(stage, cardId);
              if (!lead || !reply) deps.json(res, 404, { error: 'there is no reply on that lead' });
              else if (!drafter) deps.json(res, 409, { error: 'Wire a person to the Leads card first, and they will draft it.' });
              else { deps.json(res, 200, { roomId: drafter.id, name: drafter.name, lead: leadName(lead), text: replyAsk(lead, reply.text ?? '') }); return true; }
              return true;
            }
            await changed();
          } catch (error) { deps.json(res, 400, { error: (error as Error).message }); }
          return true;
        },
        async close() { healthRows.delete('replies'); },
      };
    },
  };
}

export default threadSlice();
