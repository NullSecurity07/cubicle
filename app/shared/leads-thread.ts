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

// How many people the notes say pay, and the working. Journey 16: "Anna and two ward colleagues signed up and paid"
// logged one paying customer for three. The people of the clause before the word for paying are counted: each name
// once ("Anna Kowalski" is one), "two colleagues" by its number, "three of us" as all of them; no one named is one.
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, both: 2, 'a couple of': 2, 'a pair of': 2 };
const NUMBER = `\\d{1,3}|${Object.keys(NUMBERS).filter((one) => one !== 'both').join('|')}`;
const valueOf = (word: string) => NUMBERS[word.toLowerCase()] ?? Number(word);
const WHOLE = new RegExp(`\\b(${NUMBER}|all|both)\\s+of\\s+(?:us|them|you|the\\s+[\\p{L}-]+)\\b`, 'iu');
const MORE = new RegExp(`\\b(${NUMBER})\\s+(?:more\\s+|other\\s+)?(?:(?:of\\s+)?(?:her|his|their|my|our|the)\\s+)?((?:[\\p{L}-]+\\s+){0,2}?(?:[\\p{L}-]+s|people|staff|others))\\b`, 'giu');
// Capitalised words that name nobody.
const NOBODY = /^(?:she|he|they|we|i|you|the|and|but|both|all|also|after|before|then|today|yesterday|good|great|meeting|call|notes?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|st|saint|hospital|clinic|ward|team|so|on|in|at|it|this|that|there|our|my|her|his|their)$/i;
export function payingPeople(notes: string): { count: number; working?: string } | null {
  for (const match of notes.matchAll(PAID)) {
    const head = notes.slice(0, match.index).split(/[.!?;\n]/).at(-1)!;
    if (NOT.test(head.split(/\s+/).filter(Boolean).slice(-4).join(' '))) continue;
    // The clause that pays: after the last "but" or "then", and never what someone else did before it.
    const who = head.split(/\b(?:but|then|while|whereas)\b/i).at(-1)!;
    const whole = WHOLE.exec(who);
    if (whole) {
      const count = whole[1].toLowerCase() === 'all' ? 0 : valueOf(whole[1]);
      if (count) return { count, ...(count > 1 ? { working: `${whole[0].trim()} = ${count}` } : {}) };
    }
    const parts: string[] = [];
    let count = 0;
    let rest = who;
    for (const more of who.matchAll(MORE)) {
      count += valueOf(more[1]);
      parts.push(more[0].trim());
      rest = rest.replace(more[0], ' ');
    }
    // Each name once, not one an organisation's ("from St. Marien"), nor one whose people are meant ("Anna's colleagues").
    const names = [...rest.matchAll(/(?<![\p{L}'])(\p{Lu}[\p{Ll}-]+(?:\s+\p{Lu}[\p{Ll}-]+)*)(?![\p{L}'’-])/gu)]
      .filter((name) => !/\b(?:from|at|of|with|for|in)\s+$/i.test(rest.slice(0, name.index)))
      .map((name) => name[1].split(/\s+/).filter((word) => !NOBODY.test(word)).join(' ')).filter(Boolean);
    // "She and 4 night nurses": the one the notes are about, named by a pronoun.
    const one = !names.length && /\b(?:she|he)\b/i.exec(rest);
    if (one) names.push(one[0]);
    count += names.length;
    parts.unshift(...names);
    if (!count && /\bboth\b/i.test(who)) return { count: 2, working: 'both = 2' };
    if (!count) return { count: 1 };
    return { count, ...(count > 1 ? { working: `${parts.join(' + ')} = ${count}` } : {}) };
  }
  return null;
}
export const readingOf = (notes: string): { conversations: number; paying: number; working?: string } => {
  const paying = payingPeople(notes);
  return { conversations: 1, paying: paying?.count ?? 0, ...(paying?.working ? { working: paying.working } : {}) };
};

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
export const readingDetail = (notes: ThreadEvent) => `From your notes: "${short(notes.text ?? '', 160)}"${notes.reading?.working ? `\nPaying counted: ${notes.reading.working}` : ''}`;
