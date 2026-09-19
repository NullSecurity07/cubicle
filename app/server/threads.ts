import type { ChatMessage, Stage, Thread } from '../shared/model.ts';

const short = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 140);

// Every conversation on the stage as one list: each person's room, and each pair of people where one consulted the
// other. A consult lives in the answering person's room as a question carrying the asker's name and the reply after it.
export function threadsOf(stage: Stage, chats: Record<string, ChatMessage[]>, busy: Set<string>, query = ''): Thread[] {
  const threads: Thread[] = [];
  for (const room of stage.rooms) {
    const chat = chats[room.id] ?? [];
    const last = chat.at(-1);
    threads.push({
      id: room.id, kind: 'room', title: room.name || 'New person', accents: [room.accent], count: chat.length, ...(busy.has(room.id) ? { live: true } : {}),
      ...(last ? { last: { text: short(last.text), at: last.at, by: last.role === 'assistant' ? room.name : last.from ?? 'You' } } : {}),
    });
    const pairs = new Map<string, ChatMessage[]>();
    chat.forEach((message, index) => {
      if (message.role !== 'user' || !message.from) return;
      const answer = chat[index + 1]?.role === 'assistant' ? [chat[index + 1]] : [];
      pairs.set(message.from, [...(pairs.get(message.from) ?? []), message, ...answer]);
    });
    for (const [asker, messages] of pairs) {
      const from = stage.rooms.find((other) => other.name === asker);
      const end = messages.at(-1)!;
      threads.push({
        id: `${from?.id ?? asker}~${room.id}`, kind: 'consult', title: `${asker} ↔ ${room.name}`, accents: [from?.accent ?? '#5d6472', room.accent], count: messages.length, messages,
        last: { text: short(end.text), at: end.at, by: end.role === 'assistant' ? room.name : asker },
      });
    }
  }
  const wanted = query.trim().toLowerCase();
  const kept = !wanted ? threads : threads.flatMap((thread) => {
    const said = (thread.messages ?? chats[thread.id] ?? []).find((message) => message.text.toLowerCase().includes(wanted));
    if (said) return [{ ...thread, hit: short(said.text) }];
    return thread.title.toLowerCase().includes(wanted) ? [thread] : [];
  });
  return kept.sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
}
