import { useEffect, useState } from 'react';
import type { CoderModels } from '../../shared/coder';
import { getCoderModels } from '../api';
import { pressed } from '../keys';

// Read once per window: the list only changes when the founder adds a key or a local model and starts the app again.
let known: Promise<CoderModels> | null = null;
let held: CoderModels | null = null;
const models = () => (known ??= getCoderModels().then((list) => (held = list), (error) => { known = null; throw error; }));

// A model's name without the words that say what the group already says.
const plain = (name: string) => name.replace(/\s*\(?free\)?$/i, '').trim() || name;
// A model nobody has named for us yet, said the way its maker would: `nemotron-3.5-lightning-free` is Nemotron 3.5 Lightning.
const spoken = (id: string) => plain((id.split('/').pop() ?? id).split(/[-_:]/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' '));

// The pill in the card's header: which model the coder thinks with, and the menu to change it. Free models first, then
// the founder's own keys, then the models on this machine. Picking a local one starts nothing: the log says so when
// its server is not answering.
export function CoderModel({ model, onPick }: { model?: string; onPick: (model: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CoderModels | null>(held);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (!open || list) return;
    models().then(setList, (error: Error) => setProblem(error.message));
  }, [open, list]);

  // The list is only asked for when the menu opens: asking starts the coder's server, and a stage that is merely looked
  // at should not. Until then the pill says the model's id the way a person would.
  const all = list?.groups.flatMap((group) => group.models) ?? [];
  const showing = model ?? list?.default ?? undefined;
  const name = all.find((one) => one.id === showing)?.name ?? (showing ? spoken(showing) : 'Free model');
  const pick = (next: string | undefined) => { onPick(next); setOpen(false); };

  return (
    <div className="coder-model nodrag" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={(event) => { if (pressed(event, 'cancel')) setOpen(false); }}>
      <button type="button" className="coder-model__pill" aria-haspopup="menu" aria-expanded={open} aria-label={`Model: ${plain(name)}`} title="The model the coder thinks with" onClick={() => setOpen(!open)}>
        <span>{plain(name)}</span>
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.500 4 5 6.500 7.500 4" /></svg>
      </button>
      {open && (
        <div className="coder-model__menu nowheel" role="menu" aria-label="Models">
          {!list && !problem && <p className="coder-model__note">Asking the coder which models it has…</p>}
          {problem && <p className="coder-model__note msg--problem">{problem}</p>}
          {list && (
            <button type="button" role="menuitemradio" aria-checked={!model} onClick={() => pick(undefined)}>
              <b>Default</b><small>{all.find((one) => one.id === list.default)?.name ?? 'the first free model'}</small>
            </button>
          )}
          {list?.groups.map((group) => (
            <div key={group.name} className="coder-model__group" role="group" aria-label={group.name}>
              <h6>{group.name}</h6>
              {group.models.length === 0 && <p className="coder-model__note">{group.name === 'Your keys' ? 'Add a Groq, Gemini or OpenRouter key to .env to see these.' : group.name === 'Local' ? 'None set up on this machine.' : 'None on offer right now.'}</p>}
              {group.models.map((one) => (
                <button key={one.id} type="button" role="menuitemradio" aria-checked={model === one.id} onClick={() => pick(one.id)}>
                  <b>{group.name === 'Free (OpenCode Zen)' ? plain(one.name) : one.name}</b>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
