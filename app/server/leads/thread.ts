import { leadName, type Lead } from '../../shared/leads.ts';
import {
  addressOf, askId, isDay, notesDetail, notesOwed, notesTitle, readingDetail, readingOf, readingOwed, readingTitle,
  replyDetail, replyTitle, stageAfter, waitingReply,
} from '../../shared/leads-thread.ts';
import type { Metric } from '../../shared/metrics.ts';
import type { Attention, Stage } from '../../shared/model.ts';
import type { Boards } from '../boards.ts';
import { localDay } from '../clock.ts';

// The time where the founder is, "HH:MM", for when a meeting today is over.
const clockOf = (at: number) => { const time = new Date(at); return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`; };
import type { Mail } from '../mail.ts';
import type { MetricsStore } from '../metrics/store.ts';
import { wired } from '../prompt.ts';
import { leadsCardIds, type Leads } from './store.ts';

// One lead's thread, end to end: drafted, sent or opened in Gmail, replied, meeting set, notes taken, a reading for the
// Metrics card. Every stage move happens here, in code, from something that happened: a send the founder said yes to,
// a draft they opened, a reply that came in or that they pasted, a meeting they set. People never move a lead forward
// by saying so.

// The Metrics store is asked for only when a reading is logged, so the Metrics card is the one that made it and hears it.
export type ThreadDeps = { leads: Leads; boards?: Boards; metrics: () => MetricsStore; loadStage: () => Promise<Stage>; now: () => number };
export type Thread = ReturnType<typeof createThread>;

const boardsOn = (stage: Stage) => (stage.cards ?? []).filter((card) => card.kind === 'board').map((card) => card.id);
const metricsOn = (stage: Stage) => (stage.cards ?? []).filter((card) => card.kind === 'metrics').map((card) => card.id);
// The card a lead's things land on: the one of that kind wired to the Leads card, else the first on the stage.
const nearest = (stage: Stage, cardId: string, ids: string[]) => wired(stage, cardId, ids)[0] ?? ids[0];
// Who drafts for a Leads card: the first person wired to it, the way the card's own button defaults.
export const drafterOf = (stage: Stage, cardId: string) => stage.rooms.find((room) => room.id === wired(stage, cardId, stage.rooms.map((one) => one.id))[0]);

// The numbers a meeting's notes count toward, found on the card by what they are called, or made with these names.
const CONVERSATIONS = { label: 'Customer conversations', test: /conversation|interview|calls?\b|meetings?\b/i };
const PAYING = { label: 'Paying customers', test: /paying|paid|customers?\b/i };
const metricFor = (metrics: Metric[], kind: typeof CONVERSATIONS) => metrics.find((metric) => kind.test.test(metric.label) && (kind === PAYING ? !CONVERSATIONS.test.test(metric.label) : true));

export function createThread(deps: ThreadDeps) {
  const { leads } = deps;
  const lower = (list: string[]) => list.map((one) => one.trim().toLowerCase()).filter(Boolean);
  // Every lead on the stage whose address is one of these, with its card.
  async function byAddress(stage: Stage, to: string[]): Promise<{ cardId: string; lead: Lead }[]> {
    const wanted = new Set(lower(to));
    const found: { cardId: string; lead: Lead }[] = [];
    for (const cardId of leadsCardIds(stage)) for (const lead of await leads.list(cardId)) if (lead.person.email && wanted.has(lead.person.email.toLowerCase())) found.push({ cardId, lead });
    return found;
  }
  async function leadOf(cardId: string, leadId: string): Promise<Lead> {
    const lead = (await leads.list(cardId)).find((one) => one.id === leadId);
    if (!lead) throw new Error('that lead is no longer on the card');
    return lead;
  }

  const thread = {
    // A person drafted an email to these addresses: written on each lead it goes to, once per draft.
    async drafted(stage: Stage, input: { to: string[]; subject: string; draft: string; room?: string }) {
      for (const { cardId, lead } of await byAddress(stage, input.to)) {
        if (lead.thread?.some((event) => event.kind === 'drafted' && event.draft === input.draft)) continue;
        await leads.thread(cardId, lead.id, { kind: 'drafted', subject: input.subject.slice(0, 200), draft: input.draft, ...(input.room ? { room: input.room } : {}) });
      }
    },
    // An email the founder said yes to went out: the lead is Contacted, from that day, and the mailbox it went from is
    // the one its reply will come back to.
    async sent(stage: Stage, cardIds: string[], input: { to: string[]; subject: string; room: string; via: 'agentmail' | 'gmail' }) {
      for (const { cardId, lead } of await byAddress(stage, input.to)) {
        if (!cardIds.includes(cardId)) continue;
        await leads.thread(cardId, lead.id, { kind: 'sent', subject: input.subject.slice(0, 200), room: input.room, via: input.via }, stageAfter(lead.stage, 'sent'),
          { by: 'Founder', text: `Emailed: "${input.subject.slice(0, 120)}".` });
      }
    },
    // The founder pressed "Open in Gmail" on a draft: they are sending it themselves, so its leads are Contacted. Only a
    // lead the draft was written to moves, and each draft counts once.
    async opened(stage: Stage, draft: string, to: string[]): Promise<string[]> {
      const moved: string[] = [];
      const wanted = new Set(lower(to));
      for (const cardId of leadsCardIds(stage)) for (const lead of await leads.list(cardId)) {
        const drafted = lead.thread?.some((event) => event.kind === 'drafted' && event.draft === draft);
        if (!drafted && !(lead.person.email && wanted.has(lead.person.email.toLowerCase()))) continue;
        if (lead.thread?.some((event) => event.kind === 'opened' && event.draft === draft)) continue;
        await leads.thread(cardId, lead.id, { kind: 'opened', draft }, stageAfter(lead.stage, 'opened'));
        moved.push(leadName(lead));
      }
      return moved;
    },
    // They wrote back, found in the inbox (`mail` is the message's id, so it is taken once) or pasted by the founder.
    async replied(cardId: string, leadId: string, text: string, mail?: string): Promise<Lead> {
      const words = text.trim().slice(0, 4000);
      if (!words) throw new Error('paste what they wrote');
      const lead = await leadOf(cardId, leadId);
      if (mail && lead.thread?.some((event) => event.mail === mail)) return lead;
      return leads.thread(cardId, leadId, { kind: 'replied', text: words, ...(mail ? { mail } : {}) }, stageAfter(lead.stage, 'replied'));
    },
    // A meeting set for a day: the lead is at Meeting, and the day carries a task on the board so it is not missed.
    async meeting(cardId: string, leadId: string, day: string, time = ''): Promise<{ lead: Lead; board: string | null }> {
      if (!isDay(day)) throw new Error('a meeting day is written YYYY-MM-DD');
      if (time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('a meeting time is written HH:MM');
      const lead = await leadOf(cardId, leadId);
      const stage = await deps.loadStage();
      const boardId = deps.boards ? nearest(stage, cardId, boardsOn(stage)) ?? null : null;
      const task = boardId && deps.boards ? await deps.boards.add(boardId, {
        title: `Meeting with ${leadName(lead)}`, due: day,
        detail: `Set from the Leads card${lead.person.email ? `; ${lead.person.email}` : ''}. Afterwards, write how it went on the lead.`,
      }) : null;
      const moved = await leads.thread(cardId, leadId, { kind: 'meeting', day, ...(time ? { time } : {}), ...(task && boardId ? { boardId, taskId: task.id } : {}) }, stageAfter(lead.stage, 'meeting'));
      return { lead: moved, board: boardId };
    },
    // What the founder wrote after the meeting, kept as a note, with the reading it proposes: one conversation, and one
    // paying customer only when the notes say they pay.
    async notes(cardId: string, leadId: string, text: string): Promise<Lead> {
      const words = text.trim().slice(0, 2000);
      if (!words) throw new Error('a few words on how it went');
      await leadOf(cardId, leadId);
      return leads.thread(cardId, leadId, { kind: 'notes', text: words, reading: readingOf(words) }, null, { by: 'Founder', text: `Meeting notes: ${words}` });
    },
    // The founder's answer to a reading. Yes logs it on the Metrics card (each number one up from its last reading),
    // and a paying customer moves the lead to Customer.
    async answer(cardId: string, leadId: string, at: number, accept: boolean): Promise<Lead> {
      const lead = await leadOf(cardId, leadId);
      const notes = lead.thread?.find((event) => event.at === at && event.kind === 'notes');
      if (!notes?.reading || notes.reading.answer) throw new Error('that reading was already answered');
      if (accept) {
        const stage = await deps.loadStage();
        const metricsId = nearest(stage, cardId, metricsOn(stage));
        if (!metricsId) throw new Error('there is no Metrics card on the stage to log it on');
        const from = `meeting notes, ${leadName(lead)}`;
        for (const [kind, count] of [[CONVERSATIONS, notes.reading.conversations], [PAYING, notes.reading.paying]] as const) {
          if (!count) continue;
          const there = metricFor((await deps.metrics().load(metricsId)).metrics, kind);
          await deps.metrics().log(metricsId, { ref: there?.label ?? kind.label, value: (there?.points.at(-1)?.value ?? 0) + count, from });
        }
        if (notes.reading.paying && lead.stage !== 'customer') await leads.move(cardId, leadId, 'customer');
      }
      return leads.rethread(cardId, leadId, at, (event) => { event.reading = { ...event.reading!, answer: accept ? 'logged' : 'declined' }; });
    },
    // The founder waved an ask away.
    async close(cardId: string, leadId: string, of: 'replied' | 'notes'): Promise<Lead> {
      await leadOf(cardId, leadId);
      return leads.thread(cardId, leadId, { kind: 'closed', of });
    },

    // What waits for the founder across every Leads card: a reply to answer, a meeting's notes, a reading to log.
    async asks(): Promise<Attention[]> {
      const stage = await deps.loadStage();
      const now = deps.now();
      const today = localDay(now);
      const metrics = metricsOn(stage).length > 0;
      const found: Attention[] = [];
      for (const cardId of leadsCardIds(stage)) {
        const drafter = drafterOf(stage, cardId);
        const room = drafter ? { roomId: drafter.id } : {};
        for (const lead of await leads.list(cardId)) {
          const reply = waitingReply(lead);
          if (reply) found.push({ id: askId('lead-replied', cardId, lead.id, reply.at), kind: 'lead-replied', cardId, at: reply.at, title: replyTitle(lead), detail: replyDetail(reply), ...room });
          const meeting = notesOwed(lead, today, clockOf(now));
          if (meeting) found.push({ id: askId('lead-notes', cardId, lead.id, meeting.at), kind: 'lead-notes', cardId, at: Math.min(now, Date.parse(`${meeting.day}T23:59:59`) + 1000), title: notesTitle(lead), detail: notesDetail(meeting) });
          const notes = metrics ? readingOwed(lead) : null;
          if (notes) found.push({ id: askId('lead-reading', cardId, lead.id, notes.at), kind: 'lead-reading', cardId, at: notes.at, title: readingTitle(lead, notes.reading!), detail: readingDetail(notes) });
        }
      }
      return found;
    },

    // One look at the mailboxes replies come back to: the AgentMail inbox of each person wired to a Leads card. Only a
    // message from the address of a lead that was written to is read, and it moves only that lead; every other
    // message is left where it is, unread by anyone here.
    async poll(mail: Pick<Mail, 'received' | 'ways'>): Promise<number> {
      if (!mail.ways().agentmail) return 0;
      const stage = await deps.loadStage();
      let taken = 0;
      for (const cardId of leadsCardIds(stage)) {
        const waiting = (await leads.list(cardId)).filter((lead) => lead.person.email && lead.thread?.some((event) => event.kind === 'sent' || event.kind === 'opened'));
        if (!waiting.length) continue;
        const rooms = wired(stage, cardId, stage.rooms.map((room) => room.id)).map((id) => stage.rooms.find((room) => room.id === id)!);
        for (const room of rooms) {
          const { messages } = await mail.received(room.id, room.name);
          for (const message of messages) {
            const lead = waiting.find((one) => one.person.email!.toLowerCase() === addressOf(message.from));
            if (!lead || lead.thread?.some((event) => event.mail === message.id)) continue;
            await thread.replied(cardId, lead.id, [message.subject, message.preview].filter(Boolean).join('\n') || '(no words)', message.id);
            taken++;
          }
        }
      }
      return taken;
    },
  };
  return thread;
}
