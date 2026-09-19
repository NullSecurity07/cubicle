import type { ReactNode } from 'react';
import { overlay } from './store';

// The frame every founder's view shares: glass, a title, a way out.
export function PanelShell({ name, title, note, wide, children }: { name: string; title: string; note?: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className={`panel${wide ? ' panel--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="panel__header">
        <h2>{title}</h2>
        {note && <span>{note}</span>}
        <button type="button" aria-label="Close" title="Close (Esc)" onClick={() => overlay.close({ kind: 'panel', name })}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}
