import { KEPT_MARK, MEMORY_CHANNEL, type ChatMessage, type Stage } from '../../shared/model.ts';
import { fullDay } from '../clock.ts';
import { hub } from '../events.ts';
import type { Slice } from '../install.ts';
import { NOTES_CHARS, type createMemory } from '../memory.ts';
import type { ModelMessage } from '../prompt.ts';
import { readableDocIds } from '../prompt.ts';
import type { ModelClient } from '../providers.ts';
import type { Handler, Payloads } from '../seams.ts';
import { reflectTools } from '../tools/reflect.ts';
import { dropFlagged } from '../truth.ts';
import type { UsageBook } from '../usage.ts';

// Retain: after a conversation turn, a person writes down on its own the one or two things worth keeping from it —
// a price, a name, a promise — the way it would if the founder had said "remember that". Hindsight's idea without its
// stack. Almost every turn is turned away by the rules below before any model is asked, and the one model that is
// asked is the one on this machine: a kept note is never worth a hosted model's daily quota.

// What asks the model: the exchange in, its raw answer out. Tests hand in their own; the app hands in the local model.
export type Extract = (messages: ModelMessage[]) => Promise<string>;
type Memory = ReturnType<typeof createMemory>;
type Store = { readDoc(id: string): Promise<string>; loadStage(): Promise<Stage>; readChat(roomId: string): Promise<ChatMessage[]> };

export const ASKED_CHARS = 80;
export const SAID_CHARS = 120;
export const EVERY_TURNS = 3;
export const EVERY_MS = 10 * 60_000;
// Room left in the notes below which retain stops: what is left belongs to what the founder asks for by name.
export const ROOM_LEFT = 600;
const MOST = 3;
const LINE_CHARS = 200;

export const retainPrompt = (today: number) => `You read one exchange between a founder and a person who works for them. Today is ${fullDay(today)}. `
  + 'List up to three lasting facts worth keeping: a decision, a number, a name, a preference, a promise. One short line each, with the date in the line when it matters. '
  + 'Write NONE when there is nothing lasting. No preamble.';

