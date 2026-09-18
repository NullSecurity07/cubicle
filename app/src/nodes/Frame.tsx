import { NodeResizer, useReactFlow } from '@xyflow/react';
import { useState, type ReactNode } from 'react';
import { Handles } from './Handles';

// What every card shares: glass, resize grips when selected, four handles.
export function Frame({ selected, minWidth, minHeight, children }: { selected: boolean; minWidth: number; minHeight: number; children: ReactNode }) {
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={minWidth} minHeight={minHeight} lineClassName="grip-line" handleClassName="grip" />
      <div className="card">{children}</div>
      <Handles />
    </>
  );
}

// Header buttons, seen on hover: an optional pencil, and a cross that asks once before the card leaves the stage.
export function CardActions({ id, what, onEdit }: { id: string; what: string; onEdit?: () => void }) {
  const { setNodes, setEdges } = useReactFlow();
  const [asking, setAsking] = useState(false);

  function remove() {
    setEdges((edges) => edges.filter((edge) => edge.source !== id && edge.target !== id));
    setNodes((nodes) => nodes.filter((node) => node.id !== id));
  }

  return (
    <>
      <div className="card__actions nodrag">
        {onEdit && (
          <button type="button" aria-label="Edit" title="Edit" onClick={onEdit}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 13l.6-2.800L10.800 3l2.200 2.200-7.200 7.200z" /></svg>
          </button>
        )}
        <button type="button" aria-label="Remove" title="Remove" onClick={() => setAsking(true)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
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
