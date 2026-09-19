import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useState } from 'react';
import type { RoomNodeType } from '../stage';
import { Avatar } from './Avatar';
import { Chat, type Status } from './Chat';
import { CardActions, Frame } from './Frame';
import { MemoryPanel } from './MemoryPanel';
import { PersonForm } from './PersonForm';

export function RoomNode({ id, data, selected }: NodeProps<RoomNodeType>) {
  const [status, setStatus] = useState<Status>('idle');
  const [lastAsk, setLastAsk] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const { updateNodeData } = useReactFlow();
  const setup = editing || !data.name;
  const doing = status === 'waiting' ? 'needs your OK' : status === 'thinking' ? 'working…' : status === 'error' ? 'could not reply' : lastAsk ?? 'Ready when you are';

  return (
    <Frame selected={!!selected} minWidth={300} minHeight={280}>
      <header className="card__header">
        <Avatar accent={data.accent} />
        <div className="card__who">
          <div className="card__name">{data.name || 'New person'} {data.role && <span>· {data.role}</span>}</div>
          <div className="card__doing">{setup ? 'Tell me who this is' : doing}</div>
        </div>
        {data.name && (
          <div className="card__actions nodrag">
            <button type="button" aria-label="Memory" title={`What ${data.name} remembers`} onClick={() => setRemembering(true)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.500h8v11l-4-2.600-4 2.600z" /></svg>
            </button>
          </div>
        )}
        <CardActions id={id} what={data.name ? `${data.name} and this conversation` : 'this person'} onEdit={() => setEditing(true)} />
        <div className={`status status--${status}`} title={status} />
      </header>
      {remembering && <MemoryPanel id={id} name={data.name} onClose={() => setRemembering(false)} />}
      {setup && <PersonForm person={data} onCancel={data.name ? () => setEditing(false) : undefined} onSave={(next) => { updateNodeData(id, next); setEditing(false); }} />}
      {/* The chat stays mounted under the form, so a reply in flight survives an edit. */}
      <div className="card__body" hidden={setup}>
        {data.name && <Chat id={id} name={data.name} role={data.role} onStatus={(next, ask) => { setStatus(next); setLastAsk(ask); }} />}
      </div>
    </Frame>
  );
}
