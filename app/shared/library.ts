// The founder's library, as both sides see it. Where a note came from: a file they dropped, or words they pasted.
export type NoteSource = 'file' | 'paste';
// One note in the index. `hash` is of the words themselves, so a framework built from a note can later say whether
// it was built from the version that is there now; `bytes` is what the card shows, so nobody has to open a note to
// find out how big it is.
// `words` is absent on a note added before notes were counted in words, and `noteLength` works one out from the
// bytes for those rather than showing the founder nothing.
export type Note = { id: string; title: string; tags: string[]; source: NoteSource; addedAt: number; bytes: number; words?: number; hash: string };

// A size a founder reads rather than a number of bytes. Kept for the places that really are talking about a file
// size — what the library will take, what it refused.
export const noteSize = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 100 ? `${(bytes / 1024).toFixed(1)} KB` : `${Math.round(bytes / 1024)} KB`);

export const wordsIn = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
// How long a note is, in the unit the founder wrote it in. Kilobytes are how a disk measures a note; words are how
// a person does, and "2,300 words" says at a glance whether this is a page or an afternoon.
const BYTES_A_WORD = 6;
export const noteLength = (note: { words?: number; bytes: number }) =>
  `${(note.words ?? Math.max(1, Math.round(note.bytes / BYTES_A_WORD))).toLocaleString()} words`;

// A passage of a note shown as one line: the marks the founder wrote for a reader — headings, emphasis, code ticks,
// list bullets — are noise in a list of search results, so the words come out and the marks do not.
export const plainLine = (text: string) => text
  .replace(/`+/g, '').replace(/^[ \t]*#{1,6}[ \t]+/gm, '').replace(/^[ \t]*[-*+][ \t]+/gm, '')
  .replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
