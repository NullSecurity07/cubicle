import {
  Background, BackgroundVariant, ConnectionLineType, ConnectionMode, ReactFlow,
  addEdge, useEdgesState, useNodesState, type Connection, type Edge,
} from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getStage, putStage } from './api';
import { listen } from './bus';
import { Dock } from './Dock';
import { Missions } from './Missions';
import { edgeTypes } from './edges';
import { nodeTypes } from './nodes';
import { NoteDrop } from './nodes/LibraryCard';
import { Overlay } from './overlay/Overlay';
import { freeSpot } from './place';
import { CARD, WIRE, fromFlow, toFlow, type StageNode } from './stage';
import { SyncContext } from './sync';

function Canvas({ initial }: { initial: ReturnType<typeof toFlow> }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<StageNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [connecting, setConnecting] = useState(false);
  const lastSaved = useRef(JSON.stringify(fromFlow(initial.nodes, initial.edges)));

  const onConnect = useCallback(
    (connection: Connection) => setEdges((current) => addEdge({ ...connection, ...WIRE }, current)),
    [setEdges],
  );

  // Layout, sizes and wires save themselves shortly after they stop changing; `save` can also be called at once.
  const latest = useRef({ nodes, edges });
  latest.current = { nodes, edges };
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
    const [width, height] = [340, 300];
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
      onConnectStart={() => setConnecting(true)}
      onConnectEnd={() => setConnecting(false)}
      className={connecting ? 'connecting' : undefined}
      connectionMode={ConnectionMode.Loose}
      connectionLineType={ConnectionLineType.SmoothStep}
      colorMode="dark"
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.25}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="rgba(255, 255, 255, 0.24)" bgColor="transparent" />
      <Dock />
      <Missions />
      <NoteDrop />
      <Overlay />
    </ReactFlow>
    </SyncContext.Provider>
  );
}

export default function App() {
  const [initial, setInitial] = useState<ReturnType<typeof toFlow> | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => { getStage().then((stage) => setInitial(toFlow(stage))).catch((error: Error) => setProblem(error.message)); }, []);

  return (
    <div className="stage">
      {initial && <Canvas initial={initial} />}
      {problem && <p className="stage__problem">The stage could not load: {problem}</p>}
    </div>
  );
}
