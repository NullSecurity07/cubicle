import type { Box, Stage } from '../../shared/model.ts';
import { wiredDocIds } from '../prompt.ts';
import { text, type Tool, type ToolContext } from './registry.ts';

// A new doc card's size, and the gap kept round it: the same the window uses when it places one.
const [WIDTH, HEIGHT, GAP] = [340, 300, 40];

// Where a doc made by a person lands: beside them, in the nearest place nothing else is standing.
function besideRoom(stage: Stage, room: Box): { x: number; y: number } {
  const boxes: Box[] = [...stage.rooms, ...stage.docs, ...(stage.cards ?? [])];
  const hits = (x: number, y: number) => boxes.some((one) => x < one.x + one.w + GAP && x + WIDTH + GAP > one.x && y < one.y + one.h + GAP && y + HEIGHT + GAP > one.y);
  const start = { x: room.x + (room.w || 380) + 80, y: room.y };
  for (let ring = 0; ring <= 6; ring += 1) {
    for (let row = -ring; row <= ring; row += 1) {
      for (let column = -ring; column <= ring; column += 1) {
        if (Math.max(Math.abs(row), Math.abs(column)) !== ring) continue;
        const [x, y] = [start.x + column * (WIDTH + GAP), start.y + row * (HEIGHT + GAP)];
        if (!hits(x, y)) return { x, y };
      }
    }
  }
  return start;
}

// The doc's card and its wire to the person who made it, put on the stage here rather than by whichever window
// happens to be open: a doc made from the phone, in a board run or by a colleague asked to do it has no window
// watching, and without this it had no card, no wire, and nobody could reach it again. The wire has the name the
// window gives it too, so a window that does hear of it adds nothing twice.
const docOnStage = (roomId: string, id: string, title: string) => (stage: Stage) => {
  const room = stage.rooms.find((one) => one.id === roomId);
  if (!room || stage.docs.some((one) => one.id === id)) return;
  stage.docs.push({ id, title, ...besideRoom(stage, room), w: WIDTH, h: HEIGHT });
  stage.wires.push({ id: `${roomId}-${id}`, from: roomId, fromHandle: 'r', to: id, toHandle: 'l' });
};

// Docs this person may touch, by title: the wired ones plus any made during this turn.
function reachable(context: ToolContext) {
  const docs = new Map<string, string>();
  for (const id of wiredDocIds(context.stage, context.roomId)) docs.set(id, context.stage.docs.find((doc) => doc.id === id)!.title);
  for (const [id, title] of context.granted) docs.set(id, title);
  return docs;
}

function find(context: ToolContext, wanted: string) {
  const docs = reachable(context);
  const key = wanted.trim().toLowerCase();
  const hits = [...docs].filter(([id, title]) => id === key || title.trim().toLowerCase() === key);
  if (hits.length === 1) return hits[0][0];
  const titles = [...docs.values()].map((title) => `"${title}"`).join(', ') || 'none';
  throw new Error(hits.length ? `more than one connected document is called "${wanted}"` : `no connected document is called "${wanted}". Connected: ${titles}. Ask the founder to draw a wire to it.`);
}

const doc = { type: 'string', description: 'Title of a document connected to your room' };

export const docTools: Tool[] = [
  {
    name: 'read_doc',
    description: 'Read the current text of a connected document. Its text is already in your context; use this only to check it again after a change.',
    parameters: { type: 'object', properties: { doc }, required: ['doc'] },
    run: async (args, context) => ({ text: (await context.store.readDoc(find(context, text(args, 'doc')))) || '(empty)' }),
  },
  {
    name: 'write_doc',
    description: 'Replace the whole text of a connected document. The old version is kept in the trash.',
    parameters: { type: 'object', properties: { doc, text: { type: 'string', description: 'The full new markdown text' } }, required: ['doc', 'text'] },
    async run(args, context) {
      const id = find(context, text(args, 'doc'));
      const body = text(args, 'text');
      await context.store.replaceDoc(id, body);
      return { text: `Wrote ${body.length} characters.`, effect: { kind: 'doc-changed', id } };
    },
  },
  {
    name: 'append_doc',
    description: 'Add text to the end of a connected document.',
    parameters: { type: 'object', properties: { doc, text: { type: 'string', description: 'Markdown to add at the end' } }, required: ['doc', 'text'] },
    async run(args, context) {
      const id = find(context, text(args, 'doc'));
      const before = await context.store.readDoc(id);
      const added = text(args, 'text');
      await context.store.replaceDoc(id, `${before.replace(/\s+$/, '')}${before.trim() ? '\n\n' : ''}${added}\n`);
      return { text: `Added ${added.length} characters.`, effect: { kind: 'doc-changed', id } };
    },
  },
  {
    name: 'create_doc',
    description: 'Create a new document card next to your room, already connected to you.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string', description: 'The markdown text' } }, required: ['title', 'text'] },
    async run(args, context) {
      const title = text(args, 'title', 80).trim();
      const id = `doc-${Math.random().toString(36).slice(2, 8)}`;
      await context.store.writeDoc(id, text(args, 'text'));
      context.granted.set(id, title);
      // A stage that cannot be saved just now still leaves a doc the person can write to this turn.
      await Promise.resolve().then(() => context.store.patchStage(docOnStage(context.roomId, id, title))).catch(() => {});
      return { text: `Created "${title}".`, effect: { kind: 'doc-created', id, title } };
    },
  },
];
