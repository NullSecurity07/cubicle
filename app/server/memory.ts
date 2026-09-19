import type { ChatMessage } from '../shared/model.ts';
import type { ModelMessage } from './prompt.ts';
import type { Store } from './store.ts';

// What a person keeps beyond the recent conversation. `notes` are facts it was told to remember; `summary` is the older
// conversation folded down; `upTo` is the last message the summary covers. The founder can read and edit both texts.
export type Memory = { notes: string; summary: string; upTo?: string };
export type Summarise = (messages: ModelMessage[]) => Promise<string>;

export const HISTORY_CHARS = 6000;
const FOLD_AT = 6;
const NOTES_CHARS = 4000;
const SUMMARY_CHARS = 1500;
const size = (message: ChatMessage) => message.text.length + (message.tools ?? []).reduce((sum, tool) => sum + JSON.stringify(tool.args).length + Math.min(tool.result?.length ?? 0, 300), 0) + 20;

// The recent messages that fit the budget, newest first in priority, always at least the last two.
export function recent(history: ChatMessage[], budget = HISTORY_CHARS): ChatMessage[] {
  let used = 0;
  let start = history.length;
  while (start > 0 && (history.length - start < 2 || used + size(history[start - 1]) <= budget)) { start -= 1; used += size(history[start]); }
  return history.slice(start);
}

export function createMemory(store: Store, summarise: Summarise) {
  const folding = new Set<string>();
  return {
    read: (roomId: string) => store.readMemory(roomId),
    async write(roomId: string, next: { notes?: string; summary?: string }) {
      const memory = await store.readMemory(roomId);
      await store.writeMemory(roomId, { ...memory, ...(typeof next.notes === 'string' ? { notes: next.notes.slice(0, NOTES_CHARS) } : {}), ...(typeof next.summary === 'string' ? { summary: next.summary.slice(0, SUMMARY_CHARS * 2) } : {}) });
    },
    async remember(roomId: string, fact: string) {
      const memory = await store.readMemory(roomId);
      const line = `- ${fact.replace(/\s+/g, ' ').trim().slice(0, 300)}`;
      if (memory.notes.split('\n').includes(line)) return 'Already remembered.';
      const notes = `${memory.notes.trim()}${memory.notes.trim() ? '\n' : ''}${line}`;
      if (notes.length > NOTES_CHARS) throw new Error('your notes are full. Tell the founder; they can trim them in your memory panel.');
      await store.writeMemory(roomId, { ...memory, notes });
      return 'Remembered.';
    },
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
        const talk = fresh.map((message) => `${message.role === 'assistant' ? 'You' : message.from ?? 'Founder'}: ${message.text.replace(/\s+/g, ' ').slice(0, 1200)}${message.tools?.length ? ` [did: ${message.tools.map((tool) => tool.name).join(', ')}]` : ''}`).join('\n');
        const summary = (await summarise([
          { role: 'system', content: `You keep the long-term memory of one person who works for a founder. Rewrite the memory so it also covers the new conversation. Keep decisions, facts about the company, product, customers and numbers, the founder's preferences, and work done or promised. Drop small talk. Plain short lines, at most ${SUMMARY_CHARS} characters, no preamble.` },
          { role: 'user', content: `Memory so far:\n${memory.summary || '(empty)'}\n\nNew conversation to fold in:\n${talk}` },
        ])).trim().slice(0, SUMMARY_CHARS * 2);
        if (!summary) return false;
        const latest = await store.readMemory(roomId);
        await store.writeMemory(roomId, { ...latest, summary, upTo: fresh.at(-1)!.id });
        return true;
      } finally { folding.delete(roomId); }
    },
  };
}
