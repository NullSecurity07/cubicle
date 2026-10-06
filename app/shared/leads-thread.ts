import { leadName, type Lead, type LeadStage, type ThreadEvent, type ThreadKind } from './leads.ts';

// A lead's thread: drafted, sent or opened in Gmail, replied, meeting set, notes taken. The stage follows the thread in
// code, never a person's say-so: these rules are the only road from one to the next, and they only ever move forward.

// Where each event takes a lead, and from which stages. A reply to a lead already at a meeting is written down and
// leaves the stage alone; a customer stays a customer whatever comes next.
const FORWARD: Partial<Record<ThreadKind, { to: LeadStage; from: LeadStage[] }>> = {
  sent: { to: 'contacted', from: ['new', 'fit'] },
  opened: { to: 'contacted', from: ['new', 'fit'] },
  replied: { to: 'replied', from: ['new', 'fit', 'contacted'] },
  meeting: { to: 'meeting', from: ['new', 'fit', 'contacted', 'replied', 'passed'] },
};
export function stageAfter(stage: LeadStage, kind: ThreadKind): LeadStage | null {
  const rule = FORWARD[kind];
  return rule && rule.from.includes(stage) ? rule.to : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00`));

const lastIndex = (thread: ThreadEvent[], test: (event: ThreadEvent) => boolean) => { for (let i = thread.length - 1; i >= 0; i--) if (test(thread[i])) return i; return -1; };

// The reply that waits for an answer: the newest one, while the lead is in Replied and nothing was drafted, sent or set
// after it, and the founder did not wave it away.
export function waitingReply(lead: Pick<Lead, 'stage' | 'thread'>): ThreadEvent | null {
  const thread = lead.thread ?? [];
  if (lead.stage !== 'replied') return null;
  const at = lastIndex(thread, (event) => event.kind === 'replied');
  if (at < 0) return null;
  const after = thread.slice(at + 1);
  return after.some((event) => ['drafted', 'sent', 'opened', 'meeting'].includes(event.kind) || (event.kind === 'closed' && event.of === 'replied')) ? null : thread[at];
}

// The meeting whose notes are owed: the newest one, once its day is over where the founder is, while the lead is still
// at Meeting and no notes were written (or the ask waved away) since it was set.
export function notesOwed(lead: Pick<Lead, 'stage' | 'thread'>, today: string): ThreadEvent | null {
  const thread = lead.thread ?? [];
  if (lead.stage !== 'meeting') return null;
  const at = lastIndex(thread, (event) => event.kind === 'meeting');
  if (at < 0 || !thread[at].day || thread[at].day! >= today) return null;
  return thread.slice(at + 1).some((event) => event.kind === 'notes' || (event.kind === 'closed' && event.of === 'notes')) ? null : thread[at];
}

// The reading the newest notes proposed, while the founder has not answered it.
export function readingOwed(lead: Pick<Lead, 'thread'>): ThreadEvent | null {
  const thread = lead.thread ?? [];
  const at = lastIndex(thread, (event) => event.kind === 'notes');
  return at >= 0 && thread[at].reading && !thread[at].reading!.answer ? thread[at] : null;
}

// Whether the notes say this person pays: a word for paying or signing, with no "not" or "won't" just before it. The
// number is only ever what the notes say, so "they might pay later" or "not ready to buy" counts nothing.
const PAID = /\b(paid|pays|paying|signed|bought|purchased|subscribed|ordered|placed an order|became a customer|is a customer|are a customer|agreed to pay|will pay|took the paid plan)\b/gi;
const NOT = /\b(not|no|never|didn't|did not|won't|will not|don't|do not|isn't|wasn't|hasn't|haven't|yet to|might|may|could|would|maybe|if)\b/i;
export function saysPaying(notes: string): boolean {
  for (const match of notes.matchAll(PAID)) {
    const before = notes.slice(0, match.index).split(/[.!?;\n]/).at(-1)!.split(/\s+/).filter(Boolean).slice(-4).join(' ');
    if (!NOT.test(before)) return true;
  }
  return false;
}
export const readingOf = (notes: string): { conversations: number; paying: number } => ({ conversations: 1, paying: saysPaying(notes) ? 1 : 0 });

// The address in a From line, "Ana Ruiz <ana@example.com>" or just the address.
export function addressOf(from: string): string {
  const inside = /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? from.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inside) ? inside.toLowerCase() : '';
}

// The Needs you ids, one per thing waiting: a reply, a meeting's notes, a reading.
export type ThreadAsk = 'lead-replied' | 'lead-notes' | 'lead-reading';
export const askId = (kind: ThreadAsk, cardId: string, leadId: string, at: number) => `${kind}:${cardId}:${leadId}:${at}`;
export function readAskId(id: string): { kind: ThreadAsk; cardId: string; leadId: string; at: number } | null {
  const [kind, cardId, leadId, at] = id.split(':');
  return (kind === 'lead-replied' || kind === 'lead-notes' || kind === 'lead-reading') && cardId && leadId && /^\d+$/.test(at ?? '') ? { kind, cardId, leadId, at: Number(at) } : null;
}

const short = (text: string, most: number) => { const one = text.replace(/\s+/g, ' ').trim(); return one.length > most ? `${one.slice(0, most - 1)}…` : one; };
const dayWords = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
export const meetingWords = dayWords;

// The thread's newest event as the card's row says it.
export function eventLine(event: ThreadEvent): string {
  switch (event.kind) {
    case 'drafted': return 'Email drafted';
    case 'sent': return 'Email sent';
    case 'opened': return 'Opened in Gmail';
    case 'replied': return 'Replied';
    case 'meeting': return event.day ? `Meeting ${dayWords(event.day)}` : 'Meeting set';
    case 'notes': return 'Meeting notes';
    case 'closed': return '';
  }
}
export const lastEvent = (lead: Pick<Lead, 'thread'>) => [...(lead.thread ?? [])].reverse().find((event) => event.kind !== 'closed') ?? null;

// What pressing "Draft an answer" asks the wired person: answer the reply, aiming for a meeting.
export const replyAsk = (lead: Pick<Lead, 'person' | 'company'>, reply: string) =>
  `${leadName(lead)} replied: "${short(reply, 600)}". Draft my answer with draft_email to ${lead.person.name}: answer what they asked in their own words, `
  + 'then propose a short meeting with two concrete times. I will send it myself.';
export const replyTitle = (lead: Pick<Lead, 'person' | 'company'>) => `${leadName(lead)} replied. Draft an answer?`;
export const replyDetail = (reply: ThreadEvent) => `"${short(reply.text ?? '', 200)}"`;
export const notesTitle = (lead: Pick<Lead, 'person'>) => `How did the meeting with ${lead.person.name} go?`;
export const notesDetail = (meeting: ThreadEvent) => `You met ${meeting.day ? `on ${dayWords(meeting.day)}` : 'them'}. A few lines of notes keep what they said, and count the conversation.`;
export function readingTitle(lead: Pick<Lead, 'person'>, reading: { conversations: number; paying: number }): string {
  const parts = [`conversations +${reading.conversations}`, ...(reading.paying ? [`paying customers +${reading.paying}`] : [])];
  return `Log ${parts.join(' and ')} from the meeting with ${lead.person.name}?`;
}
export const readingDetail = (notes: ThreadEvent) => `From your notes: "${short(notes.text ?? '', 160)}"`;
