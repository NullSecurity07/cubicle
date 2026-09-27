import { useEffect, useState } from 'react';
import type { KeyRow, KeysView } from '../../../shared/keys-file';
import { PanelShell } from '../../overlay/PanelShell';
import { pressed } from '../../keys';
import { checkKeys, getKeys, setKey } from './api';

const when = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// What one row says under its name, in words: that it is there and how it ends, or where to make one.
function said(row: KeyRow): string {
  if (row.state === 'failing') return `Set, but the last check failed: ${row.problem}`;
  if (row.state === 'missing') return row.where ? `Not set. Make one at ${row.where}.` : 'Not set.';
  const parts = [row.tail ? `Set · ends in ${row.tail}` : 'Set'];
  if (row.spares) parts.push(`${row.spares} more ${row.spares === 1 ? 'key' : 'keys'} beside it`);
  if (row.shell) parts.push('set where the app was started, which counts over .env');
  else if (row.pending) parts.push(row.state === 'set' ? 'start the app again to use it' : '');
  return parts.filter(Boolean).join(' · ');
}

// One key: its dot, its name, what it says, and the one thing to do about it.
function Row({ row, onSaved }: { row: KeyRow; onSaved: (view: KeysView) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [problem, setProblem] = useState('');

  async function save(next: string) {
    setBusy(true);
    setProblem('');
    try { onSaved(await setKey(row.name, next)); setEditing(false); setValue(''); setSure(false); }
    catch (error) { setProblem((error as Error).message); }
    finally { setBusy(false); }
  }

  const dot = row.state === 'set' ? '' : row.state === 'failing' ? ' ring--out' : ' is-missing';
  return (
    <li className={`keys__row is-${row.state}`} aria-label={row.label}>
      <span className={`quota__dot${dot}`} aria-hidden="true" />
      <div className="keys__what">
        <b>{row.label}<code>{row.name}</code></b>
        <small className="keys__said">{said(row)}</small>
        {row.pending && !row.shell && row.state === 'missing' && <small className="keys__said">Taken out. The app keeps using it until it starts again.</small>}
        {editing && (
          <form className="keys__form" data-holds-escape onSubmit={(event) => { event.preventDefault(); if (value.trim()) void save(value); }}
            onKeyDown={(event) => { if (pressed(event, 'cancel')) { event.stopPropagation(); setEditing(false); setValue(''); setProblem(''); } }}>
            <input
              type="password" autoFocus autoComplete="off" spellCheck={false} aria-label={`New value for ${row.label}`}
              placeholder={`Paste ${row.label}`} value={value} onChange={(event) => setValue(event.target.value)}
            />
            <button type="submit" className="playbook__act primary" disabled={busy || !value.trim()}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="playbook__act" onClick={() => { setEditing(false); setValue(''); setProblem(''); }}>Cancel</button>
          </form>
        )}
        {problem && <p className="msg--problem">{problem}</p>}
      </div>
      {!editing && (
        <div className="keys__acts">
          {sure ? (
            <>
              <span>Take it out?</span>
              <button type="button" className="playbook__act" disabled={busy} onClick={() => void save('')}>Remove</button>
              <button type="button" className="playbook__act" onClick={() => setSure(false)}>Keep</button>
            </>
          ) : (
            <>
              {row.state !== 'missing' && !row.shell && <button type="button" className="keys__quiet" onClick={() => setSure(true)}>Remove</button>}
              {!row.shell && <button type="button" className="playbook__act" onClick={() => { setEditing(true); setProblem(''); }}>{row.state === 'missing' ? 'Set' : 'Change'}</button>}
            </>
          )}
        </div>
      )}
    </li>
  );
}

// Every key the app knows, grouped by what it opens up, the way Health names those things. A key goes into the .env
// file this app reads; nothing here ever shows one back.
export function KeysPanel() {
  const [view, setView] = useState<KeysView | null>(null);
  const [problem, setProblem] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => { getKeys().then(setView, (error: Error) => setProblem(error.message)); }, []);

  async function check() {
    setChecking(true);
    setProblem('');
    try { setView(await checkKeys()); } catch (error) { setProblem((error as Error).message); } finally { setChecking(false); }
  }

  const rows = view?.rows ?? [];
  const groups = [...new Set(rows.map((row) => row.group))];
  const waiting = rows.filter((row) => row.pending);
  const set = rows.filter((row) => row.state !== 'missing').length;
  const failing = rows.filter((row) => row.state === 'failing').length;
  const note = view ? (failing ? `${failing} failing` : `${set} of ${rows.length} set`) : undefined;

  return (
    <PanelShell name="apikeys" title="Keys" note={note}>
      <div className="keys">
        {problem && <p className="msg--problem">{problem}</p>}
        {!view && !problem && <p className="panel__empty">Looking…</p>}
        {view && (
          <>
            <p className="playbook__note">
              Keys are kept in <code>{view.file}</code> on this machine. Once saved, a key is never shown again here:
              only that it is set, and its last four characters.
            </p>
            {waiting.length > 0 && (
              <p className="keys__restart" role="status">
                Start the app again to use {waiting.map((row) => row.label).filter((label, index, all) => all.indexOf(label) === index).join(', ')}.
                {' '}The app reads these when it starts.
              </p>
            )}
            {view.fallback && <p className="playbook__note keys__fallback">{view.fallback}</p>}
            <div className="keys__check">
              <button type="button" className="playbook__act" disabled={checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Check model keys'}</button>
              <small>{view.checkedAt ? `Checked at ${when(view.checkedAt)}` : 'Asks each model for one word, which costs next to nothing.'}</small>
            </div>
            {groups.map((group) => (
              <section key={group} className="keys__group" aria-label={group}>
                <h3 className="keys__group-name">{group}</h3>
                <ul className="keys__rows">
                  {rows.filter((row) => row.group === group).map((row) => <Row key={row.name} row={row} onSaved={setView} />)}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </PanelShell>
  );
}
