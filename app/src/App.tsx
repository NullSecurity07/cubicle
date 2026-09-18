import {
  Background, BackgroundVariant, ConnectionLineType, ConnectionMode, ReactFlow,
  addEdge, useEdgesState, useNodesState, type Connection, type Edge,
} from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getStage, putStage } from './api';
import { edgeTypes } from './edges';
import { nodeTypes } from './nodes';
import { WIRE, fromFlow, toFlow, type StageNode } from './stage';

function Canvas({ initial }: { initial: ReturnType<typeof toFlow> }) {
  const [nodes, , onNodesChange] = useNodesState<StageNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [connecting, setConnecting] = useState(false);
  const lastSaved = useRef(JSON.stringify(fromFlow(initial.nodes, initial.edges)));

  const onConnect = useCallback(
    (connection: Connection) => setEdges((current) => addEdge({ ...connection, ...WIRE }, current)),
    [setEdges],
  );

  // Layout, sizes and wires save themselves shortly after they stop changing.
  useEffect(() => {
    const timer = setTimeout(() => {
      const stage = fromFlow(nodes, edges);
      const text = JSON.stringify(stage);
      if (text === lastSaved.current) return;
      lastSaved.current = text;
      void putStage(stage);
    }, 400);
    return () => clearTimeout(timer);
  }, [nodes, edges]);

  return (
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
    </ReactFlow>
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
