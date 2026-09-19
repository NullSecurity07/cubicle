import type { ToolEffect } from '../shared/model';

// Carries what a person's tool changed from their chat to the cards that show it, and tells the dock that usage moved.
// `ask` puts a question into one person's own ask box, from elsewhere in the window (the command bar).
type Events = { effect: ToolEffect & { roomId: string }; usage: null; ask: { roomId: string; text: string } };
const target = new EventTarget();

export function emit<K extends keyof Events>(type: K, detail: Events[K]) {
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

export function listen<K extends keyof Events>(type: K, handler: (detail: Events[K]) => void) {
  const wrapped = (event: Event) => handler((event as CustomEvent<Events[K]>).detail);
  target.addEventListener(type, wrapped);
  return () => target.removeEventListener(type, wrapped);
}
