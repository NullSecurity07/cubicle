import { useEffect, useRef, type ReactNode } from 'react';
import { overlay } from './store';
import { keyHint } from '../keys';

// The frame every founder's view shares: glass, a title, a way out. `className` names a view that arranges its own
// sheet (the dashboard); `onClose` is how it leaves when that is more than closing its own layer. A `side` view slides
// in from the left edge instead of sitting in the middle, and takes the keyboard with it as it opens, so Tab and the
// arrow keys start inside it rather than on the button that opened it.
export function PanelShell({ name, title, note, wide, side, className, onClose, children }: { name: string; title: string; note?: string; wide?: boolean; side?: boolean; className?: string; onClose?: () => void; children: ReactNode }) {
  const sheet = useRef<HTMLElement>(null);
  useEffect(() => { if (side && !sheet.current?.contains(document.activeElement)) sheet.current?.focus({ preventScroll: true }); }, [side]);
  return (
    <section ref={sheet} tabIndex={side ? -1 : undefined} className={['panel', wide && 'panel--wide', side && 'panel--side', className].filter(Boolean).join(' ')} role="dialog" aria-modal="true" aria-label={title}>
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
