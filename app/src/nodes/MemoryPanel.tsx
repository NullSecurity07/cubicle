import { useEffect, useState } from 'react';
import { getMemory, putMemory } from '../api';
import { listen } from '../bus';

// What a person carries beyond the recent conversation. The founder reads it, corrects it, or empties it.
export function MemoryPanel({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [memory, setMemory] = useState<{ notes: string; summary: string } | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'problem'>('idle');

  useEffect(() => {
    const load = () => { getMemory(id).then(setMemory).catch(() => setState('problem')); };
    load();
    return listen('effect', (effect) => { if (effect.kind === 'memory-changed' && effect.id === id) load(); });
  }, [id]);

  async function save() {
    if (!memory) return;
    setState('saving');
    try { await putMemory(id, memory); onClose(); } catch { setState('problem'); }
  }

  return (
    <div className="setup memory nodrag nowheel" role="dialog" aria-label={`What ${name} remembers`}>
      <p className="memory__lead">{name} sees this in every conversation and task. Older talk is folded into the summary by itself; notes are what {name} chose to keep. Both are yours to edit.</p>
      <label>Notes<textarea aria-label="Notes" rows={5} value={memory?.notes ?? ''} disabled={!memory} placeholder={`Nothing yet. Tell ${name} "remember that…", or write here.`} onChange={(event) => setMemory({ ...memory!, notes: event.target.value })} /></label>
      <label>Earlier conversation, in short<textarea aria-label="Summary" rows={6} value={memory?.summary ?? ''} disabled={!memory} placeholder="Fills in once the conversation grows long." onChange={(event) => setMemory({ ...memory!, summary: event.target.value })} /></label>
      {state === 'problem' && <p className="msg--problem">The memory could not be loaded or saved.</p>}
      <div className="setup__end">
        <button type="button" onClick={onClose}>Close</button>
        <button type="button" className="primary" disabled={!memory || state === 'saving'} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
