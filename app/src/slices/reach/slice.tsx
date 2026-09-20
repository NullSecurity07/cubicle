import type { UiSlice } from '..';
import { overlay, useLayers } from '../../overlay/store';
import { ReachPanel } from './ReachPanel';
import { TalkPanel } from './TalkPanel';
import './reach.css';

const open = (name: string) => () => overlay.open({ kind: 'panel', name });

// Both views sit in the same layer stack as the app's own, so Escape leaves them the way it leaves everything else,
// and the shade behind them is the one that is already there.
function ReachOverlay() {
  const top = useLayers().at(-1);
  if (top?.kind !== 'panel' || (top.name !== 'reach' && top.name !== 'talk')) return null;
  return <div className="reach-layer">{top.name === 'reach' ? <ReachPanel /> : <TalkPanel />}</div>;
}

export default {
  name: 'reach',
  commands: [
    { section: 'Do', label: 'Reach you anywhere', hint: 'Your phone, your voice, calls in', action: { do: 'run', run: open('reach') } },
    { section: 'Do', label: 'Talk to someone', hint: 'Say it out loud, hear it back', action: { do: 'run', run: open('talk') } },
  ],
  overlay: ReachOverlay,
} satisfies UiSlice;
