import { Panel, useReactFlow } from '@xyflow/react';
import type { StageNode } from './stage';
import { CARD } from './stage';

const PALETTE = ['#ee8a72', '#4e8cff', '#f0b35a', '#6fcf97', '#b58cff', '#5fc9d6'];
const newId = (kind: string) => `${kind}-${Math.random().toString(36).slice(2, 8)}`;

const GAP = 40;

// The centre of the view if it is free; otherwise the nearest free place in widening rings around it.
function freeSpot(nodes: StageNode[], start: { x: number; y: number }, width: number, height: number) {
  const hits = (x: number, y: number) => nodes.some((node) => {
    const w = node.width ?? node.measured?.width ?? 0;
    const h = node.height ?? node.measured?.height ?? 0;
    return x < node.position.x + w + GAP && x + width + GAP > node.position.x && y < node.position.y + h + GAP && y + height + GAP > node.position.y;
  });
  for (let ring = 0; ring <= 6; ring += 1) {
    for (let row = -ring; row <= ring; row += 1) {
      for (let column = -ring; column <= ring; column += 1) {
        if (Math.max(Math.abs(row), Math.abs(column)) !== ring) continue;
        const x = start.x + column * (width + GAP);
        const y = start.y + row * (height + GAP);
        if (!hits(x, y)) return { x, y };
      }
    }
  }
  return start;
}

// The only chrome on the stage: add a person, add a doc. New cards land at the centre of the view.
export function Dock() {
  const { getNodes, setNodes, screenToFlowPosition, setCenter, getZoom } = useReactFlow<StageNode>();

  function add(kind: 'room' | 'doc') {
    const nodes = getNodes();
    const [width, height] = kind === 'room' ? [380, 440] : [340, 300];
    const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const position = freeSpot(nodes, { x: Math.round(centre.x - width / 2), y: Math.round(centre.y - height / 2) }, width, height);
    const rooms = nodes.filter((node) => node.type === 'room').length;
    const node: StageNode = kind === 'room'
      ? { id: newId('room'), type: 'room', position, width, height, selected: true, data: { name: '', role: '', brief: '', accent: PALETTE[rooms % PALETTE.length] }, ...CARD }
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
    </Panel>
  );
}
