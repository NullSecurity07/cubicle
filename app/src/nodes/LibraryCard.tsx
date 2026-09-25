import type { NodeProps } from '@xyflow/react';
import { noteLength } from '../../shared/library';
import { openNote, useNotes } from '../library';
import type { LibraryNodeType } from '../stage';
import { CardActions, Frame } from './Frame';

// The icon the library wears everywhere: an open book. Written out here and used by the panel too, so a note looks
// the same on the stage, in the list and in the dock.
export const BookIcon = () => (
  <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 4.400C6.900 3.500 5.600 3.100 3.800 3.100H2.400v9.100h1.400c1.800 0 3.100.400 4.200 1.300 1.100-.900 2.400-1.300 4.200-1.300h1.400V3.100h-1.400c-1.800 0-3.100.400-4.200 1.300zM8 4.400v9.100" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

// A note out of the founder's library, standing on the stage. The card holds only which note it is: wired to a
// person, that person is handed the passages of it that answer the question in front of them, and nothing else.
export function LibraryNode({ id, data, selected }: NodeProps<LibraryNodeType>) {
  const notes = useNotes();
  const note = notes.find((held) => held.id === data.noteId);
  return (
    <Frame selected={!!selected} minWidth={220} minHeight={150}>
      <header className="card__header card__header--doc">
        <BookIcon />
        <div className="card__name">{note?.title ?? 'Note'}</div>
        <CardActions id={id} what="this note card (the note stays in your library)" />
      </header>
      <div className="library-card nodrag">
        {note ? (
          <>
            {note.tags.length > 0 && <ul className="library-card__tags">{note.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>}
            <p className="library-card__size">{noteLength(note)} · {note.source === 'file' ? 'from a file' : 'pasted in'}</p>
            <p className="library-card__hint">Whoever is wired to this reads the parts of it that answer their question.</p>
            <button type="button" className="library-card__open" onClick={() => openNote(note.id)}>Open</button>
          </>
        ) : (
          <p className="library-card__hint">This note is no longer in your library. Remove the card, or add the note again.</p>
        )}
      </div>
    </Frame>
  );
}
