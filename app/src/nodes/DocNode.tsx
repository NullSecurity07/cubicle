import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { getDoc, putDoc } from '../api';
import type { DocNodeType } from '../stage';
import { CardActions, Frame } from './Frame';

export function DocNode({ id, data, selected }: NodeProps<DocNodeType>) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const { updateNodeData } = useReactFlow();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => { getDoc(id).then(setText).catch(() => setText('')); }, [id]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function edit(next: string) {
    setText(next);
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { putDoc(id, next).then(() => setSaved(true)).catch(() => setSaved(false)); }, 500);
  }

  return (
    <Frame selected={!!selected} minWidth={240} minHeight={160}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5L12.5 5v9.5h-8.5zM9 1.5V5h3.5M6 8.5h4.5M6 11h4.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" /></svg>
        <input className="card__title-input nodrag" aria-label="Doc title" value={data.title} onChange={(event) => updateNodeData(id, { title: event.target.value })} />
        <div className="card__saved">{saved ? '' : 'saving…'}</div>
        <CardActions id={id} what={`"${data.title || 'this doc'}"`} />
      </header>
      <textarea className="doc nodrag nowheel" spellCheck={false} value={text ?? ''} disabled={text === null} onChange={(event) => edit(event.target.value)} />
    </Frame>
  );
}
