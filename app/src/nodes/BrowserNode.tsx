import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppKey } from '../../shared/apps';
import { getBrowser, restartBrowser, signedInBrowser, signInBrowser, signInDoneBrowser } from '../api';
import { listen } from '../bus';
import type { BrowserNodeType } from '../stage';
import { useFlushStage } from '../sync';
import { CardActions, Frame } from './Frame';

const GLOBE = <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M1.8 8h12.4M8 1.800c2 2 2 10.400 0 12.400M8 1.800c-2 2-2 10.400 0 12.400" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;
// A small mark per app, drawn in the card's own line so no brand colour shouts from the stage.
const ICONS: Record<AppKey, ReactNode> = {
  linkedin: <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="1.8" width="12.4" height="12.4" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M5.200 7v4.300M5.200 4.900v.1M7.600 11.300V7M7.600 8.900c0-1.200.8-1.900 1.800-1.900s1.600.7 1.600 1.900v2.400" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>,
  x: <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.600 2.500h3.300l7.500 11H10.100zM13.100 2.500 8.900 7.300M7 8.900l-4.200 4.600" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" /></svg>,
  gmail: <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="3.300" width="12.4" height="9.400" rx="1.600" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M2.300 4.200 8 8.700l5.700-4.500" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>,
  custom: GLOBE,
};
const WINDOW = <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="1.800" y="2.800" width="12.400" height="10.400" rx="1.600" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M1.800 5.800h12.400" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>;

// A live window onto the browser a wired person drives. It only watches: the session's frames arrive over a local socket.
export function BrowserNode({ id, data, selected }: NodeProps<BrowserNodeType>) {
  const { updateNodeData } = useReactFlow();
  const flushStage = useFlushStage();
  const watchNow = useRef<(restart?: boolean) => Promise<void>>(undefined);
  const [address, setAddress] = useState('');
  const [state, setState] = useState<'idle' | 'live' | 'problem'>('idle');
  const [problem, setProblem] = useState('');
  const screen = useRef<HTMLImageElement>(null);
  const socket = useRef<WebSocket>(null);
  const app = data.app;
  // Whether the founder is signed in to this app: null until the card has looked, or when the site gives no sign.
  const [status, setStatus] = useState<boolean | null>(null);
  // True while the founder's own Chrome is open on this card's profile to sign in.
  const [hand, setHand] = useState(false);

  // A signed-in card shows where its session is from the start; one that is not stays quiet and shows its copy.
  function heard(signedIn: boolean | null) {
    setStatus(signedIn);
    if (signedIn === true && socket.current?.readyState !== WebSocket.OPEN) void watchNow.current?.();
  }

  // Looked at once the card is on the stage, and again when the founder closes the window they signed in with.
  // A card just added from the dock is saved first, or the server would not know it yet.
  useEffect(() => {
    if (!app || data.headed) return;
    let gone = false;
    flushStage().then(() => signedInBrowser(id)).then((answer) => { if (!gone) { heard(answer.signedIn); setHand(!!answer.byHand); } }, () => { if (!gone) setStatus(null); });
    return () => { gone = true; };
  }, [id, app, data.headed, flushStage]);

  // The server cannot tell the page when that Chrome closes, so the card asks until it has.
  useEffect(() => {
    if (!hand) return;
    const timer = setInterval(() => {
      signedInBrowser(id).then((answer) => { if (!answer.byHand) { setHand(false); heard(answer.signedIn); } }, () => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [id, hand]);

  useEffect(() => {
    let gone = false;
    async function watch(restart = false) {
      try {
        const { port, url } = await (restart ? restartBrowser(id) : getBrowser(id));
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
    watchNow.current = watch;
    // The session starts when a person first uses it; until then the card stays quiet and costs nothing.
    const stop = listen('effect', (effect) => { if (effect.kind === 'browser-moved' && effect.id === id && socket.current?.readyState !== WebSocket.OPEN) void watch(); });
    return () => { gone = true; stop(); socket.current?.close(); };
  }, [id]);

  // Chrome decides at start whether it has a window, so the session restarts. Logins live in the card's profile and stay.
  async function showWindow(headed: boolean) {
    updateNodeData(id, { headed });
    await new Promise((settle) => setTimeout(settle, 0));
    await flushStage();
    await watchNow.current?.(true);
  }

  // The card's session closes so the founder's Chrome can have the profile; its live view goes quiet with it.
  async function signIn() {
    setHand(true);
    socket.current?.close();
    setState('idle');
    await flushStage();
    await signInBrowser(id).catch(() => setHand(false));
  }

  return (
    <Frame selected={!!selected} minWidth={320} minHeight={240}>
      <header className="card__header card__header--doc">
        {app ? ICONS[app.key] : GLOBE}
        <div className={`browser__address${app ? ' browser__address--app' : ''}`} title={address}>{app?.name || address || 'Browser'}</div>
        {app && hand && <span className="browser__status">Sign in there, then close it</span>}
        {app && !hand && status !== null && <span className={`browser__status${status ? ' is-in' : ''}`}>{status ? 'Signed in' : 'Not signed in'}</span>}
        {app ? (
          <>
            <button type="button" className={`browser__window nodrag${hand ? ' is-on' : ''}`} disabled={hand} title={`Open ${app.name} in your own Chrome with this card's profile and sign in there`} onClick={() => void signIn()}>
              {hand ? 'Chrome is open' : 'Sign in'}
            </button>
            {hand && <button type="button" className="browser__window nodrag" aria-label="I have signed in" title="Close that Chrome for you and check the sign-in" onClick={() => void signInDoneBrowser(id).catch(() => {})}>I have signed in</button>}
            <button type="button" className={`browser__window browser__window--icon nodrag${data.headed ? ' is-on' : ''}`} aria-pressed={!!data.headed} aria-label={data.headed ? 'Hide the live window' : 'Show the live window'} title="Show this card's own Chrome as a window, for a human check mid-task" disabled={hand} onClick={() => void showWindow(!data.headed)}>
              {WINDOW}
            </button>
          </>
        ) : (
          <button type="button" className={`browser__window nodrag${data.headed ? ' is-on' : ''}`} aria-pressed={!!data.headed} title={data.headed ? 'Hide the Chrome window' : 'Show the Chrome window, to sign in or pass a human check by hand'} onClick={() => void showWindow(!data.headed)}>
            {data.headed ? 'Window shown' : 'Show window'}
          </button>
        )}
        <CardActions id={id} what="this browser and its saved logins" />
      </header>
      <div className="browser nodrag">
        <img ref={screen} alt={address ? `Live view of ${address}` : ''} hidden={state !== 'live'} draggable={false} />
        {state === 'idle' && app && <p className="chat__empty">Press Sign in: your own Chrome opens on {app.name} with this card's profile. Sign in there, close that window, and the card keeps the login. Then wire a person: they act as you, one step at a time, and every Connect, Message or Post waits for your OK.</p>}
        {state === 'idle' && !app && <p className="chat__empty">Wire a person to this browser, then ask them to look something up. You will see every step here. It keeps its own logins: press Show window to sign in to an account you made for them.</p>}
        {state === 'problem' && <p className="chat__empty">{problem}</p>}
      </div>
    </Frame>
  );
}
