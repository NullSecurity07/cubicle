import {
  Background, BackgroundVariant, ConnectionLineType, ConnectionMode, ReactFlow,
  addEdge, useEdgesState, useNodesState, type Connection, type Edge,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getKeys, getStage, putStage } from './api';
import { listen } from './bus';
import { Dock } from './Dock';
import { Missions } from './Missions';
import { edgeTypes } from './edges';
import { nodeTypes } from './nodes';
import { SelectionMenu } from './SelectionMenu';
import { StageDrop } from './StageDrop';
import { Overlay } from './overlay/Overlay';
import { flowKeys, onOverrides, overridesVersion, setOverrides } from './keys';
import { NEW_SIZE } from './addCard';
import { freeSpot } from './place';
import { CARD, WIRE, allowedWire, fromFlow, toFlow, type StageNode } from './stage';
import { SyncContext } from './sync';

// Built once: handed to the canvas inline, they would be new objects on every render, every drag frame included.
const FIT_VIEW = { padding: 0.15, maxZoom: 1 };
const PRO = { hideAttribution: true };

function Canvas({ initial }: { initial: ReturnType<typeof toFlow> }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<StageNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [connecting, setConnecting] = useState(false);
  const lastSaved = useRef(JSON.stringify(fromFlow(initial.nodes, initial.edges)));

  const onConnect = useCallback(
    (connection: Connection) => setEdges((current) => (allowedWire(connection, current) ? addEdge({ ...connection, ...WIRE }, current) : current)),
    [setEdges],
  );
  const onConnectStart = useCallback(() => setConnecting(true), []);
  const onConnectEnd = useCallback(() => setConnecting(false), []);
  // The canvas's own keys come from the shortcut table, and change when the founder's keys.json arrives. xyflow listens
  // again whenever it is handed a new list, so the lists are made again only then.
  const version = useSyncExternalStore(onOverrides, overridesVersion);
  const keys = useMemo(() => ({ remove: flowKeys('delete-cards'), several: flowKeys('pick-several'), area: flowKeys('select-area') }), [version]);

  const latest = useRef({ nodes, edges });
  latest.current = { nodes, edges };
  // Read from the ref, so the check keeps one identity while the wires change under a drag.
  const isValidConnection = useCallback((connection: Connection | Edge) => allowedWire(connection, latest.current.edges), []);

  // Layout, sizes and wires save themselves shortly after they stop changing; `save` can also be called at once.
  const save = useCallback(async () => {
    const stage = fromFlow(latest.current.nodes, latest.current.edges);
    const text = JSON.stringify(stage);
    if (text === lastSaved.current) return;
    lastSaved.current = text;
    await putStage(stage);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void save(), 400);
    return () => clearTimeout(timer);
  }, [nodes, edges, save]);

  // A person made a doc: its card lands beside them, already wired.
  useEffect(() => listen('effect', (effect) => {
    if (effect.kind !== 'doc-created') return;
    const room = latest.current.nodes.find((node) => node.id === effect.roomId);
    if (!room || latest.current.nodes.some((node) => node.id === effect.id)) return;
    const [width, height] = NEW_SIZE.doc;
    const beside = { x: room.position.x + (room.width ?? 380) + 80, y: room.position.y };
    const position = freeSpot(latest.current.nodes, beside, width, height);
    setNodes((current) => [...current, { id: effect.id, type: 'doc', position, width, height, data: { title: effect.title }, ...CARD }]);
    setEdges((current) => [...current, { id: `${effect.roomId}-${effect.id}`, source: effect.roomId, sourceHandle: 'r', target: effect.id, targetHandle: 'l', ...WIRE }]);
  }), [setNodes, setEdges]);

  return (
    <SyncContext.Provider value={save}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectStart={onConnectStart}
      onConnectEnd={onConnectEnd}
      isValidConnection={isValidConnection}
      className={connecting ? 'connecting' : undefined}
      connectionMode={ConnectionMode.Loose}
      connectionLineType={ConnectionLineType.SmoothStep}
      colorMode="dark"
      fitView
      fitViewOptions={FIT_VIEW}
      minZoom={0.25}
      maxZoom={2}
      proOptions={PRO}
      deleteKeyCode={keys.remove}
      multiSelectionKeyCode={keys.several}
      selectionKeyCode={keys.area}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="rgba(255, 255, 255, 0.24)" bgColor="transparent" />
      <Dock />
      <Missions />
      <StageDrop />
      <SelectionMenu />
      <Overlay />
    </ReactFlow>
    </SyncContext.Provider>
  );
}

export default function App() {
  const [initial, setInitial] = useState<ReturnType<typeof toFlow> | null>(null);
  const [problem, setProblem] = useState('');

  // The founder's own keys, if they wrote any. Without them, or without an answer, every key is the table's.
  useEffect(() => { getKeys().then((found) => setOverrides(found.keys)).catch(() => {}); }, []);
  useEffect(() => { getStage().then((stage) => setInitial(toFlow(stage))).catch((error: Error) => setProblem(error.message)); }, []);

  return (
    <div className="stage">
      {initial && <Canvas initial={initial} />}
      {problem && <p className="stage__problem">The stage could not load: {problem}</p>}
    </div>
  );
}
