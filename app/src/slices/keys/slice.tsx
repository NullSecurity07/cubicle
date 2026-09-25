import type { UiSlice } from '..';
import { overlay } from '../../overlay/store';
import { KeysPanel } from './KeysPanel';
import './keys.css';

const show = () => overlay.open({ kind: 'panel', name: 'apikeys' });

// Keys, set from the window: every key the app knows, whether it is there and working, and a place to paste one.
export default {
  name: 'keys',
  panels: { apikeys: KeysPanel },
  commands: [
    { section: 'Do', label: 'Keys', hint: 'Set the keys for models and services', action: { do: 'run', run: show } },
    // The other words a founder reaches for. "keys" alone is already the keyboard shortcuts; this one says it too.
    { section: 'Do', label: 'Keys', hint: 'Set the keys for models and services', action: { do: 'run', run: show }, when: (typed) => /^(api keys?|\.?env|secrets?|tokens? for|provider keys?|set (a |up )?keys?|add (a )?key)$/.test(typed) },
  ],
} satisfies UiSlice;
