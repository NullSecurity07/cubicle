import type { UiSlice } from '..';
import { overlay, useLayers } from '../../overlay/store';
import { HealthPanel } from './HealthPanel';
import { InsightsPanel } from './InsightsPanel';
import './openends.css';

// The two views this slice brings. They sit above the shade the window already puts up, so Escape, the click outside
// and the way the rest of the app opens a view all keep working, and nothing in `Overlay.tsx` had to change.
const VIEWS: Record<string, () => React.JSX.Element> = { health: HealthPanel, insights: InsightsPanel };
const show = (name: string) => () => overlay.open({ kind: 'panel', name });

function OpenEnds() {
  const layers = useLayers();
  const top = layers.at(-1);
  const View = top?.kind === 'panel' ? VIEWS[top.name] : undefined;
  if (!View) return null;
  return <div className="openends"><View /></div>;
}

export default {
  name: 'openends',
  overlay: OpenEnds,
  commands: [
    { section: 'Do', label: 'Health', hint: 'Is everything working?', action: { do: 'run', run: show('health') } },
    { section: 'Do', label: 'Insights', hint: 'What the work came to', action: { do: 'run', run: show('insights') } },
    // The other words a founder reaches for. Nothing here starts with "health" or "insights", so neither is offered twice.
    { section: 'Do', label: 'Health', hint: 'Is everything working?', action: { do: 'run', run: show('health') }, when: (typed) => /^(doctor|checkup|check up|backups?|back up( now)?|outside tools|keys|is everything (ok|working|set up)|what.s wrong)$/.test(typed) },
    { section: 'Do', label: 'Insights', hint: 'What the work came to', action: { do: 'run', run: show('insights') }, when: (typed) => /^(usage|tokens|what (did|has) (it|this) cost|spending|stats|numbers|skills? (in|out|file))$/.test(typed) },
  ],
} satisfies UiSlice;
