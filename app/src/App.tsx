import {
  Background, BackgroundVariant, ConnectionLineType, ConnectionMode, ReactFlow,
  addEdge, useEdgesState, useNodesState, type Connection, type Edge,
} from '@xyflow/react';
import { useCallback, useState } from 'react';
import { edgeTypes } from './edges';
import { nodeTypes } from './nodes';
import { WIRE, stageEdges, stageNodes, type StageNode } from './stage';

export default function App() {
  const [nodes, , onNodesChange] = useNodesState<StageNode>(stageNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(stageEdges);
  const [connecting, setConnecting] = useState(false);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((current) => addEdge({ ...connection, ...WIRE }, current)),
    [setEdges],
  );

  return (
    <div className={connecting ? 'stage connecting' : 'stage'}>
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
        connectionMode={ConnectionMode.Loose}
        connectionLineType={ConnectionLineType.SmoothStep}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="rgba(255, 255, 255, 0.16)" bgColor="transparent" />
      </ReactFlow>
    </div>
  );
}
