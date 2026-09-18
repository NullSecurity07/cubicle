import { STANCE, type ChatMessage, type Stage } from '../shared/model.ts';

type CallEcho = { id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: unknown };
export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: CallEcho[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const MAX_TURNS = 24;
const PAST_RESULT_CHARS = 300;

// A wire between a room and a doc, drawn in either direction, lets that person read and write the doc.
export function wiredDocIds(stage: Stage, roomId: string): string[] {
  const docIds = new Set(stage.docs.map((doc) => doc.id));
  const found = new Set<string>();
  for (const wire of stage.wires) {
    if (wire.from === roomId && docIds.has(wire.to)) found.add(wire.to);
    if (wire.to === roomId && docIds.has(wire.from)) found.add(wire.from);
  }
  return [...found];
}

// An earlier reply that used tools goes back to the model the way it happened: the calls, short results, then the words.
function past(message: ChatMessage): ModelMessage[] {
  if (message.role === 'user') return [{ role: 'user', content: message.text }];
  const tools = (message.tools ?? []).filter((tool) => tool.ok !== undefined);
  if (!tools.length) return [{ role: 'assistant', content: message.text }];
  return [
    { role: 'assistant', content: '', tool_calls: tools.map((tool) => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) },
    ...tools.map((tool): ModelMessage => ({ role: 'tool', tool_call_id: tool.id, content: (tool.result ?? '').slice(0, PAST_RESULT_CHARS) })),
    ...(message.text.trim() ? [{ role: 'assistant' as const, content: message.text }] : []),
  ];
}

export function buildMessages(stage: Stage, roomId: string, docs: Record<string, string>, history: ChatMessage[], toolNames: string[] = []): ModelMessage[] {
  const room = stage.rooms.find((candidate) => candidate.id === roomId);
  if (!room) throw new Error(`unknown room: ${roomId}`);

  const wired = wiredDocIds(stage, roomId).map((id) => {
    const title = stage.docs.find((doc) => doc.id === id)!.title;
    return `## Doc: ${title}\n${docs[id] ?? ''}`;
  });
  const system = [
    `You are ${room.name}, ${room.role}. ${room.brief}`,
    STANCE,
    'Reply in short markdown: brief paragraphs, lists where they help, a table only for real comparisons.',
    toolNames.length
      ? `You can act with these tools: ${toolNames.join(', ')}. Use one when the founder asks for the work itself, not for advice about it. `
        + 'You may change only the documents connected to your room; name a document by its title. After a tool runs, say in one or two lines what changed.'
      : '',
    wired.length
      ? `The founder has connected these documents to your room. Treat them as what the founder wants you to know.\n\n${wired.join('\n\n')}`
      : 'No documents are connected to your room, so you have no written background on the product yet.',
  ].filter(Boolean).join('\n\n');

  return [{ role: 'system', content: system }, ...history.slice(-MAX_TURNS).flatMap(past)];
}
