import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import { NeedsPanel } from './NeedsPanel';
import { CommandBar } from './CommandBar';
import { Cheatsheet } from './Cheatsheet';
import { Dashboard } from './Dashboard';
import { DecisionsPanel } from './DecisionsPanel';
import { Guard } from './Guard';
import { MessagesPanel } from './MessagesPanel';
import { FrameworksPanel } from '../nodes/FrameworksPanel';
import { LibraryPanel, NotePanel } from '../nodes/LibraryPanel';
import { PlaybookPanel } from '../nodes/PlaybookPanel';
import { SLICES } from '../slices';
import { held, pressed } from '../keys';
import { overlay, setHostElement, useLayers } from './store';

// The founder's views, by layer name.
const PANELS: Record<string, () => React.JSX.Element> = { needs: NeedsPanel, messages: MessagesPanel, decisions: DecisionsPanel, playbook: PlaybookPanel, library: LibraryPanel, note: NotePanel, frameworks: FrameworksPanel, command: CommandBar, keys: Cheatsheet, dashboard: Dashboard };
// Keys that open a view, when nothing is open and nobody is typing, and the view each one opens.
const opens = (event: KeyboardEvent) => (pressed(event, 'needs') ? 'needs' : pressed(event, 'messages') ? 'messages' : pressed(event, 'decisions') ? 'decisions'
  : pressed(event, 'command-bar-slash') ? 'command' : pressed(event, 'cheatsheet') ? 'keys' : null);
const focusHost = setHostElement('focus');

// A browser card's live page takes every key while it is focused, as a text field would.
const live = (target: EventTarget | null) => target instanceof Element && !!target.closest('.browser__live');
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || live(target));
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Everything that sits above the canvas: a shade, and the sheet a focused card moves into. The canvas stays as it
// is underneath. Escape goes back one level; F focuses the selected card; Tab stays inside the top layer.
export function Overlay() {
  const layers = useLayers();
  const { getNodes, setNodes } = useReactFlow();
  const top = useRef<HTMLDivElement>(null);
  const focused = layers.some((layer) => layer.kind === 'focus');
  const panel = layers.at(-1)?.kind === 'panel' ? (layers.at(-1) as { name: string }).name : null;
  const View = panel ? PANELS[panel] : null;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Something inside the layer may hold Escape for itself first (an edit in progress): it goes back one thing at a time.
      if (pressed(event, 'back') && overlay.layers().length && !(event.target instanceof Element && event.target.closest('[data-holds-escape]'))) { event.preventDefault(); overlay.back(); return; }
      if (pressed(event, 'next-stop') && overlay.layers().length && top.current && !live(event.target)) {
        const stops = [...top.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((stop) => stop.offsetParent !== null);
        if (!stops.length) return;
        const [first, last] = [stops[0], stops[stops.length - 1]];
        const inside = top.current.contains(document.activeElement);
        if (!inside || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        return;
      }
      // The command bar opens from anywhere, even while typing.
      if (pressed(event, 'command-bar')) { event.preventDefault(); overlay.open({ kind: 'panel', name: 'command' }); return; }
      // The dashboard opens from anywhere too, and closes again when it is the view on top.
      if (pressed(event, 'dashboard') && !live(event.target)) {
        event.preventDefault();
        const top = overlay.layers().at(-1);
        if (top?.kind === 'panel' && top.name === 'dashboard') overlay.back(); else overlay.open({ kind: 'panel', name: 'dashboard' });
        return;
      }
      // The sheet may also open over a focused card, never over another view, and with ⌘ or Ctrl even from a field.
      const opener = opens(event);
      if (opener && (!typing(event.target) || (opener === 'keys' && held(event))) && (!overlay.layers().length || (opener === 'keys' && overlay.layers().at(-1)?.kind !== 'panel'))) { event.preventDefault(); overlay.open({ kind: 'panel', name: opener }); return; }
      if (!pressed(event, 'focus-card') || typing(event.target) || overlay.layers().length) return;
      const chosen = getNodes().filter((node) => node.selected);
      if (chosen.length === 1) { event.preventDefault(); overlay.open({ kind: 'focus', id: chosen[0].id }); }
    }
    // Capture: a focused card keeps its keys from the canvas below, and this must still hear them.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [getNodes]);

  // A focused card is not a selected card: no resize grips behind the shade, and Backspace removes nothing.
  useEffect(() => { if (focused) setNodes((nodes) => nodes.map((node) => (node.selected ? { ...node, selected: false } : node))); }, [focused, setNodes]);

  // Each UI slice's own view is mounted beside the shade, not under it: `.overlay` is hidden whenever no layer is
  // open, and a slice decides for itself when it is on screen. With no slices there is nothing here to render.
  return createPortal(
    <>
      <div className={`overlay${layers.length ? ' is-open' : ''}`} ref={top}>
        <div className="overlay__shade" onClick={() => overlay.back()} />
        <div className="focus__sheet" ref={focusHost} hidden={!focused || !!View} role="dialog" aria-modal="true" aria-label="Focused card" />
        {View && panel && <Guard name={panel} onClose={() => overlay.back()}><View /></Guard>}
      </div>
      {SLICES.map((slice) => (slice.overlay ? <Guard key={slice.name} name={slice.name} quiet><slice.overlay /></Guard> : null))}
    </>,
    document.body,
  );
}
