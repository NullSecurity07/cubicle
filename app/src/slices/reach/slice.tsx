import type { UiSlice } from '..';
import { overlay, useLayers } from '../../overlay/store';
import { Mic } from './Mic';
import { HearVoice, PersonVoice } from './PersonVoice';
import { ReachPanel } from './ReachPanel';
import { Speak } from './Speak';
import './reach.css';

// The settings sit in a view of their own; speaking and listening do not — they belong in the conversation the
// founder is already having, which is what `reply` and `compose` are for.
function ReachOverlay() {
  const top = useLayers().at(-1);
  if (top?.kind !== 'panel' || top.name !== 'reach') return null;
  return <div className="reach-layer"><ReachPanel /></div>;
}

export default {
  name: 'reach',
  commands: [
    { section: 'Do', label: 'Reach you anywhere', hint: 'Your phone, your voice, calls in', action: { do: 'run', run: () => overlay.open({ kind: 'panel', name: 'reach' }) } },
  ],
  overlay: ReachOverlay,
  reply: Speak,
  compose: Mic,
  person: PersonVoice,
  voice: HearVoice,
} satisfies UiSlice;
