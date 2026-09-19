import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { listen } from '../bus';
import type { ProjectNodeType } from '../stage';
import { CardActions, Frame } from './Frame';

// A code folder on this machine. A wired person may hand coding work to an agent that runs inside it; every step shows here.
export function ProjectNode({ id, data, selected }: NodeProps<ProjectNodeType>) {
  const { updateNodeData } = useReactFlow();
  const [lines, setLines] = useState<string[]>([]);
  const log = useRef<HTMLDivElement>(null);
  const name = data.path.trim().replace(/\/+$/, '').split('/').pop() || 'Project';

  useEffect(() => listen('effect', (effect) => {
    if (effect.kind === 'project-progress' && effect.id === id) setLines((current) => [...current.slice(-199), effect.line]);
  }), [id]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [lines]);

  return (
    <Frame selected={!!selected} minWidth={300} minHeight={200}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.500h4.200l1.300 1.600H14v7.400H2z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        <div className="card__name">{name}</div>
        <CardActions id={id} what={`the ${name} card (the folder itself stays)`} />
      </header>
      <input className="project__path nodrag" aria-label="Project folder" spellCheck={false} placeholder="/full/path/to/your/project" value={data.path} onChange={(event) => updateNodeData(id, { path: event.target.value })} />
      <div className="project__log nodrag nowheel" data-tail ref={log}>
        {lines.length === 0
          ? <p className="chat__empty">Set the folder, wire a person to it, then ask them to build or fix something. A free coding agent works inside this folder only, after your OK.</p>
          : lines.map((line, index) => <div key={index} className={line.startsWith('»') ? 'project__say' : undefined}>{line}</div>)}
      </div>
    </Frame>
  );
}
