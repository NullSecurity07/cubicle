import type { UiSlice } from '..';
import { overlay } from '../../overlay/store';
import { HealthPanel } from './HealthPanel';
import { InsightsPanel } from './InsightsPanel';
import './openends.css';

const show = (name: string) => () => overlay.open({ kind: 'panel', name });

export default {
  name: 'openends',
  // The two views this slice brings, mounted by the window like its own.
  panels: { health: HealthPanel, insights: InsightsPanel },
  commands: [
    { section: 'Do', label: 'Health', hint: 'Is everything working?', action: { do: 'run', run: show('health') } },
    { section: 'Do', label: 'Insights', hint: 'What the work came to', action: { do: 'run', run: show('insights') } },
    // The other words a founder reaches for. Nothing here starts with "health" or "insights", so neither is offered twice.
    { section: 'Do', label: 'Health', hint: 'Is everything working?', action: { do: 'run', run: show('health') }, when: (typed) => /^(doctor|checkup|check up|backups?|back up( now)?|outside tools|is everything (ok|working|set up)|what.s wrong)$/.test(typed) },
    { section: 'Do', label: 'Insights', hint: 'What the work came to', action: { do: 'run', run: show('insights') }, when: (typed) => /^(usage|tokens|what (did|has) (it|this) cost|spending|stats|numbers|skills? (in|out|file))$/.test(typed) },
  ],
} satisfies UiSlice;
