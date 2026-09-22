import type { Note } from '../../shared/library.ts';
import { headingsOf } from '../library/notes.ts';

// What the forge reads before it proposes anything: the founder's notes as an outline of their own headings, and
// under each heading the passages of that section which the library's own recall thinks matter most. A note is never
// pasted whole — a 24 KB note pasted whole is most of a small model's prompt, and the half of it that is worked
// examples would push the method out.

// All of the founder's notes the forge will ever put in front of a model at once. Past this the biggest free model
// starts dropping the end of the prompt, which is where the rules are.
export const MOST_NOTE_CHARS = 12_000;
// Passages per heading, and headings asked about per note. The outline names every heading whatever happens; the cap
// is on how many of them are looked up, because a long note has a hundred of them and the first two dozen are the
// method.
export const PER_HEADING = 2;
export const MOST_HEADINGS = 24;

export type Section = { heading: string; chunks: string[] };
// One note as the forge reads it. `headings` is the whole outline, in the note's own order; `sections` is only the
// part there was room to look into.
export type NoteRead = { id: string; title: string; hash: string; headings: string[]; sections: Section[] };
// What a note looks like to the check that a brief names the section it works from.
export type NoteShape = { title: string; headings: string[] };

// Reads each note asked for. `find` is the library's index, `search` is its recall, asked one heading at a time so
// the passages that come back are the ones that answer that heading rather than the note's first paragraphs.
export async function readNotes(
  ids: string[],
  library: { find(id: string): Promise<Note | undefined>; read(id: string): Promise<string | null>; search(query: string, noteId: string, top: number): Promise<string[]> },
): Promise<NoteRead[]> {
  const found: NoteRead[] = [];
  for (const id of [...new Set(ids)]) {
    const note = await library.find(id);
    const text = note ? await library.read(id) : null;
    if (!note || !text?.trim()) throw new Error(`"${id}" is not in the library any more, so there is nothing to build from.`);
    const headings = headingsOf(text).map((heading) => heading.title);
    const sections: Section[] = [];
    for (const heading of headings.slice(0, MOST_HEADINGS)) {
      const chunks = await library.search(heading, id, PER_HEADING);
      if (chunks.length) sections.push({ heading, chunks });
    }
    // A note with no headings at all is still a note: its first passages are asked for under its own title.
    if (!sections.length) sections.push({ heading: note.title, chunks: await library.search(note.title, id, PER_HEADING * 2) });
    found.push({ id, title: note.title, hash: note.hash, headings, sections });
  }
  return found;
}

// The notes as the model reads them: the outline first, so it can see the shape of the method, then the passages
// under the headings they came from. A passage already quoted is not quoted again, and the block stops where the cap
// is reached rather than cutting a passage in half.
export function notesBlock(notes: NoteRead[], cap = MOST_NOTE_CHARS): string {
  const blocks: string[] = [];
  const seen = new Set<string>();
  let size = 0;
  let full = false;
  for (const note of notes) {
    const head = `## The founder's note: ${note.title}\nIts sections, in order: ${note.headings.join(' · ') || '(none)'}`;
    const parts: string[] = [];
    for (const section of note.sections) {
      for (const chunk of section.chunks) {
        if (seen.has(chunk)) continue;
        const piece = `### ${section.heading}\n${chunk}`;
        const adds = piece.length + 2 + (parts.length ? 0 : head.length + 2);
        if (size + adds > cap) { full = true; break; }
        seen.add(chunk);
        parts.push(piece);
        size += adds;
      }
      if (full) break;
    }
    if (parts.length) blocks.push(`${head}\n\n${parts.join('\n\n')}`);
    if (full) break;
  }
  return blocks.join('\n\n');
}

// What the checks need to know about the notes: the words a brief can name its section by.
export const shapesOf = (notes: NoteRead[]): NoteShape[] => notes.map(({ title, headings }) => ({ title, headings }));
