import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { spanOf, type Framework } from '../shared/frameworks';
import { getFrameworks, placeFramework } from './api';
import { overlay } from './overlay/store';
import { freeSpot } from './place';
import { toFlow, type StageNode } from './stage';
import { useFlushStage } from './sync';

// The founder's frameworks, as this window holds them: one list, shared by the panel and the selection menu, so the
// two can never disagree about what has been saved. The same shape as the library's own store next door.
let frameworks: Framework[] = [];
let asked = false;
const watchers = new Set<() => void>();
const subscribe = (tell: () => void) => { watchers.add(tell); return () => { watchers.delete(tell); }; };

export async function refreshFrameworks(): Promise<Framework[]> {
  frameworks = await getFrameworks().catch(() => frameworks);
  for (const tell of watchers) tell();
  return frameworks;
}
export function useFrameworks(): Framework[] {
  const held = useSyncExternalStore(subscribe, () => frameworks);
  useEffect(() => { if (!asked) { asked = true; void refreshFrameworks(); } }, []);
  return held;
}

export const openFrameworks = () => overlay.open({ kind: 'panel', name: 'frameworks' });
// Where a group lands when it is placed from the panel: the top-left of what the founder can see, with room to
// breathe, so the first person of the team is where their eye already is rather than off the edge somewhere.
export const MARGIN = 80;

// Placing a team, from wherever the founder asked for it (the frameworks panel, the dashboard). `landed` is called once
// the team is on the stage and saved, before the view moves to it, so the view that asked can step aside first.
export function usePlaceFramework() {
  const { fitBounds, getNodes, screenToFlowPosition, setNodes, setEdges } = useReactFlow<StageNode>();
  const flush = useFlushStage();
  return useCallback(async (framework: Framework, landed: () => void = () => {}) => {
    // The top-left of what the founder can see, with a margin — and then the nearest place that big where nothing
    // already stands, the same rule a single new card follows. A team dropped on top of the stage the founder
    // already has is five people they then have to dig out from behind their own cards.
    const corner = screenToFlowPosition({ x: MARGIN, y: MARGIN });
    const span = spanOf(framework);
    const at = freeSpot(getNodes(), { x: Math.round(corner.x), y: Math.round(corner.y) }, span.w, span.h);
    const { nodes, edges } = toFlow(await placeFramework(framework.id, at));
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...nodes.map((node) => ({ ...node, selected: true }))]);
    setEdges((current) => [...current, ...edges]);
    // Saved at once rather than after the quiet period: the server has already written the docs' words, and the
    // people it just minted have to exist on the stage before anybody can be asked anything. The wait is for the
    // canvas to have drawn them first — saving reads what is on it, not what is about to be.
    await new Promise((drawn) => { setTimeout(drawn, 0); });
    await flush();
    landed();
    // And the view moves to the team, whole: a group is wider than one card, so the founder should not have to go
    // looking for the five people they just asked for.
    void fitBounds({ x: at.x, y: at.y, width: span.w, height: span.h }, { duration: 400, padding: 0.12 });
  }, [fitBounds, getNodes, screenToFlowPosition, setNodes, setEdges, flush]);
}
