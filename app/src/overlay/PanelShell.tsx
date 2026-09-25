import type { ReactNode } from 'react';
import { overlay } from './store';
import { keyHint } from '../keys';

// The frame every founder's view shares: glass, a title, a way out. `className` names a view that arranges its own
// sheet (the dashboard); `onClose` is how it leaves when that is more than closing its own layer.
export function PanelShell({ name, title, note, wide, className, onClose, children }: { name: string; title: string; note?: string; wide?: boolean; className?: string; onClose?: () => void; children: ReactNode }) {
  return (
    <section className={['panel', wide && 'panel--wide', className].filter(Boolean).join(' ')} role="dialog" aria-modal="true" aria-label={title}>
      <header className="panel__header">
        <h2>{title}</h2>
        {note && <span>{note}</span>}
        <button type="button" aria-label="Close" title={`Close (${keyHint('back')})`} onClick={onClose ?? (() => overlay.close({ kind: 'panel', name }))}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
