import { NodeResizer, useNodeId, useReactFlow } from '@xyflow/react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { focusSheet, overlay, useFocused } from '../overlay/store';
import { Handles } from './Handles';

const halt = (event: SyntheticEvent) => event.stopPropagation();

// What every card shares: glass, resize grips when selected, four handles.
// The glass itself is one lasting element that the card's content is drawn into. Focusing the card moves that element
// into the sheet above the canvas and back; nothing is drawn twice, so a reply in flight or a draft is never lost.
export function Frame({ selected, minWidth, minHeight, children }: { selected: boolean; minWidth: number; minHeight: number; children: ReactNode }) {
  const id = useNodeId() ?? '';
  const focused = useFocused(id);
  const slot = useRef<HTMLDivElement>(null);
  const [glass] = useState(() => Object.assign(document.createElement('div'), { className: 'card' }));

  useLayoutEffect(() => {
    const home = focused ? focusSheet() ?? slot.current : slot.current;
    if (!home || glass.parentElement === home) return;
    home.appendChild(glass);
    glass.classList.toggle('card--focused', focused && home !== slot.current);
    // A moved element forgets where it was scrolled to and what was being typed in.
    for (const tail of glass.querySelectorAll('[data-tail]')) tail.scrollTop = tail.scrollHeight;
    if (focused) (glass.querySelector<HTMLElement>('textarea') ?? glass.querySelector<HTMLElement>('input:not([type="file"])') ?? glass.querySelector<HTMLElement>('button'))?.focus();
  }, [focused, glass]);
  // A card that leaves the stage while focused takes its layer with it.
  useEffect(() => () => { overlay.close({ kind: 'focus', id }); glass.remove(); }, [id, glass]);

  return (
    <>
      <NodeResizer isVisible={selected} minWidth={minWidth} minHeight={minHeight} lineClassName="grip-line" handleClassName="grip" />
      <div className="card-slot" ref={slot} />
      {/* In the sheet the card is no longer a canvas node: its clicks and keys must not select or nudge the node below. */}
      {createPortal(<div className="card__content" {...(focused ? { onClick: halt, onDoubleClick: halt, onKeyDown: halt, onFocus: halt } : {})}>{children}</div>, glass)}
      <Handles />
    </>
  );
}

// Header buttons, seen on hover: an optional pencil, and a cross that asks once before the card leaves the stage.
export function CardActions({ id, what, onEdit }: { id: string; what: string; onEdit?: () => void }) {
  const { setNodes, setEdges } = useReactFlow();
  const [asking, setAsking] = useState(false);
  const focused = useFocused(id);

  function remove() {
    setEdges((edges) => edges.filter((edge) => edge.source !== id && edge.target !== id));
    setNodes((nodes) => nodes.filter((node) => node.id !== id));
  }

  return (
    <>
      <div className="card__actions nodrag">
        <button type="button" aria-label={focused ? 'Back to the stage' : 'Focus'} title={focused ? 'Back to the stage (Esc)' : 'Focus (F)'} onClick={() => (focused ? overlay.close({ kind: 'focus', id }) : overlay.open({ kind: 'focus', id }))}>
          <svg viewBox="0 0 16 16" aria-hidden="true">{focused ? <path d="M6 2.500v3.500h-3.500M10 13.500v-3.500h3.500M10 2.500v3.500h3.500M6 13.500v-3.500h-3.500" /> : <path d="M2.500 6v-3.500h3.500M13.500 10v3.500h-3.500M13.500 6v-3.500h-3.500M2.500 10v3.500h3.500" />}</svg>
        </button>
        {onEdit && (
          <button type="button" aria-label="Edit" title="Edit" onClick={onEdit}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.6-2.800L10.800 3l2.200 2.200-7.200 7.200z" /></svg>
          </button>
        )}
        {/* In the sheet a cross would read as "close"; removing a card is done on the stage. */}
        {!focused && (
          <button type="button" aria-label="Remove" title="Remove" onClick={() => setAsking(true)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        )}
      </div>
      {asking && (
        <div className="confirm nodrag" role="alertdialog" aria-label={`Remove ${what}`}>
          <p>Remove {what}?</p>
          <p className="confirm__note">Its file moves to the workspace trash.</p>
          <div>
            <button type="button" onClick={() => setAsking(false)}>Keep</button>
            <button type="button" className="danger" onClick={remove}>Remove</button>
          </div>
        </div>
      )}
    </>
  );
}
