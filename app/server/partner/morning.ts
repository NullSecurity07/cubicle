import { createHash } from 'node:crypto';
import type { Lead } from '../../shared/leads.ts';
import type { ChatMessage, Decision, Stage, Task } from '../../shared/model.ts';
import { bare, morningText, readMorning, type Bet, type MorningNote } from '../../shared/partner.ts';
import { localDay, weekDay } from '../clock.ts';
import type { ModelMessage } from '../prompt.ts';
import { checkReply } from '../truth.ts';
import { gatherMonth } from '../slices/month.ts';
import type { PartnerState } from './state.ts';

// The partner's morning: once a day, unasked, they read the Company document (it is in their prompt), what changed
// since yesterday and the bets on record, and write three things that matter today, one risk and one question.
// Every fact they are handed is read out of the stores here; the model only chooses what matters.

const DAY = 86_400_000;
// Not before this hour: a note written at a quarter past midnight is yesterday's evening, not the founder's morning.
export const MORNING_HOUR = 6;
// A day's tries, and the wait between them, when the model is out or will not keep the shape.
export const MOST_TRIES = 3;
export const RETRY_AFTER = 30 * 60_000;
const CHAT_LINES = 4;
const CHAT_CHARS = 220;
const CHAT_MOST = 3000;

// Whether this moment should bring the morning note: a new day, late enough, and tries left.
export function morningDue(state: Pick<PartnerState, 'morning' | 'tries' | 'partnerSince'>, now: number): boolean {
  const today = localDay(now);
  if (state.morning?.day === today) return false;
  // Not on the day the partner arrived: the founder has done nothing yet for them to look at. The first note is the
  // next morning's, or whenever the founder asks for one.
  if (!state.partnerSince || state.partnerSince >= today) return false;
  if (new Date(now).getHours() < MORNING_HOUR) return false;
  const tries = state.tries?.day === today ? state.tries : null;
  return !tries || (tries.count < MOST_TRIES && now - tries.last >= RETRY_AFTER);
}

export const MORNING_ASK = 'Nobody asked you for this. It is your own daily look at the company, and the founder reads it first thing. '
  + 'Below is what changed since yesterday, the board and the bets on record; the Company document is above. '
  + 'Give three moves for today: what to do, and why, each a concrete step the founder or a person can start today. '
  + 'Do not restate the Company document or the brief: the founder wrote it and knows it. '
  + 'Use only these facts: name the number or the line each move rests on, and never invent one. '
  + 'Reply in exactly this shape and nothing else, each line under thirty words, with no "My call" line here:\n'
  + 'Three moves for today:\n1. …\n2. …\n3. …\nRisk: one risk, and the fact it rests on\nQuestion: one question for the founder';

