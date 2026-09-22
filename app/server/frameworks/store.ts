import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Framework } from '../../shared/frameworks.ts';
import { FRAMEWORK_ID } from '../../shared/frameworks.ts';
import { idOf, type Library } from '../library/notes.ts';

export type Frameworks = ReturnType<typeof createFrameworks>;

const safe = (id: string) => { if (!FRAMEWORK_ID.test(id)) throw new Error(`bad id: ${id}`); return id; };
// A framework is a file the founder may open, read and edit: a whole folder of its own, because the evals round puts
// this framework's runs beside it and nothing else's.
export function createFrameworks(workspace: string) {
  const folder = join(workspace, 'frameworks');
  const path = (id: string) => join(folder, safe(id), 'framework.json');

  const readOne = async (id: string): Promise<Framework | null> => {
    const text = await readFile(path(id), 'utf8').catch(() => null);
    if (text === null) return null;
    const held = JSON.parse(text) as Framework;
    // The id is the folder's name, whatever the file says: a folder the founder renamed by hand still reads.
    return { ...held, id, rooms: held.rooms ?? [], docs: held.docs ?? [], cards: held.cards ?? [], wires: held.wires ?? [], layout: held.layout ?? {}, dataset: held.dataset ?? [], notes: held.notes ?? [] };
  };

  async function list(): Promise<Framework[]> {
    const found = await readdir(folder, { withFileTypes: true }).catch(() => []);
    const held: Framework[] = [];
    for (const one of found) {
      if (!one.isDirectory() || !FRAMEWORK_ID.test(one.name)) continue;
      // A file somebody broke by hand loses that one framework, never the list: the panel still opens.
      const framework = await readOne(one.name).catch(() => null);
      if (framework?.name) held.push(framework);
    }
    return held.sort((one, other) => (other.builtAt ?? 0) - (one.builtAt ?? 0));
  }

  return {
    folder,
    list,
    read: readOne,
    // Exactly what it was handed. Whoever saves decides the version and the day, because only they know whether this
    // is a new team or the same one written again.
    async save(framework: Framework): Promise<Framework> {
      const file = path(framework.id);
      await mkdir(join(folder, framework.id), { recursive: true });
      await writeFile(`${file}.tmp`, `${JSON.stringify(framework, null, 2)}\n`);
      await rename(`${file}.tmp`, file);
      return framework;
    },
    remove: async (id: string): Promise<void> => { await rm(join(folder, safe(id)), { recursive: true, force: true }); },
    // Which framework holds each note, by note id. The library asks this before it lets a note be deleted, and the
    // panel asks it to say which notes a framework still needs.
    async holders(): Promise<Map<string, string>> {
      const by = new Map<string, string>();
      for (const framework of await list()) for (const note of framework.notes) if (!by.has(note.id)) by.set(note.id, framework.name);
      return by;
    },
  };
}

// A note file's own title: the heading it opens with, or failing that its file name said as a title. It has to be the
// title, and not something invented here, because the library's id is the slug of the title and the framework's
// `notes` entry names that id.
export const titleOfNote = (file: string, text: string): string =>
  /^#[ \t]+(.+?)[ \t]*$/m.exec(text)?.[1]?.replace(/\s+/g, ' ').trim()
  || file.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ').trim()
  || 'Note';

// The frameworks that ship with the app, copied into the workspace the first time it starts without them, together
// with the notes they were built from. A framework the founder already has is left exactly as they left it — their
// edits, their test cases — which is why this only ever writes what is absent. Gives back what it copied.
export async function copyBuiltIns(from: string, frameworks: Frameworks, library: Library): Promise<string[]> {
  const found = await readdir(from, { withFileTypes: true }).catch(() => []);
  const copied: string[] = [];
  for (const one of found) {
    if (!one.isDirectory() || !FRAMEWORK_ID.test(one.name)) continue;
    const text = await readFile(join(from, one.name, 'framework.json'), 'utf8').catch(() => null);
    if (text === null || (await frameworks.read(one.name).catch(() => null))) continue;
    const framework = JSON.parse(text) as Framework;
    // The notes first: a framework whose note is not in the library places, but its people would read nothing.
    const notes = await readdir(join(from, one.name, 'notes')).catch(() => []);
    const held = new Set((await library.list()).map((note) => note.id));
    for (const file of notes.filter((name) => /\.(md|markdown|txt)$/i.test(name))) {
      const words = await readFile(join(from, one.name, 'notes', file), 'utf8');
      const title = titleOfNote(file, words);
      // A note the founder already keeps under that title is theirs: their words stay, and the framework works from
      // whatever they have. Re-adding it would quietly overwrite what they wrote.
      const note = { title, text: words, source: 'file' as const };
      if (!held.has(idOf(title))) await library.add(note);
    }
    await frameworks.save({ ...framework, id: one.name });
    copied.push(one.name);
  }
  return copied;
}
