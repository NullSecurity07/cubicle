import { STANCE, type ChatMessage, type Stage } from '../shared/model.ts';

type CallEcho = { id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: unknown };
export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: CallEcho[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const MAX_TURNS = 24;
const PAST_RESULT_CHARS = 300;

// A wire grants access, whichever way it was drawn: of the given cards, the ones wired to this room.
export function wired(stage: Stage, roomId: string, ids: string[]): string[] {
  const wanted = new Set(ids);
  const found = new Set<string>();
  for (const wire of stage.wires) {
    if (wire.from === roomId && wanted.has(wire.to)) found.add(wire.to);
    if (wire.to === roomId && wanted.has(wire.from)) found.add(wire.from);
  }
  return [...found];
}

// A wire between a room and a doc lets that person read and write the doc.
export const wiredDocIds = (stage: Stage, roomId: string) => wired(stage, roomId, stage.docs.map((doc) => doc.id));

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

  const docsWired = wiredDocIds(stage, roomId).map((id) => {
    const title = stage.docs.find((doc) => doc.id === id)!.title;
    return `## Doc: ${title}\n${docs[id] ?? ''}`;
  });
  // A person only uses what it knows it has: say which cards are wired to the room, and what each is for.
  const cards = stage.cards ?? [];
  const reach = wired(stage, roomId, cards.map((card) => card.id)).map((id) => cards.find((card) => card.id === id)!).map((card) => (card.kind === 'project'
    ? `- A project folder${card.path ? ` (${card.path})` : ''}. Any change to that code goes through delegate_coding, which works inside the folder. Documents and shared files are not the project: never write project code into them, and never say the project changed unless delegate_coding reported it.`
    : '- A browser card the founder watches live. Use browse for anything that needs clicking, typing or being signed in.'));
  const system = [
    `You are ${room.name}, ${room.role}. ${room.brief}`,
    STANCE,
    'Reply in short markdown: brief paragraphs, lists where they help, a table only for real comparisons.',
    toolNames.length
      ? `You can act with these tools: ${toolNames.join(', ')}. Use one when the founder asks for the work itself, not for advice about it. `
        + 'You may change only the documents connected to your room; name a document by its title. '
        + 'For anything on the web, search and read with all your queries or addresses in one call. Say where a fact came from. '
        + 'The founder sees a receipt for every tool call, and work without a receipt did not happen: never write that you saved, created or changed '
        + 'something unless that tool call ran in this turn and succeeded. When a request has several parts, make every tool call first, '
        + 'then say in one or two lines what changed.'
      : '',
    reach.length ? `Also connected to your room:\n${reach.join('\n')}` : '',
    docsWired.length
      ? `The founder has connected these documents to your room. Treat them as what the founder wants you to know.\n\n${docsWired.join('\n\n')}`
      : 'No documents are connected to your room, so you have no written background on the product yet.',
  ].filter(Boolean).join('\n\n');

  return [{ role: 'system', content: system }, ...history.slice(-MAX_TURNS).flatMap(past)];
}
