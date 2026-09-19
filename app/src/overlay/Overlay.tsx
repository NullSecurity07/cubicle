import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import { NeedsPanel } from './NeedsPanel';
import { CommandBar, KeysSheet } from './CommandBar';
import { DecisionsPanel } from './DecisionsPanel';
import { MessagesPanel } from './MessagesPanel';
import { overlay, setHostElement, useLayers } from './store';

// The founder's views, by layer name.
const PANELS: Record<string, () => React.JSX.Element> = { needs: NeedsPanel, messages: MessagesPanel, decisions: DecisionsPanel, command: CommandBar, keys: KeysSheet };
// Single keys that open a view, when nothing is open and nobody is typing.
const OPENERS: Record<string, string> = { n: 'needs', m: 'messages', d: 'decisions', '/': 'command', '?': 'keys' };
const focusHost = setHostElement('focus');

const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
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
      if (event.key === 'Escape' && overlay.layers().length && !(event.target instanceof Element && event.target.closest('[data-holds-escape]'))) { event.preventDefault(); overlay.back(); return; }
      if (event.key === 'Tab' && overlay.layers().length && top.current) {
        const stops = [...top.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((stop) => stop.offsetParent !== null);
        if (!stops.length) return;
        const [first, last] = [stops[0], stops[stops.length - 1]];
        const inside = top.current.contains(document.activeElement);
        if (!inside || (event.shiftKey && document.activeElement === first)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        return;
      }
      // Ctrl K opens the command bar from anywhere, even while typing.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); overlay.open({ kind: 'panel', name: 'command' }); return; }
      const opener = OPENERS[event.key.length === 1 ? event.key.toLowerCase() : ''];
      if (opener && !event.ctrlKey && !event.metaKey && !event.altKey && !typing(event.target) && (!overlay.layers().length || (opener === 'keys' && overlay.layers().at(-1)?.kind !== 'panel'))) { event.preventDefault(); overlay.open({ kind: 'panel', name: opener }); return; }
      if (event.key.toLowerCase() !== 'f' || event.ctrlKey || event.metaKey || event.altKey || typing(event.target) || overlay.layers().length) return;
      const chosen = getNodes().filter((node) => node.selected);
      if (chosen.length === 1) { event.preventDefault(); overlay.open({ kind: 'focus', id: chosen[0].id }); }
    }
    // Capture: a focused card keeps its keys from the canvas below, and this must still hear them.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [getNodes]);

  // A focused card is not a selected card: no resize grips behind the shade, and Backspace removes nothing.
  useEffect(() => { if (focused) setNodes((nodes) => nodes.map((node) => (node.selected ? { ...node, selected: false } : node))); }, [focused, setNodes]);

  return createPortal(
    <div className={`overlay${layers.length ? ' is-open' : ''}`} ref={top}>
      <div className="overlay__shade" onClick={() => overlay.back()} />
      <div className="focus__sheet" ref={focusHost} hidden={!focused || !!View} role="dialog" aria-modal="true" aria-label="Focused card" />
      {View && <View />}
    </div>,
    document.body,
  );
}
