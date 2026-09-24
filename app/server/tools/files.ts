import { text, type Tool } from './registry.ts';

const path = { type: 'string', description: 'Path inside the shared files folder, for example "research/competitors.md"' };

// Plain files every person shares, under workspace/files. The store keeps paths inside that folder.
export const fileTools: Tool[] = [
  {
    name: 'list_files',
    description: 'List the files in the shared files folder. That folder is separate from the documents on the stage: documents never appear here.',
    parameters: { type: 'object', properties: {} },
    async run(_args, context) {
      const files = await context.store.listFiles();
      return { text: files.length ? files.join('\n') : 'The folder is empty.' };
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the shared files folder. Not for documents on the stage: a connected document is already in your context.',
    parameters: { type: 'object', properties: { path, from: { type: 'number', description: 'Where to start, in characters, for a file longer than 20000' } }, required: ['path'] },
    async run(args, context) {
      const body = await context.store.readFile(text(args, 'path', 200));
      if (body === null) throw new Error('no such file');
      // A long file is read a window at a time: each cut says where the next window starts.
      const from = Math.max(0, Math.min(body.length, Math.floor(Number(args.from) || 0)));
      const part = body.slice(from, from + 20_000);
      const end = from + part.length;
      return { text: end < body.length ? `${part}\n… (cut at ${end} of ${body.length} characters; read on with "from": ${end})` : from ? `${part}\n(the end of the file)` : part };
    },
  },
  {
    name: 'write_file',
    description: 'Write a text file in the shared files folder. An older version is kept in the trash.',
    parameters: { type: 'object', properties: { path, text: { type: 'string' } }, required: ['path', 'text'] },
    async run(args, context) {
      const body = text(args, 'text');
      await context.store.writeFile(text(args, 'path', 200), body);
      return { text: `Wrote ${body.length} characters.` };
    },
  },
];
