import { useEffect, useState } from 'react';
import type { ModelInfo } from '../../shared/model';
import { getModels } from '../api';

export type Person = { name: string; role: string; brief: string; model?: string };

// Who this person is, and which model thinks for them. Auto picks a free model that still has room today.
export function PersonForm({ person, onSave, onCancel }: { person: Person; onSave: (next: Person) => void; onCancel?: () => void }) {
  const [form, setForm] = useState({ ...person, model: person.model ?? 'auto' });
  const [models, setModels] = useState<ModelInfo[]>([]);
  useEffect(() => { getModels().then(setModels).catch(() => {}); }, []);
  const ready = form.name.trim() && form.role.trim();

  function save() {
    if (!ready) return;
    onSave({ name: form.name.trim(), role: form.role.trim(), brief: form.brief.trim(), model: form.model === 'auto' ? undefined : form.model });
  }

  return (
    <form className="setup nodrag nowheel" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <label>Name<input autoFocus value={form.name} placeholder="Maya" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label>Role<input value={form.role} placeholder="Marketing" onChange={(event) => setForm({ ...form, role: event.target.value })} /></label>
      <label>What they do for you<textarea rows={3} value={form.brief} placeholder="Positioning, copy, launch plans…" onChange={(event) => setForm({ ...form, brief: event.target.value })} /></label>
      <label>Model
        <select value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })}>
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
