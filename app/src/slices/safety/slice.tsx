import { overlay } from '../../overlay/store';
import type { UiSlice } from '..';
import { AllowedPanel } from './AllowedPanel';
import { UndoStep } from './Undo';
import './safety.css';

// The safety net, as the founder sees it: the standing yeses they can read and take back, and the way out of a coding
// step that went somewhere they did not want.
export default {
  name: 'safety',
  commands: [{ section: 'Do', label: 'Always allowed', hint: 'What you said yes to for good', action: { do: 'run', run: () => overlay.open({ kind: 'panel', name: 'safety' }) } }],
  panels: { safety: AllowedPanel },
  receipt: UndoStep,
} satisfies UiSlice;
