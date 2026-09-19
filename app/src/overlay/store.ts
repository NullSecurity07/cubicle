import { useSyncExternalStore } from 'react';

// What sits above the canvas, bottom first. A focused card is one card filling the window; a panel is one of the
// founder's views (needs you, messages, decisions…). Escape always removes the top one only.
export type Layer = { kind: 'focus'; id: string } | { kind: 'panel'; name: string };

const same = (a: Layer, b: Layer) => (a.kind === 'focus' ? b.kind === 'focus' : b.kind === 'panel' && a.name === b.name);
export const pushLayer = (stack: Layer[], layer: Layer): Layer[] => [...stack.filter((held) => !same(layer, held)), layer];
export const popLayer = (stack: Layer[]): Layer[] => stack.slice(0, -1);

let stack: Layer[] = [];
const watchers = new Set<() => void>();
const set = (next: Layer[]) => { stack = next; for (const tell of watchers) tell(); };
const subscribe = (tell: () => void) => { watchers.add(tell); return () => { watchers.delete(tell); }; };

export const overlay = {
  open: (layer: Layer) => set(pushLayer(stack, layer)),
  back: () => set(popLayer(stack)),
  close: (layer: Layer) => set(stack.filter((held) => !(same(layer, held) && (layer.kind !== 'focus' || (held.kind === 'focus' && held.id === layer.id))))),
  layers: () => stack,
};

export const useLayers = () => useSyncExternalStore(subscribe, overlay.layers);
export const useFocused = (id: string) => useSyncExternalStore(subscribe, () => stack.some((layer) => layer.kind === 'focus' && layer.id === id));

// Where a focused card's own DOM is moved to. The card is not drawn a second time: a reply in flight, a draft and
// every other piece of its state stay exactly as they are.
let sheet: HTMLElement | null = null;
export const setFocusSheet = (element: HTMLElement | null) => { sheet = element; };
export const focusSheet = () => sheet;
