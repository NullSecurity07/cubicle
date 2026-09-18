import { Panel, useReactFlow } from '@xyflow/react';
import { useEffect, useState } from 'react';
import type { ModelInfo } from '../shared/model';
import { getModels } from './api';
import { listen } from './bus';
import { freeSpot } from './place';
import type { StageNode } from './stage';
import { CARD } from './stage';

const PALETTE = ['#ee8a72', '#4e8cff', '#f0b35a', '#6fcf97', '#b58cff', '#5fc9d6'];
const newId = (kind: string) => `${kind}-${Math.random().toString(36).slice(2, 8)}`;

// One ring per model provider: how much of today's free quota is left. Amber under a fifth, red when gone.
function Quota() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const load = () => { getModels().then(setModels).catch(() => {}); };
    load();
    return listen('usage', load);
  }, []);
  if (!models.length) return null;
  const tone = (left: number) => (left <= 0.05 ? 'out' : left < 0.2 ? 'low' : 'fine');
  return (
    <div className="quota">
      <button type="button" className="quota__rings" aria-label="Model usage today" aria-expanded={open} title="Model usage today" onClick={() => setOpen(!open)}>
        {models.map((model) => (
          <svg key={model.name} viewBox="0 0 20 20" className={`ring ring--${tone(model.left)}`} role="img" aria-label={`${model.name}: ${Math.round(model.left * 100)}% left`}>
            <circle cx="10" cy="10" r="7" className="ring__track" />
            <circle cx="10" cy="10" r="7" pathLength={100} strokeDasharray={`${Math.round(model.left * 100)} 100`} transform="rotate(-90 10 10)" />
          </svg>
        ))}
      </button>
      {open && (
        <div className="quota__detail" role="dialog" aria-label="Model usage today">
          {models.map((model) => (
            <div key={model.name} className="quota__row">
              <span className={`quota__dot ring--${tone(model.left)}`} />
              <span className="quota__name">{model.name}<small>{model.model}</small></span>
              <span className="quota__numbers">{Math.round(model.left * 100)}% left<small>{model.requests} replies · {model.tokens.toLocaleString()} tokens · $0</small></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The only chrome on the stage: add a person, add a doc, and today's model usage. New cards land at the centre of the view.
export function Dock() {
  const { getNodes, setNodes, screenToFlowPosition, setCenter, getZoom } = useReactFlow<StageNode>();

  function add(kind: 'room' | 'doc' | 'browser' | 'project') {
    const nodes = getNodes();
    const [width, height] = kind === 'room' ? [380, 440] : kind === 'browser' ? [560, 353] : kind === 'project' ? [380, 300] : [340, 300];
    const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const position = freeSpot(nodes, { x: Math.round(centre.x - width / 2), y: Math.round(centre.y - height / 2) }, width, height);
    const rooms = nodes.filter((node) => node.type === 'room').length;
    const node: StageNode = kind === 'room'
      ? { id: newId('room'), type: 'room', position, width, height, selected: true, data: { name: '', role: '', brief: '', accent: PALETTE[rooms % PALETTE.length] }, ...CARD }
      : kind === 'project' ? { id: newId('project'), type: 'project', position, width, height, selected: true, data: { path: '' }, ...CARD }
      : kind === 'browser' ? { id: newId('browser'), type: 'browser', position, width, height, selected: true, data: {}, ...CARD }
      : { id: newId('doc'), type: 'doc', position, width, height, selected: true, data: { title: 'Untitled doc' }, ...CARD };
    setNodes((current) => [...current.map((other) => ({ ...other, selected: false })), node]);
    void setCenter(position.x + width / 2, position.y + height / 2, { zoom: getZoom(), duration: 350 });
  }

  return (
    <Panel position="bottom-center" className="dock">
      <button type="button" aria-label="Add person" title="Add person" onClick={() => add('room')}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.2" /><path d="M3.8 17c.6-3.4 3-5.2 6.2-5.2s5.6 1.8 6.2 5.2" /></svg>
      </button>
      <button type="button" aria-label="Add doc" title="Add doc" onClick={() => add('doc')}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 2.5h6L15 6v11.5H5.5zM11.5 2.5V6H15M8 10h4.5M8 13h4.5" /></svg>
      </button>
      <button type="button" aria-label="Add browser" title="Add browser" onClick={() => add('browser')}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2" /><path d="M2.8 10h14.4M10 2.800c2.400 2.300 2.400 12.100 0 14.400M10 2.800c-2.400 2.300-2.400 12.100 0 14.400" /></svg>
      </button>
      <button type="button" aria-label="Add project" title="Add project folder" onClick={() => add('project')}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.800 5.500h5l1.600 2h7.800v8.500H2.800z" /><path d="M7.500 11l-1.800 1.600 1.800 1.600M12.500 11l1.800 1.600-1.800 1.600" /></svg>
      </button>
      <Quota />
    </Panel>
  );
}
