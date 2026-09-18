import { STANCE, type ChatMessage, type Stage } from '../shared/model.ts';

export type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string };

const MAX_TURNS = 24;

// A wire between a room and a doc, drawn in either direction, lets that person read the doc.
export function wiredDocIds(stage: Stage, roomId: string): string[] {
  const docIds = new Set(stage.docs.map((doc) => doc.id));
  const found = new Set<string>();
  for (const wire of stage.wires) {
    if (wire.from === roomId && docIds.has(wire.to)) found.add(wire.to);
    if (wire.to === roomId && docIds.has(wire.from)) found.add(wire.from);
  }
  return [...found];
}

export function buildMessages(stage: Stage, roomId: string, docs: Record<string, string>, history: ChatMessage[]): ModelMessage[] {
  const room = stage.rooms.find((candidate) => candidate.id === roomId);
  if (!room) throw new Error(`unknown room: ${roomId}`);

  const wired = wiredDocIds(stage, roomId).map((id) => {
    const title = stage.docs.find((doc) => doc.id === id)!.title;
    return `## Doc: ${title}\n${docs[id] ?? ''}`;
  });
  const system = [
    `You are ${room.name}, ${room.role}. ${room.brief}`,
    STANCE,
    'Reply in plain text. Short paragraphs or short numbered lists. No markdown tables, no headings.',
    wired.length
      ? `The founder has connected these documents to your room. Treat them as what the founder wants you to know.\n\n${wired.join('\n\n')}`
      : 'No documents are connected to your room, so you have no written background on the product yet.',
  ].join('\n\n');

  return [
    { role: 'system', content: system },
    ...history.slice(-MAX_TURNS).map((message) => ({ role: message.role, content: message.text })),
  ];
}