// Everything the note is read from, as one short key: decisions, bets, the Company document and what the founder or a
// person said last in each room. The partner's own messages are left out, since the note itself is one of them.
export function morningInputs(input: { stage: Stage; partnerId: string; decisions: Decision[]; bets: Bet[]; company: string; chats: Record<string, ChatMessage[]> }): string {
  const talk = input.stage.rooms.map((room) => {
    const said = (input.chats[room.id] ?? []).filter((message) => message.role === 'user' || room.id !== input.partnerId);
    return `${room.id}:${said.at(-1)?.at ?? 0}`;
  });
  const text = JSON.stringify([input.decisions.map((one) => [one.id, one.status, one.decidedAt ?? 0]), input.bets.map((one) => [one.id, one.status, one.result?.at ?? 0]), input.company, talk]);
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// A note whose three moves are all lines of the Company document tells the founder what they wrote, not what to do.
const flat = (text: string) => text.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').replace(/[.;:!]+$/, '').trim();
export const restates = (things: string[], company: string) => !!company.trim() && things.every((thing) => flat(company).includes(flat(thing)));

// What goes to the model with the ask, from the stores themselves.
export type MorningSources = {
  workspace: string; stage: Stage; partnerId: string; now: number;
  decisions: () => Promise<Decision[]>; boards: (boardId: string) => Promise<Task[]>; leads: (cardId: string) => Promise<Lead[]>;
  chat: (roomId: string) => Promise<ChatMessage[]>; bets: () => Promise<Bet[]>;
  // The Company document's text, to tell a note that only restates it from one that moves the company.
  company?: string;
};

const betLine = (bet: Bet) => (bet.status === 'open'
  ? `- Open: ${bare(bet.what)}. Bet: ${bare(bet.hypothesis) || 'unsaid'}. ${bet.metric} to ${bet.target} by ${bet.checkDate}.`
  : `- Closed ${bet.checkDate}: ${bare(bet.what)}. ${bet.result?.verdict === 'worked' ? 'Worked' : 'Did not work'}; ${bet.metric} was ${bet.result?.value ?? 'unread'} against ${bet.target}.${bet.result?.note ? ` ${bet.result.note}` : ''}`);

export async function gatherMorning(from: MorningSources): Promise<string> {
  const yesterday = localDay(from.now - DAY);
  const start = new Date(`${yesterday}T00:00:00`).getTime();
  // The partner holds the whole company, so every card is read as if it were wired to them.
  const cards = (from.stage.cards ?? []).map((card) => card.id);
  const seen: Stage = { ...from.stage, wires: [...from.stage.wires, ...cards.map((id) => ({ id: `morning-${id}`, from: from.partnerId, fromHandle: 'r', to: id, toHandle: 'l' }))] };
  const changed = (await gatherMonth({ workspace: from.workspace, stage: seen, roomId: from.partnerId, decisions: from.decisions, boards: from.boards, leads: from.leads, now: from.now }, yesterday))
    .split('\n').map((line) => line.replace(/^Not wired to you: (.+)\. Say so in the update rather than guessing\.$/, 'Not on the stage: $1.')).join('\n');

  const talk: string[] = [];
  for (const room of from.stage.rooms) {
    const said = (await from.chat(room.id).catch(() => [] as ChatMessage[])).filter((message) => message.at >= start && message.text.trim()).slice(-CHAT_LINES);
    if (!said.length) continue;
    talk.push(`${room.name} (${room.role}):`, ...said.map((message) => `  ${message.role === 'assistant' ? room.name : message.from ?? 'Founder'}: ${message.text.replace(/\s+/g, ' ').slice(0, CHAT_CHARS)}`));
  }
  let chats = talk.join('\n');
  if (chats.length > CHAT_MOST) chats = `${chats.slice(0, CHAT_MOST)}\n  …(more was said)`;

  // What the plan put on today, or left from earlier days: the moves most likely to be due.
  const today = localDay(from.now);
  const planned: string[] = [];
  for (const card of (from.stage.cards ?? []).filter((one) => one.kind === 'board')) {
    for (const task of await from.boards(card.id).catch(() => [] as Task[])) if (task.due && task.due <= today && task.column !== 'done') planned.push(`- ${task.due < today ? `left from ${task.due}: ` : ''}${task.title}`);
  }

  const bets = (await from.bets().catch(() => [] as Bet[])).filter((bet) => bet.status !== 'proposed');
  const open = bets.filter((bet) => bet.status === 'open');
  const closed = bets.filter((bet) => bet.status === 'closed').slice(-5);
  return [
    changed,
    `Said since ${yesterday}:`, chats || '- nothing',
    'On the board for today:', ...(planned.length ? planned.slice(0, 12) : ['- nothing dated today']),
    'Bets:', ...(open.length || closed.length ? [...open, ...closed].map(betLine) : ['- none on record']),
  ].join('\n');
}

// One morning turn: the partner's own prompt, the ask and the facts, and the reply held to its shape. Gives back the
// note, or null when the reply lost the shape (nothing is posted then; the next try comes later).
export async function writeMorning(input: {
  sources: MorningSources; name: string;
  promptFor: (stage: Stage, roomId: string) => Promise<ModelMessage[]>;
  ask: (messages: ModelMessage[]) => Promise<string>;
}): Promise<MorningNote | null> {
  const { sources } = input;
  const facts = await gatherMorning(sources);
  const messages: ModelMessage[] = [...await input.promptFor(sources.stage, sources.partnerId), { role: 'user', content: `${MORNING_ASK}\n\n${facts}` }];
  const reply = await input.ask(messages);
  const read = readMorning(reply);
  if (!read || restates(read.things, sources.company ?? '')) return null;
  // The truth net, as every turn has it: a figure in the note that nothing it was given holds is flagged under it,
  // and the note is posted all the same, so the founder sees both.
  const flags = checkReply({ reply, receipts: [], sources: messages.map((message) => (typeof message.content === 'string' ? message.content : '')) });
  return { ...read, day: localDay(sources.now), at: sources.now, roomId: sources.partnerId, who: input.name, ...(flags.length ? { flags } : {}) };
}

// How the note reads in the partner's own conversation.
export const morningMessage = (note: MorningNote) => [`**Morning, ${weekDay(note.at)}**`, morningText(note), ...(note.flags ?? [])].join('\n\n');

// The fake model's morning, for a run with no model at all: the same shape, said plainly.
export const FAKE_MORNING = 'Three moves for today:\n1. Fill the empty sections of the Company document, so every answer rests on it.\n2. Decide what waits in Needs you, so nobody works on a guess.\n3. Check the bets that are due against their numbers.\nRisk: the record is thin, so every choice rests on guesses.\nQuestion: What is the one number this week should move?';
