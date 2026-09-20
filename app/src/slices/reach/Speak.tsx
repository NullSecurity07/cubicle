import { useState } from 'react';
import type { ChatMessage } from '../../../shared/model';
import { quiet, say, spokenOnce, useSaying, useVoiceOn, VOICE_SIZE } from './voice';

// Filled, like the other small marks in a chat: an outlined speaker turns to mush at the size these buttons are.
// Shared with the button that plays a voice in the person form, so hearing something is the same mark everywhere.
export const SPEAKER = <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.4h1.9L9 3.7v8.6L5.9 9.6H4z" fill="currentColor" stroke="none" /><path d="M11.1 6.2a2.7 2.7 0 0 1 0 3.6" /></svg>;
export const STOP = <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" /></svg>;

// Hearing a reply instead of reading it. It sits with the reply's own actions and keeps their manners: out of the way
// until the founder is on that message, and only ever one voice in the whole window at a time.
export function Speak({ message, roomId }: { message: ChatMessage; roomId: string }) {
  const on = useVoiceOn();
  const saying = useSaying();
  const [getting, setGetting] = useState(false);
  const [problem, setProblem] = useState('');
  if (!on || !message.text.trim()) return null;
  const mine = saying === message.id;

  async function press() {
    if (mine) { quiet(); return; }
    setProblem('');
    setGetting(!spokenOnce());
    // Said in this person's own voice, which is why the room goes with the words.
    try { await say(message.id, message.text, { roomId }); } catch (error) { setProblem((error as Error).message); }
    setGetting(false);
  }

  // The first time, the voice this runs on has to be fetched, and that is worth knowing before pressing.
  const what = mine ? 'Stop' : spokenOnce() ? 'Say this out loud' : `Say this out loud (the voice runs on this machine; ${VOICE_SIZE} is fetched the first time)`;
  return (
    <span className={`msg__tools reach-say${mine || getting || problem ? ' is-live' : ''}`}>
      {getting && <span className="reach-say__note">getting the voice ready — {VOICE_SIZE} the first time…</span>}
      {problem && <span className="reach-say__note msg--problem">{problem}</span>}
      <button type="button" aria-label={what} title={what} onClick={() => void press()}>{mine ? STOP : SPEAKER}</button>
    </span>
  );
}
