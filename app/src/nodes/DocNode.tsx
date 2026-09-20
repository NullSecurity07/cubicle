import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { getDoc, putDoc } from '../api';
import { listen } from '../bus';
import type { DocNodeType } from '../stage';
import { CardActions, Frame } from './Frame';

export function DocNode({ id, data, selected }: NodeProps<DocNodeType>) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const [fresh, setFresh] = useState(false);
  const { updateNodeData } = useReactFlow();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Words typed but not saved yet. Saving waits half a second for the typing to pause, and that half second must never
  // cost the founder a sentence: a card taken off the stage, a reload or a closed window all save what is pending first.
  const pending = useRef<string | null>(null);

  useEffect(() => { getDoc(id).then(setText).catch(() => setText('')); }, [id]);
  useEffect(() => {
    const flush = () => {
      clearTimeout(timer.current);
      if (pending.current === null) return;
      void putDoc(id, pending.current, true).catch(() => {});
      pending.current = null;
    };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [id]);
  // A person rewrote this doc: show their version, and drop any save of ours that would undo it.
  useEffect(() => listen('effect', (effect) => {
    if (effect.kind !== 'doc-changed' || effect.id !== id) return;
    clearTimeout(timer.current);
    pending.current = null;
    getDoc(id).then((next) => { setText(next); setSaved(true); setFresh(true); setTimeout(() => setFresh(false), 1600); }).catch(() => {});
  }), [id]);

  function edit(next: string) {
    setText(next);
    setSaved(false);
    clearTimeout(timer.current);
    pending.current = next;
    timer.current = setTimeout(() => { pending.current = null; putDoc(id, next).then(() => setSaved(true)).catch(() => { setSaved(false); pending.current ??= next; }); }, 500);
  }

  return (
    <Frame selected={!!selected} minWidth={240} minHeight={160}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5L12.5 5v9.5h-8.5zM9 1.5V5h3.5M6 8.5h4.5M6 11h4.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" /></svg>
        <input className="card__title-input nodrag" aria-label="Doc title" value={data.title} onChange={(event) => updateNodeData(id, { title: event.target.value })} />
        {data.pinned && <span className="doc__all" title="Every person reads this doc">all</span>}
        <div className="card__saved">{fresh ? 'updated' : saved ? '' : 'saving…'}</div>
        <button type="button" className={`doc__pin nodrag${data.pinned ? ' is-on' : ''}`} aria-label={data.pinned ? 'Unpin: only wired people read this' : 'Pin: every person reads this'} aria-pressed={!!data.pinned} title={data.pinned ? 'Unpin: only wired people read this' : 'Pin: every person reads this'} onClick={() => updateNodeData(id, { pinned: !data.pinned })}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.500 2l4.500 4.500-2 .600-2.400 2.400.300 3L8.400 11 4 15l-.500-.500L7.500 10 6 8.500l3-.300L11.400 5.800z" /></svg>
        </button>
        <CardActions id={id} what={`"${data.title || 'this doc'}"`} />
      </header>
      <textarea className={`doc nodrag nowheel${fresh ? ' doc--fresh' : ''}`} spellCheck={false} value={text ?? ''} disabled={text === null} onChange={(event) => edit(event.target.value)} />
    </Frame>
  );
}
