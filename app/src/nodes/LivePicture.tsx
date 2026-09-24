import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref, type WheelEvent } from 'react';
import { getBrowser, restartBrowser } from '../api';
import { notePage } from '../where';
import { listen } from '../bus';
import { overlay, useFocused } from '../overlay/store';
import { keyMessage, mouseMessage, toFrame, type MouseKind, type Point } from './live';
import { keyHint, pressed } from '../keys';

const LARGE = <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M9.500 2.500h4v4M13.500 2.500 9 7M6.500 13.500h-4v-4M2.500 13.500 7 9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;

// What a card with extra controls asks of its live picture: start watching (again, after a restart), or go quiet.
export type LiveControl = { watch: (restart?: boolean) => Promise<void>; stop: () => void; open: () => boolean };

// The header icon that opens a card's live picture large, hidden while it already is.
export function OpenLarge({ id }: { id: string }) {
  if (useFocused(id)) return null;
  return (
    <button type="button" className="browser__window browser__window--icon nodrag" aria-label="Open large" title="Open this page large, to read and act on it" onClick={() => overlay.open({ kind: 'focus', id })}>
      {LARGE}
    </button>
  );
}

// A live window onto a card's browser session. Frames arrive over a local socket, and the founder's clicks and keys go back on it.
// It starts when a person first uses the session, so until then the card stays quiet and costs nothing.
export function LivePicture({ id, kind, address, onAddress, idle, control }: { id: string; kind: 'browser' | 'source'; address?: string; onAddress?: (url: string) => void; idle?: ReactNode; control?: Ref<LiveControl> }) {
  const [state, setState] = useState<'idle' | 'live' | 'problem'>('idle');
  const [problem, setProblem] = useState('');
  const screen = useRef<HTMLImageElement>(null);
  const socket = useRef<WebSocket>(null);
  const watchNow = useRef<(restart?: boolean) => Promise<void>>(undefined);
  // The page's own size, from the latest frame: the picture is scaled, the page is not.
  const page = useRef({ width: 0, height: 0 });
  const [acting, setActing] = useState(false);
  const lastMove = useRef(0);
  const lastPoint = useRef<Point | null>(null);
  // Read through a ref so a new callback from the card never restarts the socket.
  const told = useRef(onAddress);
  told.current = onAddress;

  useImperativeHandle(control, () => ({
    watch: (restart?: boolean) => watchNow.current?.(restart) ?? Promise.resolve(),
    stop: () => { socket.current?.close(); setState('idle'); },
    open: () => socket.current?.readyState === WebSocket.OPEN,
  }), []);

  useEffect(() => {
    let gone = false;
    const say = (url: string) => { const page = /^about:/.test(url) ? '' : url; notePage(id, page); told.current?.(page); };
    async function watch(restart = false) {
      try {
        const { port, url } = await (restart ? restartBrowser(id) : getBrowser(id));
        if (gone) return;
        say(url);
        socket.current?.close();
        const next = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.current = next;
        next.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type?: string; data?: string; tabs?: { active: boolean; url: string }[]; metadata?: { deviceWidth?: number; deviceHeight?: number } };
          if (message.metadata?.deviceWidth && message.metadata.deviceHeight) page.current = { width: message.metadata.deviceWidth, height: message.metadata.deviceHeight };
          if (message.type === 'frame' && typeof message.data === 'string' && message.data) {
            // Decode off-screen first: a frame cut short by a navigation must never replace the last good picture.
            const frame = new Image();
            frame.onload = () => { if (!gone && screen.current) { screen.current.src = frame.src; setState('live'); } };
            frame.src = `data:image/jpeg;base64,${message.data}`;
          }
          const tab = message.tabs?.find((one) => one.active);
          if (tab) say(tab.url);
        };
        next.onerror = () => {
          if (gone) return;
          setState('problem');
          setProblem(kind === 'source' ? 'The live view dropped. It returns the next time a person searches this site.' : 'The live view dropped. It returns the next time this browser is used.');
        };
      } catch (error) {
        if (!gone) { setState('problem'); setProblem((error as Error).message); }
      }
    }
    watchNow.current = watch;
    const stop = listen('effect', (effect) => { if (effect.kind === 'browser-moved' && effect.id === id && socket.current?.readyState !== WebSocket.OPEN) void watch(); });
    return () => { gone = true; stop(); socket.current?.close(); };
  }, [id, kind]);

  const send = (message: object) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message)); };

  function pointAt(event: { clientX: number; clientY: number }): Point | null {
    const picture = screen.current;
    if (!picture) return null;
    const box = picture.getBoundingClientRect();
    const frame = page.current.width ? page.current : { width: picture.naturalWidth, height: picture.naturalHeight };
    // The card can sit in a zoomed canvas, so the box is measured on screen and the offset scaled to its layout size.
    const zoom = picture.offsetWidth ? box.width / picture.offsetWidth : 1;
    return toFrame({ x: (event.clientX - box.left) / zoom, y: (event.clientY - box.top) / zoom }, { width: picture.offsetWidth, height: picture.offsetHeight }, frame);
  }

  function mouse(event: PointerEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>, which: MouseKind) {
    // A release outside the picture still lands where the pointer last was, so the page never keeps a button held.
    const point = pointAt(event) ?? (which === 'mouseReleased' ? lastPoint.current : null);
    if (!point) return;
    lastPoint.current = point;
    send(mouseMessage({ button: 'button' in event ? event.button : 0, detail: event.detail, deltaX: 'deltaX' in event ? event.deltaX : 0, deltaY: 'deltaY' in event ? event.deltaY : 0, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }, point, which));
  }

  function key(event: KeyboardEvent<HTMLImageElement>, down: boolean) {
    if (pressed(event, 'leave-page')) { if (down) { event.preventDefault(); event.currentTarget.blur(); } return; }
    event.preventDefault();
    event.stopPropagation();
    send(keyMessage(event, down ? 'keyDown' : 'keyUp'));
  }

  return (
    <div className={`browser browser--${kind} nodrag`} data-live={state} data-address={address || undefined}>
      <img
        ref={screen}
        className={`browser__live nokey nowheel nopan${acting ? ' is-acting' : ''}`}
        role="application"
        aria-label={`Live page. Click to act on it; type when it is focused; ${keyHint('leave-page')} to stop.`}
        tabIndex={0}
        hidden={state !== 'live'}
        draggable={false}
        {...(acting ? { 'data-holds-escape': '' } : {})}
        onFocus={() => setActing(true)}
        onBlur={() => setActing(false)}
        onPointerDown={(event) => { event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); mouse(event, 'mousePressed'); }}
        onPointerUp={(event) => mouse(event, 'mouseReleased')}
        onPointerMove={(event) => {
          // About thirty moves a second is smooth for hover menus without flooding the socket.
          if (event.timeStamp - lastMove.current < 33) return;
          lastMove.current = event.timeStamp;
          mouse(event, 'mouseMoved');
        }}
        onWheel={(event) => mouse(event, 'mouseWheel')}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => key(event, true)}
        onKeyUp={(event) => key(event, false)}
      />
      {acting && state === 'live' && <p className="browser__typing" role="status">Typing goes to the page. {keyHint('leave-page')} to stop.</p>}
      {state === 'idle' && idle}
      {state === 'problem' && <p className="chat__empty">{problem}</p>}
    </div>
  );
}
