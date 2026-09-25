import { useReactFlow } from '@xyflow/react';
import { useCallback } from 'react';
import { freeSpot } from './place';
import type { StageNode } from './stage';
import { CARD } from './stage';

const PALETTE = ['#ee8a72', '#4e8cff', '#f0b35a', '#6fcf97', '#b58cff', '#5fc9d6'];
const newId = (kind: string) => `${kind}-${Math.random().toString(36).slice(2, 8)}`;

// What a new card of each kind starts as.
const NEW = {
  room: { size: [380, 440], data: { name: '', role: '', brief: '' } },
  doc: { size: [340, 300], data: { title: 'Untitled doc' } },
  browser: { size: [560, 353], data: {} },
  project: { size: [420, 440], data: { path: '' } },
  board: { size: [980, 440], data: {} },
  leads: { size: [900, 420], data: {} },
  metrics: { size: [380, 440], data: {} },
  note: { size: [220, 180], data: { text: '' } },
  image: { size: [300, 260], data: { path: '' } },
  link: { size: [320, 150], data: { url: '' } },
  source: { size: [360, 320], data: { url: '', about: '' } },
  library: { size: [260, 180], data: { noteId: '' } },
  imagegen: { size: [320, 420], data: { prompt: '' } },
  voicegen: { size: [320, 340], data: { text: '' } },
  videogen: { size: [380, 420], data: { brief: '' } },
} as const;
export type CardKind = keyof typeof NEW;

// Adds a card at the centre of the view, in the nearest free space, selected, and glides there. `data` fills in what
// is already known (a role from the command bar, a doc title). `at` is a place on the canvas to put it instead of
// the middle of the window: where a file was let go of.
export function useAddCard() {
  const { getNodes, setNodes, screenToFlowPosition, setCenter, getZoom } = useReactFlow<StageNode>();
  return useCallback((kind: CardKind, extra: Record<string, unknown> = {}, at?: { x: number; y: number }) => {
    const nodes = getNodes();
    const { size: [width, height], data } = NEW[kind];
    const centre = at ?? screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const position = freeSpot(nodes, { x: Math.round(centre.x - width / 2), y: Math.round(centre.y - height / 2) }, width, height);
    const rooms = nodes.filter((node) => node.type === 'room').length;
    const node = { id: newId(kind), type: kind, position, width, height, selected: true, data: kind === 'room' ? { ...data, ...extra, accent: PALETTE[rooms % PALETTE.length] } : { ...data, ...extra }, ...CARD } as StageNode;
    setNodes((current) => [...current.map((other) => ({ ...other, selected: false })), node]);
    void setCenter(position.x + width / 2, position.y + height / 2, { zoom: getZoom(), duration: 350 });
    return node.id;
  }, [getNodes, setNodes, screenToFlowPosition, setCenter, getZoom]);
}
