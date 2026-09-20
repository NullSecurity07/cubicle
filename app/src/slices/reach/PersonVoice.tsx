import { useNodes } from '@xyflow/react';
import { useState } from 'react';
import { voiceFor, voiceNamed } from '../../../shared/voices';
import { useVoices } from '../../nodes/MediaCards';
import type { RoomData, StageNode } from '../../stage';
import { SPEAKER, STOP } from './Speak';
import { quiet, say, spokenOnce, useSaying, useVoiceOn, VOICE_SIZE } from './voice';

const everyoneIn = (nodes: StageNode[]) => nodes.flatMap((node) => (node.type === 'room'
  ? [{ id: node.id, name: node.data.name, gender: node.data.gender, voice: node.data.voice }] : []));

// How this person sounds, beside who they are wired to and what they remember. It is only worth saying while their
// replies can actually be heard, so it comes and goes with the switch in "Reach you anywhere".
export function PersonVoice({ roomId, room }: { roomId: string; room: RoomData }) {
  const on = useVoiceOn();
  const voices = useVoices();
  const nodes = useNodes<StageNode>();
  const named = voiceNamed(voiceFor({ id: roomId, name: room.name, gender: room.gender, voice: room.voice }, everyoneIn(nodes), voices), voices);
  if (!on || !named) return null;
  return <section><h3>Voice</h3><p className="side__text">{named}</p></section>;
}

// One voice, heard where it is being chosen. Speaking lives in this slice, so the person form asks for this button
// rather than knowing how any of it works.
export function HearVoice({ text, voice }: { text: string; voice: string }) {
  const saying = useSaying();
  const [getting, setGetting] = useState(false);
  const [problem, setProblem] = useState('');
  // The words as well as the voice: a line kept from before the founder changed the name would be the wrong line.
  const key = `voice:${voice}:${text}`;
  const mine = saying === key;

  async function press() {
    if (mine) { quiet(); return; }
    setProblem('');
    setGetting(!spokenOnce());
    try { await say(key, text, { voice }); } catch (error) { setProblem((error as Error).message); }
    setGetting(false);
  }

  // The first time, the voice this runs on has to be fetched, and that is worth knowing before pressing.
  const what = mine ? 'Stop' : spokenOnce() ? 'Hear this voice' : `Hear this voice (it runs on this machine; ${VOICE_SIZE} is fetched the first time)`;
  return (
    <span className="reach-hear">
      <button type="button" aria-label={what} title={what} disabled={!voice} onClick={() => void press()}>{mine ? STOP : SPEAKER}</button>
      {getting && <span className="reach-hear__note">getting the voice ready — {VOICE_SIZE} the first time…</span>}
      {problem && <span className="reach-hear__note reach-hear__problem">{problem}</span>}
    </span>
  );
}
