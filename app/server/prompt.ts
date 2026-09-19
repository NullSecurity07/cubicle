import { STANCE, type ChatMessage, type Stage } from '../shared/model.ts';
import { recent, type Memory } from './memory.ts';

type CallEcho = { id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: unknown };
// An image travels as its own part; only models that can see get it, the rest get a line saying an image was attached.
export type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: { name: string; url: string }[] }
  | { role: 'assistant'; content: string; tool_calls?: CallEcho[] }
  | { role: 'tool'; tool_call_id: string; content: string };

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
// What a person reads each turn: the docs wired to it, plus every pinned doc.
export const readableDocIds = (stage: Stage, roomId: string) => [...new Set([...stage.docs.filter((doc) => doc.pinned).map((doc) => doc.id), ...wiredDocIds(stage, roomId)])];
export const colleagueIds = (stage: Stage, roomId: string) => wired(stage, roomId, stage.rooms.filter((room) => room.id !== roomId && room.name).map((room) => room.id));
const EXCERPT = 280;

// An earlier reply that used tools goes back to the model the way it happened: the calls, short results, then the words.
// What the founder attached, as the model gets it: text files inline, images as images.
export type Attached = { texts: Record<string, string>; images: Record<string, string> };
const ATTACHED_CHARS = 8000;

function past(message: ChatMessage, attached: Attached): ModelMessage[] {
  if (message.role === 'user') {
    const files = (message.attachments ?? []).map((file) => {
      const text = attached.texts[file.path];
      if (text !== undefined) return `\n\n[Attached file ${file.path}]\n${text.length > ATTACHED_CHARS ? `${text.slice(0, ATTACHED_CHARS)}\n… (cut; the full file is in the shared files folder)` : text}`;
      return attached.images[file.path] ? '' : `\n\n[Attached file ${file.path} (${file.type || 'unknown type'}, ${file.size} bytes) is in the shared files folder.]`;
    }).join('');
    const images = (message.attachments ?? []).filter((file) => attached.images[file.path]).map((file) => ({ name: file.path, url: attached.images[file.path] }));
    const words = message.from ? `[${message.from}, a colleague, asks you. The founder will see your answer.]\n${message.text}` : message.text;
    return [{ role: 'user', content: `${words}${files}`, ...(images.length ? { images } : {}) }];
  }
  const tools = (message.tools ?? []).filter((tool) => tool.ok !== undefined);
  if (!tools.length) return [{ role: 'assistant', content: message.text }];
  return [
    { role: 'assistant', content: '', tool_calls: tools.map((tool) => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) },
    ...tools.map((tool): ModelMessage => ({ role: 'tool', tool_call_id: tool.id, content: (tool.result ?? '').slice(0, PAST_RESULT_CHARS) })),
    ...(message.text.trim() ? [{ role: 'assistant' as const, content: message.text }] : []),
  ];
}

export function buildMessages(stage: Stage, roomId: string, docs: Record<string, string>, history: ChatMessage[], toolNames: string[] = [], colleagues: Record<string, ChatMessage[]> = {}, memory?: Memory, attached: Attached = { texts: {}, images: {} }): ModelMessage[] {
  const room = stage.rooms.find((candidate) => candidate.id === roomId);
  if (!room) throw new Error(`unknown room: ${roomId}`);

  const block = (id: string) => `## Doc: ${stage.docs.find((doc) => doc.id === id)!.title}\n${docs[id] ?? ''}`;
  const mine = wiredDocIds(stage, roomId);
  const docsWired = mine.map(block);
  const pinned = stage.docs.filter((doc) => doc.pinned && !mine.includes(doc.id)).map((doc) => block(doc.id));
  // Wired colleagues: who they are and the last things said in their room, so a consult starts from common ground.
  const team = colleagueIds(stage, roomId).map((id) => {
    const other = stage.rooms.find((candidate) => candidate.id === id)!;
    const recent = (colleagues[id] ?? []).filter((message) => message.text.trim()).slice(-4)
      .map((message) => `  ${message.role === 'assistant' ? other.name : message.from ?? 'Founder'}: ${message.text.replace(/\s+/g, ' ').slice(0, EXCERPT)}`);
    return `- ${other.name}, ${other.role}. ${other.brief}${recent.length ? `\n  Lately in ${other.name}'s room:\n${recent.join('\n')}` : ''}`;
  });
  // A person only uses what it knows it has: say which cards are wired to the room, and what each is for.
  const cards = stage.cards ?? [];
  const reach = wired(stage, roomId, cards.map((card) => card.id)).map((id) => cards.find((card) => card.id === id)!).map((card) => (card.kind === 'project'
    ? `- A project folder${card.path ? ` (${card.path})` : ''}. Any change to that code goes through delegate_coding, which works inside the folder. Documents and shared files are not the project: never write project code into them, and never say the project changed unless delegate_coding reported it.`
    : card.kind === 'board' ? '- The task board. Read it with list_tasks. When you notice follow-up work, suggest it with propose_task; the founder decides what gets done.'
    : '- A browser card the founder watches live. Use browse for anything that needs clicking, typing or being signed in.'));
  const system = [
    `You are ${room.name}, ${room.role}. ${room.brief}`,
    STANCE,
    'Reply in short markdown: brief paragraphs, lists where they help, a table only for real comparisons.',
    toolNames.length
      ? `You can act with these tools: ${toolNames.join(', ')}. Use one when the founder asks for the work itself, not for advice about it. `
        + `You may change only the documents connected to your room${mine.length ? ` (${mine.map((id) => `"${stage.docs.find((doc) => doc.id === id)!.title}"`).join(', ')})` : ''}, with write_doc or append_doc, naming the document by its title. `
        + 'Their text is already below: never look for a document with read_file or list_files, which only see the separate shared files folder. '
        + 'For anything on the web, search and read with all your queries or addresses in one call. Say where a fact came from. '
        + 'The founder sees a receipt for every tool call, and work without a receipt did not happen: never write that you saved, created or changed '
        + 'something unless that tool call ran in this turn and succeeded. When a request has several parts, make every tool call first, '
        + 'then say in one or two lines what changed.'
      : '',
    reach.length ? `Also connected to your room:\n${reach.join('\n')}` : '',
    memory && (memory.notes.trim() || memory.summary.trim())
      ? `Your memory (the founder can read and edit it).${memory.notes.trim() ? `\nNotes you kept:\n${memory.notes.trim()}` : ''}${memory.summary.trim() ? `\nEarlier conversation, in short:\n${memory.summary.trim()}` : ''}`
      : '',
    team.length ? `Colleagues connected to your room. Ask one with ask_person when their field decides the answer; say in your reply what they told you.\n${team.join('\n')}` : '',
    pinned.length ? `Company documents every person reads:\n\n${pinned.join('\n\n')}` : '',
    docsWired.length
      ? `The founder has connected these documents to your room. Treat them as what the founder wants you to know.\n\n${docsWired.join('\n\n')}`
      : pinned.length ? '' : 'No documents are connected to your room, so you have no written background on the product yet.',
  ].filter(Boolean).join('\n\n');

  return [{ role: 'system', content: system }, ...recent(history).flatMap((message) => past(message, attached))];
}
