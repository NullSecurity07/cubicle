import { useEffect, useState } from 'react';
import type { ModelInfo } from '../../shared/model';
import { GENDERS, type Gender, guessGender, poolsOf, voiceFor, type VoiceBy } from '../../shared/voices';
import { getModels } from '../api';
import { everyoneIn, useFlowPick } from '../flow';
import { SLICES } from '../slices';
import { useVoices } from './MediaCards';

export type Person = { name: string; role: string; brief: string; model?: string; gender?: Gender; voice?: string; voiceBy?: VoiceBy };

// Who this person is, which model thinks for them, and how they sound. Auto picks a free model that still has room
// today; the gender is guessed from the name the moment it is typed, and the voice follows from it.
export function PersonForm({ id, person, onSave, onCancel }: { id: string; person: Person; onSave: (next: Person) => void; onCancel?: () => void }) {
  const [form, setForm] = useState({ ...person, model: person.model ?? 'auto' });
  const [models, setModels] = useState<ModelInfo[]>([]);
  // A voice the founder chose by hand in this sitting is theirs: changing gender after that leaves it alone.
  const [picked, setPicked] = useState(false);
  const [allVoices, setAllVoices] = useState(false);
  const voices = useVoices();
  // Only the people and how they sound: a card dragged elsewhere does not draw the form again.
  const everyone = useFlowPick(({ nodes }) => everyoneIn(nodes));
  useEffect(() => { getModels().then(setModels).catch(() => {}); }, []);
  const ready = form.name.trim() && form.role.trim();

  const gender = form.gender ?? guessGender(form.name);
  const voice = voiceFor({ id, name: form.name, gender, voice: form.voice }, everyone, voices);
  const pools = poolsOf(voices);
  // Their own pool, unless the founder asked to see the lot — and always the voice they are on, wherever it is from.
  const shown = allVoices || gender === 'neither' ? voices : voices.filter((one) => pools[gender].includes(one.id) || one.id === voice);

  function save() {
    if (!ready) return;
    // Written down as they are saved, so nothing about how this person sounds can shift under them later.
    // A voice picked here, or one picked before and still on them, is the founder's and the app never recasts it.
    const voiceBy: VoiceBy = picked || (person.voiceBy === 'founder' && form.voice === person.voice) ? 'founder' : 'cast';
    onSave({ name: form.name.trim(), role: form.role.trim(), brief: form.brief.trim(), model: form.model === 'auto' ? undefined : form.model, gender, voice, voiceBy });
  }

  return (
    <form className="setup nodrag nowheel" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <label>Name<input autoFocus value={form.name} placeholder="Maya" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label>Role<input value={form.role} placeholder="Marketing" onChange={(event) => setForm({ ...form, role: event.target.value })} /></label>
      <label>What they do for you<textarea rows={3} value={form.brief} placeholder="Positioning, copy, launch plans…" onChange={(event) => setForm({ ...form, brief: event.target.value })} /></label>
      <fieldset className="setup__pick">
        <legend>Gender</legend>
        {GENDERS.map((one) => (
          <label key={one.value}>
            <input
              type="radio" name={`gender-${id}`} value={one.value} checked={gender === one.value}
              // A new gender suggests a new voice from its own pool; one the founder picked by hand stays put.
              onChange={() => setForm({ ...form, gender: one.value, ...(picked ? {} : { voice: undefined }) })}
            />
            {one.label}
          </label>
        ))}
      </fieldset>
      <div className="setup__row">
        <label>Voice
          {/* Named outright: a label wrapping a select is read out with every option inside it, which is no name at all. */}
          <select aria-label="Voice" value={voice} onChange={(event) => { setPicked(true); setForm({ ...form, voice: event.target.value }); }}>
            {shown.map((one) => <option key={one.id} value={one.id}>{one.name}</option>)}
          </select>
        </label>
        {/* Hearing it belongs to whichever slice can speak, so the form only says what to say and in which voice. */}
        {SLICES.map((slice) => (slice.voice
          ? <slice.voice key={slice.name} voice={voice} text={`Hello, I am ${form.name.trim() || 'one of your people'}. This is how I sound.`} /> : null))}
      </div>
      {gender !== 'neither' && (
        <label className="setup__more">
          <input type="checkbox" checked={allVoices} onChange={(event) => setAllVoices(event.target.checked)} />
          Show all voices
        </label>
      )}
      <label>Model
        <select aria-label="Model" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })}>
          <option value="auto">Auto · best free model with room left</option>
          {models.map((model) => <option key={model.name} value={model.name}>{model.name} · {model.model} · {Math.round(model.left * 100)}% left</option>)}
          {form.model !== 'auto' && !models.some((model) => model.name === form.model) && <option value={form.model}>{form.model} · not set up</option>}
        </select>
      </label>
      <div className="setup__end">
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="primary" disabled={!ready}>Done</button>
      </div>
    </form>
  );
}
