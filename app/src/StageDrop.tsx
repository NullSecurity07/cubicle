import { useReactFlow } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { useAddCard } from './addCard';
import { addNote, uploadFile } from './api';
import { NOTE_FILE, refreshNotes, titleOf } from './library';
import type { StageNode } from './stage';

// Where a drop is the stage's to take: not one a card already took, and not into a box being typed in, where a dropped
// address is words to insert rather than a card to make.
const typing = (target: EventTarget | null) => target instanceof Element && !!target.closest('input, textarea, [contenteditable="true"]');
const carries = (event: DragEvent, what: 'file' | 'link') => [...(event.dataTransfer?.items ?? [])]
  .some((item) => (what === 'file' ? item.kind === 'file' : item.kind === 'string' && item.type === 'text/uri-list'));
// The first real address of a text/uri-list: lines starting with # are comments.
export const firstAddress = (list: string) => list.split(/\r?\n/).map((line) => line.trim()).find((line) => /^https?:\/\//i.test(line)) ?? '';

// Things dropped on the stage become cards where they land: a note file goes into the library and onto the stage, a
// picture becomes a picture card (uploaded exactly as the picture card's own chooser uploads it), a web address a link
// card that reads its page. Any other file is refused here rather than opened by the browser in place of the stage.
export function StageDrop() {
  const { screenToFlowPosition } = useReactFlow<StageNode>();
  const addCard = useAddCard();
  const [problem, setProblem] = useState('');

  useEffect(() => {
    const over = (event: DragEvent) => {
      if (event.defaultPrevented || typing(event.target)) return;
      if (carries(event, 'file') || carries(event, 'link')) event.preventDefault();
    };
    async function drop(event: DragEvent) {
      if (event.defaultPrevented || typing(event.target) || !event.dataTransfer) return;
      const file = event.dataTransfer.files[0];
      const address = file ? '' : firstAddress(event.dataTransfer.getData('text/uri-list'));
      if (!file && !address) return;
      event.preventDefault();
      const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      try {
        setProblem('');
        if (address) addCard('link', { url: address, read: true }, at);
        else if (NOTE_FILE.test(file.name)) {
          const note = await addNote({ title: titleOf(file.name), text: await file.text(), source: 'file' });
          await refreshNotes();
          addCard('library', { noteId: note.id }, at);
        } else if (file.type.startsWith('image/')) addCard('image', { path: (await uploadFile(file)).path }, at);
        else setProblem('Drop a note (.md or .txt), a picture or a web address here.');
      } catch (error) { setProblem((error as Error).message); }
    }
    const dropped = (event: DragEvent) => { void drop(event); };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', dropped);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', dropped); };
  }, [screenToFlowPosition, addCard]);

  if (!problem) return null;
  return <p className="drop-problem" role="status">{problem}<button type="button" aria-label="Dismiss" onClick={() => setProblem('')}>×</button></p>;
}
