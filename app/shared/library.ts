// The founder's library, as both sides see it. Where a note came from: a file they dropped, or words they pasted.
export type NoteSource = 'file' | 'paste';
// One note in the index. `hash` is of the words themselves, so a framework built from a note can later say whether
// it was built from the version that is there now; `bytes` is what the card shows, so nobody has to open a note to
// find out how big it is.
export type Note = { id: string; title: string; tags: string[]; source: NoteSource; addedAt: number; bytes: number; hash: string };

// A size a founder reads rather than a number of bytes.
export const noteSize = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 100 ? `${(bytes / 1024).toFixed(1)} KB` : `${Math.round(bytes / 1024)} KB`);
