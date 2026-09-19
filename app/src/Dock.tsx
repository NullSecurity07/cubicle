import { Panel, useReactFlow } from '@xyflow/react';
import { useEffect, useState } from 'react';
import type { ModelInfo } from '../shared/model';
import { getModels } from './api';
import { listen } from './bus';
import { useAttention } from './overlay/attention';
import { overlay } from './overlay/store';
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

// What a new card of each kind starts as.
const NEW = {
  room: { size: [380, 440], data: { name: '', role: '', brief: '' } },
  doc: { size: [340, 300], data: { title: 'Untitled doc' } },
  browser: { size: [560, 353], data: {} },
  project: { size: [380, 300], data: { path: '' } },
  board: { size: [980, 440], data: {} },
  note: { size: [220, 180], data: { text: '' } },
  image: { size: [300, 260], data: { path: '' } },
  link: { size: [320, 150], data: { url: '' } },
} as const;
const MORE: [kind: keyof typeof NEW, label: string, hint: string][] = [
  ['note', 'Sticky note', 'Words a wired person keeps in mind'],
  ['link', 'Link', 'A web page a wired person reads'],
  ['image', 'Picture', 'An image a wired person can see'],
  ['browser', 'Browser', 'A live browser a wired person drives'],
  ['project', 'Project folder', 'Code a wired person can have changed'],
  ['board', 'Task board', 'People propose, you run'],
];

// The bell: how many things wait for the founder, in the one colour that means "needs you". The window title carries the count too.
function Needs() {
  const count = useAttention().length;
  useEffect(() => { document.title = count ? `(${count}) Stage` : 'Stage'; }, [count]);
  return (
    <button type="button" className={`dock__needs${count ? ' is-waiting' : ''}`} aria-label={count ? `Needs you: ${count} waiting` : 'Needs you: nothing waiting'} title="Needs you" onClick={() => overlay.open({ kind: 'panel', name: 'needs' })}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.200 13.500V9a4.800 4.800 0 0 1 9.600 0v4.500l1.400 1.800H3.800zM8.300 17.300a1.900 1.900 0 0 0 3.400 0" /></svg>
      {count > 0 && <b aria-hidden="true">{count > 9 ? '9+' : count}</b>}
    </button>
  );
}

// The only chrome on the stage: add a person, add a doc, and today's model usage. New cards land at the centre of the view.
export function Dock() {
  const { getNodes, setNodes, screenToFlowPosition, setCenter, getZoom } = useReactFlow<StageNode>();

  const [more, setMore] = useState(false);

  function add(kind: keyof typeof NEW) {
    setMore(false);
    const nodes = getNodes();
    const { size: [width, height], data } = NEW[kind];
    const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const position = freeSpot(nodes, { x: Math.round(centre.x - width / 2), y: Math.round(centre.y - height / 2) }, width, height);
    const rooms = nodes.filter((node) => node.type === 'room').length;
    const node = { id: newId(kind), type: kind, position, width, height, selected: true, data: kind === 'room' ? { ...data, accent: PALETTE[rooms % PALETTE.length] } : { ...data }, ...CARD } as StageNode;
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
      <div className="dock__more" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMore(false); }} onKeyDown={(event) => { if (event.key === 'Escape') setMore(false); }}>
        <button type="button" aria-label="More cards" aria-expanded={more} title="More cards" onClick={() => setMore(!more)}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.500v11M4.500 10h11" /></svg>
        </button>
        {more && (
          <div className="dock__menu" role="menu" aria-label="More cards">
            {MORE.map(([kind, label, hint]) => <button key={kind} type="button" role="menuitem" aria-label={`Add ${label.toLowerCase()}`} onClick={() => add(kind)}><b>{label}</b><small>{hint}</small></button>)}
          </div>
        )}
      </div>
      <span className="dock__gap" aria-hidden="true" />
      <Needs />
      <Quota />
    </Panel>
  );
}
