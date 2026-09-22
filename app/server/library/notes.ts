import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Note, NoteSource } from '../../shared/library.ts';
import { chunksOf, type Piece } from '../recall.ts';

export type Library = ReturnType<typeof createLibrary>;

// A note is something the founder learned and wrote down, not a database. Past this it is a file to open, not
// background for a turn, and the whole of it would sit in memory to be chunked and embedded on every start.
export const MOST_BYTES = 200 * 1024;
// What one person is given of a note in one turn: three passages, only ones that really answer the question, and
// never more than this much of it in total. A note pasted whole is the founder's own documents pushed out of the
// prompt by something nobody asked for.
export const TOP_CHUNKS = 3;
export const NOTE_FLOOR = 0.3;
export const MOST_NOTE_CHARS = 3000;
export const HEAD = (title: string) => `From the founder's notes (${title}):`;

// The same id rule as a skill: a slug of the title, so the file in the workspace is the note the founder named.
const slug = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
const safe = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error(`bad id: ${id}`); return id; };
export const idOf = (title: string) => safe(slug(title));
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

// Which framework holds a note, when one does. The frameworks slice fills this in; on its own the library knows of
// nobody, so a note the founder added is always theirs to delete.
export const inUse: { by: (id: string) => string | null } = { by: () => null };

// The heading a passage sits under, so a person is told where in a long note the words come from rather than only
// which note. Headings are read with their place in the text; the nearest one at or above the passage wins.
export function headingsOf(text: string): { at: number; title: string }[] {
  return [...text.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)].map((match) => ({ at: match.index ?? 0, title: match[1].trim() }));
}

// One note as recall holds it: a passage each, titled "<the note> › <the heading it is under>". The id carries the
// passage's place in the note, because recall keeps only two passages per source and three of them are wanted.
export function piecesOf(note: Note, text: string): Piece[] {
  const headings = headingsOf(text);
  let cursor = 0;
  return chunksOf(text).map((chunk, index) => {
    const at = text.indexOf(chunk, cursor);
    if (at >= 0) cursor = at + chunk.length;
    const under = [...headings].reverse().find((heading) => heading.at <= (at < 0 ? cursor : at));
    return { kind: 'library' as const, id: `${note.id}#${index}`, title: under ? `${note.title} › ${under.title}` : note.title, text: chunk, at: note.addedAt };
  });
}
// The note an id from `piecesOf` belongs to.
export const noteOf = (pieceId: string) => pieceId.replace(/#\d+$/, '');

// What goes into a person's system message: each note that had something to say, its passages quoted whole. A
// passage that does not fit inside the cap is left out rather than cut in half, and the block stops there.
export function notesBlock(found: { title: string; chunks: string[] }[], cap = MOST_NOTE_CHARS): string {
  const blocks: string[] = [];
  let size = 0;
  for (const note of found) {
    const kept: string[] = [];
    for (const chunk of note.chunks) {
      const would = size + (kept.length ? 0 : HEAD(note.title).length + 2) + chunk.length + 2;
      if (would > cap) break;
      kept.push(chunk);
      size = would;
    }
    if (kept.length) blocks.push(`${HEAD(note.title)}\n${kept.join('\n\n')}`);
  }
  return blocks.join('\n\n');
}

// The founder's library: a markdown file each under `<workspace>/library/`, and one index beside them. The files are
// the truth — the founder may open, edit or delete them by hand — and the index is what the panel and the forge read.
export function createLibrary(workspace: string, now: () => number = Date.now) {
  const folder = join(workspace, 'library');
  const path = (id: string) => join(folder, `${safe(id)}.md`);
  const indexPath = join(folder, 'index.json');

  async function list(): Promise<Note[]> {
    try {
      const held = JSON.parse(await readFile(indexPath, 'utf8')) as { notes?: Note[] };
      return Array.isArray(held.notes) ? held.notes : [];
    } catch { return []; }
  }
  async function keep(notes: Note[]) {
    await mkdir(folder, { recursive: true });
    await writeFile(`${indexPath}.tmp`, JSON.stringify({ notes }, null, 2));
    await rename(`${indexPath}.tmp`, indexPath);
  }

  return {
    folder,
    list,
    // The words themselves. A file the founder deleted by hand reads as nothing rather than as an error.
    read: async (id: string) => readFile(path(id), 'utf8').catch(() => null),
    // Adding a note the library already holds under that title replaces it: the founder keeps one copy of what they
    // wrote, and `hash` is what tells a framework built from the old words that they have changed.
    async add(asked: { title: string; text: string; tags?: string[]; source?: NoteSource }): Promise<Note> {
      const title = asked.title.replace(/\s+/g, ' ').trim();
      if (!title) throw new Error('A note needs a title.');
      const text = asked.text ?? '';
      if (!text.trim()) throw new Error('That note has nothing in it.');
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MOST_BYTES) throw new Error(`That note is ${kb(bytes)}, and the library takes notes up to ${kb(MOST_BYTES)}. Split it, or keep it as a doc on the stage.`);
      const note: Note = {
        id: idOf(title), title, tags: (asked.tags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
        source: asked.source === 'file' ? 'file' : 'paste', addedAt: now(), bytes, hash: createHash('sha1').update(text).digest('hex'),
      };
      await mkdir(folder, { recursive: true });
      await writeFile(path(note.id), text);
      await keep([note, ...(await list()).filter((held) => held.id !== note.id)]);
      return note;
    },
    // A note a framework was built from stays: taking it away would leave that framework's people reading nothing.
    async remove(id: string): Promise<void> {
      const holder = inUse.by(id);
      if (holder) throw new Error(`The framework "${holder}" was built from this note. Delete that framework first, or keep the note.`);
      await rm(path(id), { force: true });
      await keep((await list()).filter((held) => held.id !== id));
    },
    // Everything in the library, passage by passage, for this slice's own recall.
    async pieces(): Promise<Piece[]> {
      const found: Piece[] = [];
      for (const note of await list()) {
        const text = await readFile(path(note.id), 'utf8').catch(() => '');
        if (text.trim()) found.push(...piecesOf(note, text));
      }
      return found;
    },
  };
}
