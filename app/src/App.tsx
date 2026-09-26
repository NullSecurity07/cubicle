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
import { feed } from './feed';
import { mergeStage, saveOver } from './stageSync';
import { STAGE_CHANNEL, type Stage } from '../shared/model';

// Built once: handed to the canvas inline, they would be new objects on every render, every drag frame included.
const FIT_VIEW = { padding: 0.15, maxZoom: 1 };
const PRO = { hideAttribution: true };

const sameStage = (a: Stage, b: Stage) => JSON.stringify({ ...a, rev: 0 }) === JSON.stringify({ ...b, rev: 0 });

function Canvas({ stage }: { stage: Stage }) {
  const [initial] = useState(() => toFlow(stage));
  const [nodes, setNodes, onNodesChange] = useNodesState<StageNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [connecting, setConnecting] = useState(false);
  const lastSaved = useRef(JSON.stringify(fromFlow(initial.nodes, initial.edges)));
  // The stage as the server last said it is, with its revision: every save is made on it, so a save over a stage
  // another window has changed since is refused, and this window takes that change in rather than undoing it.
  const base = useRef(stage);
  // Why the canvas as it is now is not on disk, while it is not. Cleared by the next save that lands.
  const [unsaved, setUnsaved] = useState('');
  const [failures, setFailures] = useState(0);
  // The save on its way, if one is: a caller that flushes while the same stage is still being put waits for that put
  // rather than being told "saved" at once, so a card added a moment ago is known to the server before its first read.
  const saving = useRef<Promise<void>>(Promise.resolve());

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

  // A stage from the server put on the canvas. A card that is the same as before keeps its node, so nothing the
  // founder has in hand (a selection, a measured size) is lost to a change made somewhere else.
  const show = useCallback((next: Stage) => {
    const flow = toFlow(next);
    const one = (node: StageNode) => JSON.stringify(fromFlow([node], []));
    setNodes((current) => flow.nodes.map((node) => {
      const held = current.find((was) => was.id === node.id);
      return held && one(held) === one(node) ? held : { ...node, ...(held?.selected ? { selected: true } : {}) };
    }));
    setEdges((current) => flow.edges.map((edge) => current.find((was) => was.id === edge.id && was.source === edge.source && was.target === edge.target && was.sourceHandle === edge.sourceHandle && was.targetHandle === edge.targetHandle) ?? edge));
  }, [setNodes, setEdges]);

  // Layout, sizes and wires save themselves shortly after they stop changing; `save` can also be called at once.
  // Saves go one after another: each is made on the revision the one before it left, never two on the same one.
  const save = useCallback(() => {
    const run = saving.current.catch(() => {}).then(async () => {
      const stage = fromFlow(latest.current.nodes, latest.current.edges);
      const text = JSON.stringify(stage);
      if (text === lastSaved.current) return;
      lastSaved.current = text;
      try {
        const out = await saveOver(base.current, stage, putStage);
        // Only ever forward: the stage may have moved on again, and this window heard it, while this save was out.
        if ((out.base.rev ?? 0) > (base.current.rev ?? 0)) base.current = out.base;
        if (out.merged) {
          // Put together once more with the canvas as it is now, not as it was when this save set out: whatever the
          // founder did while the save was out (a drag, a new card) stays, and the next save carries it.
          const shown = mergeStage(stage, fromFlow(latest.current.nodes, latest.current.edges), out.merged);
          lastSaved.current = out.saved && sameStage(shown, out.merged) ? JSON.stringify({ ...out.merged, rev: undefined }) : '';
          show(shown);
        }
        if (!out.saved) throw new Error('the stage kept changing in another window');
        setUnsaved('');
        setFailures(0);
      } catch (error) {
        lastSaved.current = '';
        setUnsaved((error as Error).message || 'the server did not answer');
        setFailures((count) => count + 1);
        throw error;
      }
    });
    saving.current = run;
    return run;
  }, [show]);
  useEffect(() => {
    const timer = setTimeout(() => save().catch(() => {}), 400);
    return () => clearTimeout(timer);
  }, [nodes, edges, save]);
  // A save that did not land is tried again every few seconds until one does, changed canvas or not. Keyed on the
  // count of failures, not the message: the same failure twice running still has to set the next try going.
  useEffect(() => {
    if (!failures) return;
    const timer = setTimeout(() => save().catch(() => {}), 5000);
    return () => clearTimeout(timer);
  }, [failures, save]);

  // Another window saved, or a person put something on the stage: this window takes it in as it happens, keeping
  // whatever the founder has changed here and not yet saved, and then saves that on top of it.
  useEffect(() => feed<Stage>(STAGE_CHANNEL, (theirs) => {
    if ((theirs.rev ?? 0) <= (base.current.rev ?? 0)) return;
    const mine = fromFlow(latest.current.nodes, latest.current.edges);
    const merged = mergeStage(base.current, mine, theirs);
    base.current = theirs;
    if (!sameStage(merged, mine)) show(merged);
    if (sameStage(merged, theirs)) lastSaved.current = JSON.stringify({ ...merged, rev: undefined });
    else save().catch(() => {});
  }), [show, save]);

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
    {unsaved && <p className="stage__unsaved" role="status">Not saved: {unsaved}. Trying again…</p>}
    </SyncContext.Provider>
  );
}

export default function App() {
  const [initial, setInitial] = useState<Stage | null>(null);
  const [problem, setProblem] = useState('');

  // The founder's own keys, if they wrote any. Without them, or without an answer, every key is the table's.
  useEffect(() => { getKeys().then((found) => setOverrides(found.keys)).catch(() => {}); }, []);
  useEffect(() => { getStage().then(setInitial).catch((error: Error) => setProblem(error.message)); }, []);

  return (
    <div className="stage">
      {initial && <Canvas stage={initial} />}
      {problem && <p className="stage__problem">The stage could not load: {problem}</p>}
    </div>
  );
}
