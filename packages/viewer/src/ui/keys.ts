/** One shortcut table drives the key handler and the "?" sheet. Escape belongs to the panel (ui/panel.ts). */
import type { View } from './content.js';

export type Action = 'floor1' | 'floor2' | 'floor3' | 'floor4' | 'lobby' | 'fit' | 'talk' | 'queue' | 'brief' | 'plan' | 'org' | 'pause' | 'prev' | 'next' | 'minimap' | 'help' | 'quickopen';
/** `back` is listed for the sheet only: Escape is handled by the panel itself. */
export const SHORTCUTS: { keys: string; action: Action | 'back'; label: string }[] = [
  { keys: '1 2 3 4', action: 'floor1', label: 'Go to floor 1–4' },
  { keys: 'L', action: 'lobby', label: 'Go to the lobby' },
  { keys: '0', action: 'fit', label: 'Fit the whole tower' },
  { keys: 'T', action: 'talk', label: 'Talk to the CEO' },
  { keys: 'Q', action: 'queue', label: 'Queue' },
  { keys: 'B', action: 'brief', label: 'Latest brief' },
  { keys: 'P', action: 'plan', label: 'Plan' },
  { keys: 'O', action: 'org', label: 'Org' },
  { keys: 'M', action: 'minimap', label: 'Show or hide the minimap' },
  { keys: 'Space', action: 'pause', label: 'Pause or play the replay' },
  { keys: 'Left Right', action: 'prev', label: 'Step the replay one event' },
  { keys: 'Ctrl K  /', action: 'quickopen', label: 'Quick open' },
  { keys: '?', action: 'help', label: 'This sheet' },
  { keys: 'Esc', action: 'back', label: 'Back one level' },
];
const PLAIN: Record<string, Action> = { '1': 'floor1', '2': 'floor2', '3': 'floor3', '4': 'floor4', l: 'lobby', '0': 'fit', t: 'talk', q: 'queue', b: 'brief', p: 'plan', o: 'org', ' ': 'pause', ArrowLeft: 'prev', ArrowRight: 'next', m: 'minimap', '?': 'help', '/': 'quickopen' };

/** The action for a key event, or null. `typing` = the event target is a text field (then only Ctrl/Cmd+K counts). */
export function shortcutFor(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, typing: boolean): Action | null {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') return 'quickopen';
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;   // 'L' and 'l' both go to the lobby; 'ArrowLeft' stays as is
  return PLAIN[k] ?? null;
}

const isTyping = (t: EventTarget | null): boolean => { const el = t as HTMLElement | null; return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable); };

export function bindKeys(handlers: Record<Action, () => void>): () => void {
  const on = (e: KeyboardEvent): void => { const a = shortcutFor(e, isTyping(e.target)); if (!a) return; e.preventDefault(); handlers[a](); };
  window.addEventListener('keydown', on);
  return () => window.removeEventListener('keydown', on);
}

export function keysView(): View {
  const rows = SHORTCUTS.map((s) => `<div>${s.keys.split(/\s+/).map((k) => `<kbd>${k}</kbd>`).join(' ')}</div><div>${s.label}</div>`).join('');
  return { mode: 'drawer', title: 'Shortcuts', sub: 'Every control works by keyboard', html: `<div class="keys">${rows}</div>` };
}
