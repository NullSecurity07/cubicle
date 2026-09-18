import type { NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { getBrowser } from '../api';
import { listen } from '../bus';
import type { BrowserNodeType } from '../stage';
import { CardActions, Frame } from './Frame';

// A live window onto the browser a wired person drives. It only watches: the session's frames arrive over a local socket.
export function BrowserNode({ id, selected }: NodeProps<BrowserNodeType>) {
  const [address, setAddress] = useState('');
  const [state, setState] = useState<'idle' | 'live' | 'problem'>('idle');
  const [problem, setProblem] = useState('');
  const screen = useRef<HTMLImageElement>(null);
  const socket = useRef<WebSocket>(null);

  useEffect(() => {
    let gone = false;
    async function watch() {
      try {
        const { port, url } = await getBrowser(id);
        if (gone) return;
        setAddress(/^about:/.test(url) ? '' : url);
        socket.current?.close();
        const next = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.current = next;
        next.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as { type?: string; data?: string; tabs?: { active: boolean; url: string }[] };
          if (message.type === 'frame' && typeof message.data === 'string' && message.data) {
            // Decode off-screen first: a frame cut short by a navigation must never replace the last good picture.
            const frame = new Image();
            frame.onload = () => { if (!gone && screen.current) { screen.current.src = frame.src; setState('live'); } };
            frame.src = `data:image/jpeg;base64,${message.data}`;
          }
          const tab = message.tabs?.find((one) => one.active);
          if (tab) setAddress(/^about:/.test(tab.url) ? '' : tab.url);
        };
        next.onerror = () => { if (!gone) { setState('problem'); setProblem('The live view dropped. It returns the next time this browser is used.'); } };
      } catch (error) {
        if (!gone) { setState('problem'); setProblem((error as Error).message); }
      }
    }
    // The session starts when a person first uses it; until then the card stays quiet and costs nothing.
    const stop = listen('effect', (effect) => { if (effect.kind === 'browser-moved' && effect.id === id && socket.current?.readyState !== WebSocket.OPEN) void watch(); });
    return () => { gone = true; stop(); socket.current?.close(); };
  }, [id]);

  return (
    <Frame selected={!!selected} minWidth={320} minHeight={240}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M1.8 8h12.4M8 1.800c2 2 2 10.400 0 12.400M8 1.800c-2 2-2 10.400 0 12.400" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
        <div className="browser__address" title={address}>{address || 'Browser'}</div>
        <CardActions id={id} what="this browser" />
      </header>
      <div className="browser nodrag">
        <img ref={screen} alt={address ? `Live view of ${address}` : ''} hidden={state !== 'live'} draggable={false} />
        {state === 'idle' && <p className="chat__empty">Wire a person to this browser, then ask them to look something up. You will see every step here.</p>}
        {state === 'problem' && <p className="chat__empty">{problem}</p>}
      </div>
    </Frame>
  );
}
