import { useEffect, useSyncExternalStore } from 'react';
import type { Framework } from '../shared/frameworks';
import { getFrameworks } from './api';
import { overlay } from './overlay/store';

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
