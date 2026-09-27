import { useSyncExternalStore } from 'react';

// What sits above the canvas, bottom first. A focused card is one card filling the window; a panel is one of the
// founder's views (needs you, messages, decisions…). Escape always removes the top one only.
export type Layer = { kind: 'focus'; id: string } | { kind: 'panel'; name: string };

const same = (a: Layer, b: Layer) => (a.kind === 'focus' ? b.kind === 'focus' : b.kind === 'panel' && a.name === b.name);
export const pushLayer = (stack: Layer[], layer: Layer): Layer[] => [...stack.filter((held) => !same(layer, held)), layer];
export const popLayer = (stack: Layer[]): Layer[] => stack.slice(0, -1);

// The overview is a side view: it slides in from the left edge and leaves the canvas beside it as it is, undimmed. Every
// other view is a sheet over a shade. The stack's top layer decides.
const SIDE = new Set(['dashboard']);
export const onSide = (layers: Layer[]) => { const top = layers.at(-1); return top?.kind === 'panel' && SIDE.has(top.name); };

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

// A card can be shown outside the canvas in two places: the focus sheet, and the conversation pane of the messages view.
// Either way it is the card's own DOM that moves there. It is not drawn a second time: a reply in flight, a draft and
// every other piece of its state stay exactly as they are.
export type Host = 'focus' | 'messages';
let thread: string | null = null;
const elements: Record<Host, HTMLElement | null> = { focus: null, messages: null };
export const showThread = (id: string | null) => { thread = id; set(stack); };
// Which decision the decisions view shows; 'new' is the empty form.
let decision: string | null = null;
export const showDecision = (id: string | null) => { decision = id; set(stack); };
export const useDecision = () => useSyncExternalStore(subscribe, () => decision);
// Which note from the library the reading view shows. One at a time, like a decision: it is a note being read, not
// a place in the app.
let note: string | null = null;
export const showNote = (id: string | null) => { note = id; set(stack); };
export const useNoteShown = () => useSyncExternalStore(subscribe, () => note);
// There is one playbook, so this says only where to look in it: the skill to open, and whose work to mark. Set when
// the panel is opened from a person's card or from the line a birth left in their chat; empty from the command bar.
let playbook: { skill?: string; roomId?: string } = {};
export const showPlaybook = (at: { skill?: string; roomId?: string }) => { playbook = at; set(stack); };
export const usePlaybookAt = () => useSyncExternalStore(subscribe, () => playbook);
export const useThread = () => useSyncExternalStore(subscribe, () => thread);
export const setHostElement = (host: Host) => (element: HTMLElement | null) => { if (elements[host] === element) return; elements[host] = element; set(stack); };

// Where this card lives right now: the topmost layer that asks for it wins; null is its own place on the canvas.
function hostOf(id: string): HTMLElement | null {
  for (const layer of [...stack].reverse()) {
    if (layer.kind === 'panel' && layer.name === 'messages' && thread === id) return elements.messages;
    if (layer.kind === 'focus' && layer.id === id) return elements.focus;
  }
  return null;
}
export const useHostElement = (id: string) => useSyncExternalStore(subscribe, () => hostOf(id));
