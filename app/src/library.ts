import { useEffect, useSyncExternalStore } from 'react';
import type { Note } from '../shared/library';
import { getNotes } from './api';
import { overlay, showNote } from './overlay/store';

// The founder's library, as this window holds it: one list of the index, shared by every card and every panel, so a
// stage with six note cards on it asks the server once. The words of a note are never kept here — they are read
// when a note is opened and dropped again with the panel.
let notes: Note[] = [];
let asked = false;
const watchers = new Set<() => void>();
const subscribe = (tell: () => void) => { watchers.add(tell); return () => { watchers.delete(tell); }; };

export async function refreshNotes(): Promise<Note[]> {
  notes = await getNotes().catch(() => notes);
  for (const tell of watchers) tell();
  return notes;
}
export function useNotes(): Note[] {
  const held = useSyncExternalStore(subscribe, () => notes);
  useEffect(() => { if (!asked) { asked = true; void refreshNotes(); } }, []);
  return held;
}

// The two ways into the library from anywhere in the window: the note itself, and the list of them.
export const openNote = (id: string) => { showNote(id); overlay.open({ kind: 'panel', name: 'note' }); };
export const openLibrary = () => overlay.open({ kind: 'panel', name: 'library' });

export const NOTE_FILE = /\.(md|markdown|txt)$/i;
// What a dropped or chosen file is called in the library: its own name without the extension, said as a title.
export const titleOf = (name: string) => name.replace(NOTE_FILE, '').replace(/[-_]+/g, ' ').trim() || 'Note';
