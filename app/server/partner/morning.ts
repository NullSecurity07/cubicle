import type { Lead } from '../../shared/leads.ts';
import type { ChatMessage, Decision, Stage, Task } from '../../shared/model.ts';
import { morningText, readMorning, type Bet, type MorningNote } from '../../shared/partner.ts';
import { localDay, weekDay } from '../clock.ts';
import type { ModelMessage } from '../prompt.ts';
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
export function morningDue(state: Pick<PartnerState, 'morning' | 'tries'>, now: number): boolean {
  const today = localDay(now);
  if (state.morning?.day === today) return false;
  if (new Date(now).getHours() < MORNING_HOUR) return false;
  const tries = state.tries?.day === today ? state.tries : null;
  return !tries || (tries.count < MOST_TRIES && now - tries.last >= RETRY_AFTER);
}

export const MORNING_ASK = 'Nobody asked you for this. It is your own daily look at the company, and the founder reads it first thing. '
  + 'Below is what changed since yesterday and the bets on record; the Company document is above. '
  + 'Use only these facts: name the number or the line each point rests on, and never invent one. '
  + 'Reply in exactly this shape and nothing else, each line under thirty words:\n'
  + 'Three things that matter today:\n1. …\n2. …\n3. …\nRisk: one risk, and the fact it rests on\nQuestion: one question for the founder';

// What goes to the model with the ask, from the stores themselves.
export type MorningSources = {
  workspace: string; stage: Stage; partnerId: string; now: number;
  decisions: () => Promise<Decision[]>; boards: (boardId: string) => Promise<Task[]>; leads: (cardId: string) => Promise<Lead[]>;
  chat: (roomId: string) => Promise<ChatMessage[]>; bets: () => Promise<Bet[]>;
};

const betLine = (bet: Bet) => (bet.status === 'open'
  ? `- Open: ${bet.what}. Bet: ${bet.hypothesis || 'unsaid'}. ${bet.metric} to ${bet.target} by ${bet.checkDate}.`
  : `- Closed ${bet.checkDate}: ${bet.what}. ${bet.result?.verdict === 'worked' ? 'Worked' : 'Did not work'}; ${bet.metric} was ${bet.result?.value ?? 'unread'} against ${bet.target}.${bet.result?.note ? ` ${bet.result.note}` : ''}`);

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

  const bets = (await from.bets().catch(() => [] as Bet[])).filter((bet) => bet.status !== 'proposed');
  const open = bets.filter((bet) => bet.status === 'open');
  const closed = bets.filter((bet) => bet.status === 'closed').slice(-5);
  return [
    changed,
    `Said since ${yesterday}:`, chats || '- nothing',
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
  const read = readMorning(await input.ask(messages));
  if (!read) return null;
  return { ...read, day: localDay(sources.now), at: sources.now, roomId: sources.partnerId, who: input.name };
}

// How the note reads in the partner's own conversation.
export const morningMessage = (note: MorningNote) => `**Morning, ${weekDay(note.at)}**\n\n${morningText(note)}`;

// The fake model's morning, for a run with no model at all: the same shape, said plainly.
export const FAKE_MORNING = 'Three things that matter today:\n1. Read the Company document and fill what is empty.\n2. Look at the decisions waiting for you.\n3. Check the bets that are due.\nRisk: the record is thin, so every choice rests on guesses.\nQuestion: What is the one number this week should move?';
