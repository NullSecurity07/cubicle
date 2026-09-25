import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Framework } from '../../shared/frameworks.ts';
import { FRAMEWORK_ID } from '../../shared/frameworks.ts';
import { idOf, type Library } from '../library/notes.ts';
import { trashStamp } from '../clock.ts';
import { contentHash, readLedger } from './shipped.ts';

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
    async save(given: Framework): Promise<Framework> {
      // `update` is something the list says about a team, never part of it.
      const { update: _said, ...framework } = given;
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

// The notes a built-in team was built from, added to the library when they are absent. A note the founder already
// keeps under that title is theirs: their words stay, and the framework works from whatever they have. Re-adding it
// would quietly overwrite what they wrote.
async function copyNotes(dir: string, library: Library): Promise<void> {
  const notes = await readdir(join(dir, 'notes')).catch(() => []);
  const held = new Set((await library.list()).map((note) => note.id));
  for (const file of notes.filter((name) => /\.(md|markdown|txt)$/i.test(name))) {
    const words = await readFile(join(dir, 'notes', file), 'utf8');
    const title = titleOfNote(file, words);
    if (!held.has(idOf(title))) await library.add({ title, text: words, source: 'file' as const });
  }
}

// The workspace's own copy exactly as it sits in the file, bookkeeping and all: what is hashed has to be what was
// written, not what reading fills in.
const rawOf = async (frameworks: Frameworks, id: string): Promise<Record<string, unknown> | null> =>
  JSON.parse(await readFile(join(frameworks.folder, id, 'framework.json'), 'utf8').catch(() => 'null')) as Record<string, unknown> | null;
const builtIn = async (from: string, id: string): Promise<Framework | null> =>
  JSON.parse(await readFile(join(from, id, 'framework.json'), 'utf8').catch(() => 'null')) as Framework | null;

// A copy going away still goes somewhere: the workspace's trash, beside everything else the founder let go of.
async function trash(frameworks: Frameworks, id: string): Promise<void> {
  const trashDir = join(frameworks.folder, '..', 'trash');
  await mkdir(trashDir, { recursive: true });
  await copyFile(join(frameworks.folder, id, 'framework.json'), join(trashDir, `${trashStamp()}-framework-${id}.json`));
}

// Today's built-in team written over the workspace's copy, with the version it is recorded. The evals runs beside it
// stay: they are what happened, and the next rerun scores the new briefs.
async function install(from: string, id: string, framework: Framework, frameworks: Frameworks, library: Library): Promise<void> {
  await copyNotes(join(from, id), library);
  await frameworks.save({ ...framework, id, shippedHash: contentHash(framework as unknown as Record<string, unknown>) });
}

// The frameworks that ship with the app, copied into the workspace the first time it starts without them, together
// with the notes they were built from — and brought up to date on every start after that, when a built-in team has
// changed since. A copy whose content is still one the app once shipped is a copy nobody touched, so it is replaced
// (the old one goes to trash all the same). A copy the founder changed is theirs and is left exactly as they left it:
// the panel offers the new team instead (`updatesOf`). Gives back what it wrote.
export async function copyBuiltIns(from: string, frameworks: Frameworks, library: Library): Promise<string[]> {
  const found = await readdir(from, { withFileTypes: true }).catch(() => []);
  const ledger = await readLedger(from);
  const copied: string[] = [];
  for (const one of found) {
    if (!one.isDirectory() || !FRAMEWORK_ID.test(one.name)) continue;
    const framework = await builtIn(from, one.name).catch(() => null);
    if (!framework) continue;
    const today = contentHash(framework as unknown as Record<string, unknown>);
    const held = await rawOf(frameworks, one.name).catch(() => undefined);
    // A file broken by hand is the founder's to mend; writing over it would lose whatever they were in the middle of.
    if (held === undefined) continue;
    if (held) {
      // A copy made before there were shelves is put on today's shelf. The shelf is where the panel shows a team and
      // nothing any person reads, so it is not part of what the hash compares, and this is not an edit of anybody's.
      if (!held.stage && framework.stage) {
        held.stage = framework.stage;
        await frameworks.save({ ...(held as unknown as Framework), id: one.name });
      }
      const hash = contentHash(held);
      if (hash === today) {
        // The same team, from before copies were stamped: stamped now, so a later edit of theirs is told apart.
        if (held.shippedHash !== today) await frameworks.save({ ...(held as unknown as Framework), id: one.name, shippedHash: today });
        continue;
      }
      if (!(ledger[one.name] ?? []).includes(hash)) continue;
      await trash(frameworks, one.name);
    }
    await install(from, one.name, framework, frameworks, library);
    copied.push(one.name);
  }
  return copied;
}

// The built-in teams the founder changed and the app has changed since: their copy stays theirs, and the panel shows
// a quiet mark with the new team one press away. A copy stamped with today's version is simply theirs, edited; a copy
// from before stamping that differs from today's team cannot say which it came from, so it is offered too.
export async function updatesOf(from: string, frameworks: Frameworks): Promise<Set<string>> {
  const found = await readdir(from, { withFileTypes: true }).catch(() => []);
  const offered = new Set<string>();
  for (const one of found) {
    if (!one.isDirectory() || !FRAMEWORK_ID.test(one.name)) continue;
    const framework = await builtIn(from, one.name).catch(() => null);
    const held = await rawOf(frameworks, one.name).catch(() => null);
    if (!framework || !held) continue;
    const today = contentHash(framework as unknown as Record<string, unknown>);
    if (contentHash(held) !== today && held.shippedHash !== today) offered.add(one.name);
  }
  return offered;
}

// The founder took the update: their copy goes to trash, today's team takes its place. Null when there is no such
// built-in team to take.
export async function takeUpdate(from: string, id: string, frameworks: Frameworks, library: Library): Promise<Framework | null> {
  const framework = await builtIn(from, safe(id)).catch(() => null);
  if (!framework) return null;
  if (await rawOf(frameworks, id).catch(() => null)) await trash(frameworks, id);
  await install(from, id, framework, frameworks, library);
  return frameworks.read(id);
}
