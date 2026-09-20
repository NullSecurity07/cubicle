import { useEffect, useRef, useState } from 'react';
import { getReach, listen } from './api';
import { EARS_SIZE, heardOnce, record, useVoiceOn, type Recording } from './voice';

const MIC = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.4a1.9 1.9 0 0 1 1.9 1.9v3.3a1.9 1.9 0 0 1-3.8 0V4.3A1.9 1.9 0 0 1 8 2.4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4.3 7.6a3.7 3.7 0 0 0 7.4 0M8 11.3v2.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
// Long enough to be a press, short enough that a tap leaves it listening.
const HELD = 450;
const REFUSED = 'This window was not allowed to use the microphone. Allow it for this page and try again.';

// Saying it instead of typing it. The words land in the ask box for the founder to read: nothing said here is ever
// sent on its own. Hold the button and talk, or tap it and talk until you tap it again.
export function Mic({ insert, busy }: { roomId: string; insert(text: string): void; busy: boolean }) {
  const on = useVoiceOn();
  const [state, setState] = useState<'idle' | 'listening' | 'hearing'>('idle');
  const [note, setNote] = useState('');
  const taking = useRef<Recording | null>(null);
  const pressed = useRef(0);
  const bypointer = useRef(false);

  useEffect(() => () => taking.current?.cancel(), []);
  if (!on) return null;

  async function begin() {
    if (taking.current) return;
    setNote(heardOnce() ? 'listening…' : `listening… the words are worked out on this machine (${EARS_SIZE} is fetched the first time)`);
    try {
      taking.current = await record();
      setState('listening');
    } catch {
      setState('idle');
      setNote(REFUSED);
    }
  }

  async function finish() {
    const taken = taking.current;
    if (!taken) return;
    taking.current = null;
    setState('hearing');
    setNote('writing down what you said…');
    // The first time, the model itself is being fetched; the server says how that is going.
    const watching = setInterval(() => { getReach().then((reach) => { if (reach.speech) setNote(reach.speech); }).catch(() => {}); }, 1200);
    try {
      const heard = (await listen(await taken.stop())).text.trim();
      if (heard) insert(heard);
      setNote(heard ? '' : 'nothing was said there');
    } catch (error) {
      setNote((error as Error).message);
    }
    clearInterval(watching);
    setState('idle');
  }

  const toggle = () => { void (taking.current ? finish() : begin()); };
  const what = state === 'listening' ? 'Stop listening' : state === 'hearing' ? 'Writing down what you said' : 'Say it instead of typing it';
  return (
    <span className="reach-mic">
      {note && <span className="reach-mic__note">{note}</span>}
      <button
        type="button" className={`ask__attach reach-mic__button${state === 'listening' ? ' is-listening' : ''}`}
        aria-label={what} title={what} aria-pressed={state === 'listening'} disabled={busy || state === 'hearing'}
        onPointerDown={() => { bypointer.current = true; pressed.current = Date.now(); toggle(); }}
        onPointerUp={() => { if (taking.current && Date.now() - pressed.current > HELD) void finish(); }}
        // A button pressed with the keyboard sends only this, so it is what makes it work without a pointer at all.
        onClick={() => { if (!bypointer.current) toggle(); bypointer.current = false; }}
      >{MIC}</button>
    </span>
  );
}