const SMALL = new Set('the a an and or but of to in on at for with by from as is are was were be been it its this that these those we you they he she i our your their my me us them has have had do does did will would can could should not no so if then than there here what which who when where how about into over just also very really'.split(' '));
// A day, a month or a year, written any of the ways the local model writes them: "1 October 2026", "24 Sept 2026",
// "Oct 1, 2026", "2026-10-01", "Thursday". A date is not what a fact is about, so it never counts as one of its words.
const MONTH = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE = `(?:\\d{4}-\\d{1,2}-\\d{1,2}|(?:\\d{1,2}(?:st|nd|rd|th)?\\s+)?(?:${MONTH})\\.?(?:\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)?,?(?:\\s+\\d{4})?|(?:19|20)\\d{2}|(?:mon|tues|wednes|thurs|fri|satur|sun)day)`;
const DATES = new RegExp(`\\b${DATE}\\b`, 'giu');
const LEADING_DATE = new RegExp(`^${DATE}\\s*[-–—:·|,]\\s*`, 'iu');
const undated = (text: string) => text.replace(DATES, ' ');
const wordsOf = (text: string) => (undated(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !SMALL.has(word));
const numbersOf = (text: string): string[] => undated(text).match(/\d+(?:[.,]\d+)?/g) ?? [];
// A note's words without its date and its mark: what the fact itself says.
const bodyOf = (line: string) => line.replace(/^\s*-\s*/, '').replace(/^\d{1,2} \p{L}{3,9} \d{4} · /u, '').replace(KEPT_MARK, '').trim();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// What a line says once its dates and numbers are gone, counted in words.
const wordCount = (line: string) => undated(line).split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;

// The model's answer as lines worth keeping. A bullet or a number in front goes; a line that only introduces the
// others, a NONE, and anything too long to be one fact go too. An answer that starts with NONE is NONE: on the live
// check the local model wrote "NONE", then the day and the person's name under it, as if they were facts.
// qwen2.5:7b also put the day in front of a line ("24 September 2026 - Our first-year…"), echoed the exchange with its
// speaker in front ("Maya: Got it…"), wrote a bare "1 October 2026" and a label with only a day after it ("Effective
// date: 1 Oct 2026"). The day and the speaker in front go; a line of fewer than three words once its dates and
// numbers are gone is a label, not a fact.
export function parseFacts(raw: string, speakers: string[] = []): string[] {
  const names = speakers.map((name) => name.trim()).filter(Boolean).map(escape);
  const speaker = names.length ? new RegExp(`^(?:${names.join('|')})\\s*:\\s*`, 'iu') : null;
  const lines = raw.split('\n').map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["']|["']$/g, '').trim()).filter(Boolean);
  if (/^none\b/i.test(lines[0] ?? '')) return [];
  return lines
    .map((line) => { const bare = line.replace(LEADING_DATE, ''); return (speaker ? bare.replace(speaker, '') : bare).trim(); })
    .filter((line) => !/^none\b/i.test(line) && !line.endsWith(':') && line.length <= LINE_CHARS)
    // "Effective date: 1 Oct 2026": a label and a day, nothing else.
    .filter((line) => !/^[^:]{1,40}:[\s\p{P}]*$/u.test(undated(line)))
    .filter((line) => wordCount(line) >= 3)
    .slice(0, MOST);
}

// Already in the notes: most of this fact's words are in one line there, the person's own remember lines included.
// Matched on words without dates, so "the price is 19 a month" and "price: 19 a month" are one fact, and the same
// line with a day in front is still the same line. A number the line does not have is news: a changed price is not
// the price already kept.
export function isKnown(fact: string, notes: string): boolean {
  const mine = [...new Set(wordsOf(fact))];
  if (!mine.length) return true;
  const numbers = numbersOf(fact);
  return notes.split('\n').some((line) => {
    const body = bodyOf(line);
    const held = new Set(wordsOf(body));
    if (!held.size) return false;
    const have = numbersOf(body);
    if (numbers.some((number) => !have.includes(number))) return false;
    return mine.filter((word) => held.has(word)).length / mine.length >= 0.7;
  });
}

// Word for word out of a document the person can read: that document already keeps it, and says it better. Short
// lines are not checked, because six ordinary words in a row turn up in any long document.
export function fromDoc(fact: string, docs: string[]): boolean {
  const mine = wordsOf(fact);
  if (mine.length < 6) return false;
  const phrase = ` ${mine.join(' ')} `;
  return docs.some((doc) => ` ${wordsOf(doc).join(' ')} `.includes(phrase));
}

// A figure only the person said: journey 9's "10 non-paying beta users" was 12 beta users less 2 paying, worked out by
// the person and kept as a fact. Every number in a kept line has to be one the founder said, a document the person
// reads holds, or a tool this turn brought back, as written.
const bare = (number: string) => number.replace(/,/g, '');
export function ownFigure(fact: string, sources: string[]): boolean {
  const known = new Set(sources.flatMap((source) => numbersOf(source).map(bare)));
  return numbersOf(fact).some((number) => !known.has(bare(number)));
}

export function createRetain(deps: {
  memory: Pick<Memory, 'read' | 'remember'>; store: Store; extract?: Extract;
  // The room's memory changed: the panel reads itself again.
  changed: (roomId: string) => void;
  log?: (line: string) => void; now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const turns = new Map<string, number>();
  const last = new Map<string, number>();
  let busy = false;
  let toldNone = false;

  // Every rule that costs nothing, in one place. Null means go ahead; anything else is why not.
  async function why(payload: Payloads['turn:after']): Promise<string | null> {
    if (payload.source !== 'chat') return 'not the founder';
    if (payload.reply.stopped) return 'stopped';
    if (payload.query.trim().length < ASKED_CHARS || payload.reply.text.trim().length < SAID_CHARS) return 'too short';
    const since = turns.get(payload.roomId);
    const at = last.get(payload.roomId);
    if (since !== undefined && since < EVERY_TURNS) return 'too soon';
    if (at !== undefined && now() - at < EVERY_MS) return 'too soon';
    if (!deps.extract) {
      if (!toldNone) { toldNone = true; log('retain · no model on this machine, so nothing is kept on its own'); }
      return 'no local model';
    }
    if (busy) return 'busy';
    const memory = await deps.memory.read(payload.roomId);
    if (memory.notes.length > NOTES_CHARS - ROOM_LEFT) return 'notes nearly full';
    return null;
  }

  // Reads one exchange and keeps what lasts. Gives back the lines it kept.
  async function retain(payload: Payloads['turn:after']): Promise<string[]> {
    const { roomId } = payload;
    // Only the founder's own turns count towards "three turns since": a run in between is not a conversation.
    if (payload.source === 'chat') turns.set(roomId, (turns.get(roomId) ?? EVERY_TURNS) + 1);
    if (await why(payload)) return [];
    turns.set(roomId, 0);
    last.set(roomId, now());
    busy = true;
    try {
      const stage = await deps.store.loadStage();
      const name = stage.rooms.find((room) => room.id === roomId)?.name || 'Someone';
      const raw = await deps.extract!([
        { role: 'system', content: retainPrompt(now()) },
        // The reply without what the truth net flagged in it: an invented figure or action is never shown as a fact.
        { role: 'user', content: `Founder: ${payload.query.trim().slice(0, 2000)}\n\n${name}: ${dropFlagged(payload.reply.text).slice(0, 3000)}` },
      ]);
      const facts = parseFacts(raw, [name, 'Founder']);
      if (!facts.length) return [];
      const docs = await Promise.all(readableDocIds(stage, roomId).map((id) => deps.store.readDoc(id).catch(() => '')));
      const founder = (await deps.store.readChat(roomId).catch(() => [] as ChatMessage[])).filter((message) => message.role === 'user').map((message) => message.text);
      const sources = [payload.query, ...founder, ...docs, ...payload.reply.tools.map((tool) => (tool.ok ? tool.result ?? '' : ''))];
      const kept: string[] = [];
      for (const fact of facts) {
        // Read again right before each line is written, not once before the model was asked: a remember from this
        // same turn, and the line kept just before, are in the notes by now.
        const notes = (await deps.memory.read(roomId)).notes;
        if (isKnown(fact, notes) || fromDoc(fact, docs) || ownFigure(fact, sources)) continue;
        // Through the same door as the remember tool, so its cap and its dedupe hold here too. Full is the end.
        try { if (await deps.memory.remember(roomId, `${KEPT_MARK} ${fact}`) === 'Remembered.') kept.push(fact); } catch { break; }
      }
      if (kept.length) {
        deps.changed(roomId);
        log(`retain · ${name} kept ${kept.length} ${kept.length === 1 ? 'line' : 'lines'} on its own: ${kept.join(' | ')}`);
      }
      return kept;
    } finally { busy = false; }
  }

  return {
    retain,
    // Passed on first: whatever else watches a finished turn should not wait behind the model on this machine.
    after: (async (payload, next) => {
      const passed = await next(payload);
      await retain(payload).catch((error: Error) => log(`retain · ${error.message}`));
      return passed;
    }) satisfies Handler<'turn:after'>,
  };
}

// The local model, asked plainly: no tools, no streaming to anyone. Only a client marked as this machine's is used.
// A step streams its words out through `onToken` and hands back no text of its own, so the words are gathered here.
// What it spent is written down as retain's, so the insights can tell it from a turn.
export const localExtract = (clients: ModelClient[], usage?: Pick<UsageBook, 'record'>): Extract | undefined => {
  const local = clients.find((client) => client.local);
  if (!local) return undefined;
  return async (messages) => {
    let said = '';
    const turn = await local.step(messages, { onToken: (token) => { said += token; } });
    usage?.record(local.name, turn.usage, turn.quota, 'retain');
    return turn.text || said;
  };
};

export default {
  name: 'retain',
  install(deps) {
    // Fake mode asks no model at all, so the browser checks never wait on one.
    const retain = createRetain({
      memory: deps.memory, store: deps.store, extract: deps.fake ? undefined : localExtract(deps.clients, deps.usage),
      changed: (roomId) => hub.say(MEMORY_CHANNEL, { id: roomId }),
      ...(deps.fake ? { log: () => {} } : {}),
    });
    const off = deps.seams.on('turn:after', retain.after);
    return { tools: reflectTools({ recall: deps.recall, decisions: deps.decisions, memory: deps.memory }), async close() { off(); } };
  },
} satisfies Slice;
