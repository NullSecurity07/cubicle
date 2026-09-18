import { text, type Tool } from './registry.ts';

const path = { type: 'string', description: 'Path inside the shared files folder, for example "research/competitors.md"' };

// Plain files every person shares, under workspace/files. The store keeps paths inside that folder.
export const fileTools: Tool[] = [
  {
    name: 'list_files',
    description: 'List the files in the shared files folder.',
    parameters: { type: 'object', properties: {} },
    async run(_args, context) {
      const files = await context.store.listFiles();
      return { text: files.length ? files.join('\n') : 'The folder is empty.' };
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the shared files folder.',
    parameters: { type: 'object', properties: { path }, required: ['path'] },
    async run(args, context) {
      const body = await context.store.readFile(text(args, 'path', 200));
      if (body === null) throw new Error('no such file');
      return { text: body.length > 20_000 ? `${body.slice(0, 20_000)}\n… (cut at 20000 of ${body.length} characters)` : body };
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
