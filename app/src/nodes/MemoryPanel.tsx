import { useEffect, useState } from 'react';
import { KEPT_MARK } from '../../shared/model';
import { getMemory, putMemory, watchMemory } from '../api';
import { listen } from '../bus';

// A kept line as the founder reads it: the day and the fact, without the mark, which the tag beside it says instead.
const shown = (line: string) => line.replace(/^\s*-\s*/, '').replace(`${KEPT_MARK} `, '').replace(KEPT_MARK, '').trim();

// What a person carries beyond the recent conversation. The founder reads it, corrects it, or empties it.
export function MemoryPanel({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [memory, setMemory] = useState<{ notes: string; summary: string } | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'problem'>('idle');

  useEffect(() => {
    const load = () => { getMemory(id).then(setMemory).catch(() => setState('problem')); };
    load();
    const stops = [listen('effect', (effect) => { if (effect.kind === 'memory-changed' && effect.id === id) load(); }), watchMemory(id, load)];
    return () => { for (const stop of stops) stop(); };
  }, [id]);

  async function save() {
    if (!memory) return;
    setState('saving');
    try { await putMemory(id, memory); onClose(); } catch { setState('problem'); }
  }

  // One click throws a wrong line out, and it is gone for good at once: a line kept without asking should cost the
  // founder nothing more to remove. Whatever else they changed here is saved with it.
  async function drop(line: string) {
    if (!memory) return;
    const next = { ...memory, notes: memory.notes.split('\n').filter((one) => one !== line).join('\n') };
    setMemory(next);
    try { await putMemory(id, next); setState('idle'); } catch { setState('problem'); }
  }

  const kept = (memory?.notes ?? '').split('\n').filter((line) => line.includes(KEPT_MARK));

  return (
    <div className="setup memory nodrag nowheel" role="dialog" aria-label={`What ${name} remembers`}>
      <p className="memory__lead">{name} sees this in every conversation and task. Older talk is folded into the summary by itself; notes are what {name} chose to keep. Both are yours to edit.</p>
      {kept.length > 0 && (
        <div className="memory__kept" aria-label="Kept on its own">
          <p className="memory__lead">Lines marked this way were kept by {name} without being asked; delete any that are wrong.</p>
          <ul>
            {kept.map((line) => (
              <li key={line}>
                <span className="memory__tag">kept on its own</span>
                <span className="memory__line">{shown(line)}</span>
                <button type="button" className="memory__drop" aria-label={`Delete: ${shown(line)}`} title="Delete this line" onClick={() => void drop(line)}>×</button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
