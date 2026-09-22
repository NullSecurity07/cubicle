import { useEffect, useRef, useState } from 'react';
import { noteSize, type Note } from '../../shared/library';
import { useAddCard } from '../addCard';
import { addNote, getNote, removeNote } from '../api';
import { NOTE_FILE, openNote, refreshNotes, titleOf, useNotes } from '../library';
import { overlay, useNoteShown } from '../overlay/store';
import { PanelShell } from '../overlay/PanelShell';
import { BookIcon } from './LibraryCard';
import { Words } from './Rich';

const when = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// Words the founder pasted, with a title of their own. Two fields and one button: this is the way in for something
// they read somewhere, and it should cost less than opening a text editor.
function Paste({ onAdded }: { onAdded: (note: Note) => void }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setProblem('');
    try { onAdded(await addNote({ title, text, source: 'paste' })); } catch (error) { setProblem((error as Error).message); } finally { setSaving(false); }
  }

  return (
    <form className="library__paste" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <input aria-label="Note title" placeholder="What is this note called?" value={title} onChange={(event) => setTitle(event.target.value)} />
      <textarea aria-label="Note" rows={7} placeholder="Paste what you learned. Markdown headings are how a person finds their way around it." value={text} onChange={(event) => setText(event.target.value)} />
      {problem && <p className="msg--problem">{problem}</p>}
      <div className="library__end">
        <button type="button" onClick={() => overlay.back()}>Cancel</button>
        <button type="submit" className="primary" disabled={saving || !title.trim() || !text.trim()}>Add to library</button>
      </div>
    </form>
  );
}

// The library itself: the notes the founder has kept, and the two ways to add one. Choosing a note puts its card on
// the stage, which is the only thing this panel is really for.
export function LibraryPanel() {
  const notes = useNotes();
  const addCard = useAddCard();
  const picker = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState('');

  const place = (note: Note) => { overlay.close({ kind: 'panel', name: 'library' }); addCard('library', { noteId: note.id }); };
  async function added(note: Note) { setAdding(false); await refreshNotes(); place(note); }
  async function fromFile(file?: File) {
    if (!file) return;
    if (!NOTE_FILE.test(file.name)) { setProblem('A note is a .md or .txt file.'); return; }
    try { setProblem(''); await added(await addNote({ title: titleOf(file.name), text: await file.text(), source: 'file' })); }
    catch (error) { setProblem((error as Error).message); }
  }
  async function forget(note: Note) {
    try { setProblem(''); await removeNote(note.id); await refreshNotes(); } catch (error) { setProblem((error as Error).message); }
  }

  return (
    <PanelShell name="library" title="Notes" note="What you learned, for the people to work from">
      {problem && <p className="msg--problem">{problem}</p>}
      {adding ? <Paste onAdded={(note) => void added(note)} /> : (
        <>
          <div className="library__ways">
            <input ref={picker} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(event) => { void fromFile(event.target.files?.[0]); event.target.value = ''; }} />
            <button type="button" onClick={() => picker.current?.click()}>Add from file</button>
            <button type="button" onClick={() => setAdding(true)}>Paste</button>
          </div>
          {notes.length === 0 ? <p className="library__empty">Nothing here yet. Add a file you wrote, or paste what you learned; then wire a note to a person and they work from it.</p> : (
            <ul className="library__list">
              {notes.map((note) => (
                <li key={note.id} className="library__note">
                  <button type="button" className="library__pick" onClick={() => place(note)}>
                    <BookIcon />
                    <b>{note.title}</b>
                    <small>{noteSize(note.bytes)} · added {when(note.addedAt)}{note.tags.length ? ` · ${note.tags.join(', ')}` : ''}</small>
                  </button>
                  <div className="library__acts">
                    <button type="button" onClick={() => openNote(note.id)}>Read</button>
                    <button type="button" onClick={() => void forget(note)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </PanelShell>
  );
}

// One note, read. It is a file the founder owns, so nothing here can change it: they edit it where it lives and add
// it again, which is what keeps the hash in the index honest about what a framework was built from.
export function NotePanel() {
  const id = useNoteShown();
  const [note, setNote] = useState<(Note & { text: string }) | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    setNote(null);
    setProblem('');
    if (!id) return;
    let gone = false;
    getNote(id).then((held) => { if (!gone) setNote(held); }).catch((error: Error) => { if (!gone) setProblem(error.message); });
    return () => { gone = true; };
  }, [id]);

  return (
    <PanelShell name="note" title={note?.title ?? 'Note'} note={note ? `${noteSize(note.bytes)} · added ${when(note.addedAt)}` : undefined} wide>
      {problem && <p className="msg--problem">{problem}</p>}
      {note && <div className="md library__words"><Words text={note.text} /></div>}
    </PanelShell>
  );
}
