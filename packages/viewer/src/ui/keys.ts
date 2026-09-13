/** One shortcut table drives the key handler and the "?" sheet. Escape belongs to the panel (ui/panel.ts). */
import type { View } from './content.js';

export type Action = 'floor1' | 'floor2' | 'floor3' | 'floor4' | 'lobby' | 'fit' | 'talk' | 'messages' | 'queue' | 'brief' | 'plan' | 'org' | 'pause' | 'prev' | 'next' | 'minimap' | 'help' | 'quickopen';
/** `back` is listed for the sheet only: Escape is handled by the panel itself. */
export const SHORTCUTS: { keys: string; action: Action | 'back'; label: string }[] = [
  { keys: '1 2 3 4', action: 'floor1', label: 'Go to floor 1–4' },
  { keys: 'L', action: 'lobby', label: 'Go to the lobby' },
  { keys: '0', action: 'fit', label: 'Fit the whole tower' },
  { keys: 'T', action: 'talk', label: 'Talk to the CEO' },
  { keys: 'C', action: 'messages', label: 'Messages' },
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
const PLAIN: Record<string, Action> = { '1': 'floor1', '2': 'floor2', '3': 'floor3', '4': 'floor4', l: 'lobby', '0': 'fit', t: 'talk', c: 'messages', q: 'queue', b: 'brief', p: 'plan', o: 'org', ' ': 'pause', ArrowLeft: 'prev', ArrowRight: 'next', m: 'minimap', '?': 'help', '/': 'quickopen' };

/** The action for a key event, or null. `typing` = the event target is a text field (then only Ctrl/Cmd+K counts). */
export function shortcutFor(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, typing: boolean): Action | null {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') return 'quickopen';
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;   // 'L' and 'l' both go to the lobby; 'ArrowLeft' stays as is
  return PLAIN[k] ?? null;
}

const isTyping = (t: EventTarget | null): boolean => { const el = t as HTMLElement | null; return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable); };

/** A focused button, tab or link owns Space and Enter: the replay toggle must not swallow the activation. */
export const isControl = (t: { closest?(sel: string): unknown } | null): boolean => !!t?.closest?.('button, a, [role="button"], [role="tab"]');

/**
 * `blocked()` is the app's modals: the first-run card and the quick-open palette, both `aria-modal`. Focus starts in
 * a text field in each, so `isTyping` covered the common case — but one Tab moves focus onto "Surprise me" or a
 * quick-open result, and `T` then opened the cabin sheet *under* the card while `1`-`4` flew the camera.
 */
export function bindKeys(handlers: Record<Action, () => void>, blocked: () => boolean = () => false): () => void {
  const on = (e: KeyboardEvent): void => {
    if (blocked()) return;
    const a = shortcutFor(e, isTyping(e.target));
    if (!a) return;
    if (a === 'pause' && isControl(e.target as HTMLElement | null)) return;   // Space activates the control under the focus ring
    e.preventDefault(); handlers[a]();
  };
  window.addEventListener('keydown', on);
  return () => window.removeEventListener('keydown', on);
}

/** What a Tab may land on inside a modal element. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** A tab stop. `hidden`/`offsetParent` are the panel's: its header buttons and chat composer come and go. */
export interface Focusable { focus(): void; hidden?: boolean; offsetParent?: unknown }

/**
 * Keep Tab inside `root` — the first-run card, the quick-open palette and the reader/viewer presentations are all
 * `aria-modal`. Returns true when it handled the event (it always stops propagation then, so a window-level
 * listener under it never sees the Tab).
 *
 * Elements that are `hidden` or laid out nowhere are skipped: the panel's back chevron, Obsidian link, Copy button
 * and chat composer all come and go, and a cycle that stops on one of them looks to the owner like a dead Tab.
 */
export function trapTab(root: { querySelectorAll(sel: string): ArrayLike<Focusable> }, e: { key: string; shiftKey?: boolean; preventDefault(): void; stopPropagation(): void }, active: Focusable | null): boolean {
  if (e.key !== 'Tab') return false;
  e.preventDefault(); e.stopPropagation();
  const items = Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => !el.hidden && el.offsetParent !== null);
  if (!items.length) return true;
  const at = active ? items.indexOf(active) : -1;
  items[(((at < 0 ? 0 : at + (e.shiftKey ? -1 : 1)) % items.length) + items.length) % items.length].focus();
  return true;
}

export function keysView(): View {
  const rows = SHORTCUTS.map((s) => `<div>${s.keys.split(/\s+/).map((k) => `<kbd>${k}</kbd>`).join(' ')}</div><div>${s.label}</div>`).join('');
  return { mode: 'drawer', title: 'Shortcuts', sub: 'Every control works by keyboard', html: `<div class="keys">${rows}</div>` };
}
