import type { ChatMessage } from '../shared/model.ts';
import { fullDay, shortDay } from './clock.ts';
import type { ModelMessage } from './prompt.ts';
import type { Store } from './store.ts';

// What a person keeps beyond the recent conversation. `notes` are facts it was told to remember; `summary` is the older
// conversation folded down; `upTo` is the last message the summary covers. The founder can read and edit both texts.
export type Memory = { notes: string; summary: string; upTo?: string };
export type Summarise = (messages: ModelMessage[]) => Promise<string>;

export const HISTORY_CHARS = 6000;
const FOLD_AT = 6;
export const NOTES_CHARS = 4000;
const SUMMARY_CHARS = 1500;
const size = (message: ChatMessage) => message.text.length + (message.tools ?? []).reduce((sum, tool) => sum + JSON.stringify(tool.args).length + Math.min(tool.result?.length ?? 0, 300), 0) + 20;

// The recent messages that fit the budget, newest first in priority, always at least the last two.
export function recent(history: ChatMessage[], budget = HISTORY_CHARS): ChatMessage[] {
  let used = 0;
  let start = history.length;
  while (start > 0 && (history.length - start < 2 || used + size(history[start - 1]) <= budget)) { start -= 1; used += size(history[start]); }
  return history.slice(start);
}

export function createMemory(store: Store, summarise: Summarise, now: () => number = Date.now) {
  const folding = new Set<string>();
  return {
    read: (roomId: string) => store.readMemory(roomId),
    // Every change here is read, made and written in one go, so a note kept while another is kept is not lost.
    async write(roomId: string, next: { notes?: string; summary?: string }) {
      await store.editMemory(roomId, (memory) => ({ out: undefined, memory: { ...memory, ...(typeof next.notes === 'string' ? { notes: next.notes.slice(0, NOTES_CHARS) } : {}), ...(typeof next.summary === 'string' ? { summary: next.summary.slice(0, SUMMARY_CHARS * 2) } : {}) } }));
    },
    remember: (roomId: string, fact: string) => store.editMemory(roomId, (memory) => {
      // A note read back months later needs the day it was kept, or "the price is 19" has no shelf life. The same fact
      // is still only kept once, matched on the words rather than the whole line, so notes written before this still count.
      const body = fact.replace(/\s+/g, ' ').trim().slice(0, 300);
      if (memory.notes.split('\n').some((one) => one.trimEnd().endsWith(body))) return { memory, out: 'Already remembered.' };
      const line = `- ${shortDay(now())} · ${body}`;
      const notes = `${memory.notes.trim()}${memory.notes.trim() ? '\n' : ''}${line}`;
      if (notes.length > NOTES_CHARS) throw new Error('your notes are full. Tell the founder; they can trim them in your memory panel.');
      return { memory: { ...memory, notes }, out: 'Remembered.' };
    }),
    // Folds messages that have slid out of the recent window into the summary, once enough of them have piled up.
    async fold(roomId: string): Promise<boolean> {
      if (folding.has(roomId)) return false;
      folding.add(roomId);
      try {
        const history = await store.readChat(roomId);
        const memory = await store.readMemory(roomId);
        const kept = recent(history);
        const old = history.slice(0, history.length - kept.length);
        const from = memory.upTo ? old.findIndex((message) => message.id === memory.upTo) + 1 : 0;
        const fresh = old.slice(from);
        if (fresh.length < FOLD_AT) return false;
        // Each line says the day it was said, so what the fold writes down keeps its place in time: without it a price
        // agreed in spring and one agreed yesterday both come back sounding like the price.
        const talk = fresh.map((message) => `[${shortDay(message.at)}] ${message.role === 'assistant' ? 'You' : message.from ?? 'Founder'}: ${message.text.replace(/\s+/g, ' ').slice(0, 1200)}${message.tools?.length ? ` [did: ${message.tools.map((tool) => tool.name).join(', ')}]` : ''}`).join('\n');
        const summary = (await summarise([
          { role: 'system', content: `You keep the long-term memory of one person who works for a founder. Today is ${fullDay(now())}. Rewrite the memory so it also covers the new conversation. Keep decisions, facts about the company, product, customers and numbers, the founder's preferences, and work done or promised. `
            + 'Every line of the new conversation is stamped with the day it was said. Anything tied to a time keeps its date, in the line itself: "decided on 12 Sep to…", "the price was 19 as of 3 Aug". '
            + `Never turn a dated fact into a timeless one. Drop small talk. Plain short lines, at most ${SUMMARY_CHARS} characters, no preamble.` },
          { role: 'user', content: `Memory so far:\n${memory.summary || '(empty)'}\n\nNew conversation to fold in:\n${talk}` },
        ])).trim().slice(0, SUMMARY_CHARS * 2);
        if (!summary) return false;
        await store.editMemory(roomId, (latest) => ({ out: undefined, memory: { ...latest, summary, upTo: fresh.at(-1)!.id } }));
        return true;
      } finally { folding.delete(roomId); }
    },
  };
}
