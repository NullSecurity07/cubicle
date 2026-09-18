import { wiredDocIds } from '../prompt.ts';
import { text, type Tool, type ToolContext } from './registry.ts';

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
      return { text: `Created "${title}".`, effect: { kind: 'doc-created', id, title } };
    },
  },
];
