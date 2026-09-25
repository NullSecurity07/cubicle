import { useMemo, useState, type DragEvent } from 'react';
import { importedLine, readLeads, type Imported } from '../../shared/leads-import';
import { request, send } from '../api';
import { pressed } from '../keys';
import './leads-import.css';

const FIELDS: { field: 'name' | 'company' | 'email' | 'linkedin'; label: string }[] = [
  { field: 'name', label: 'Name' }, { field: 'company', label: 'Company' }, { field: 'email', label: 'Email' }, { field: 'linkedin', label: 'LinkedIn' },
];
const SHOWN = 4;

// A file a founder dropped, if it is one a spreadsheet would write. Anything else is left for whoever else wants it.
export const csvIn = (event: DragEvent) => [...event.dataTransfer.items].some((item) => item.kind === 'file');
export async function readDropped(event: DragEvent): Promise<string | null> {
  const file = [...event.dataTransfer.files].find((one) => /\.(csv|tsv|txt)$/i.test(one.name) || /^text\//.test(one.type));
  return file ? file.text() : null;
}

// A spreadsheet of contacts, pasted or dropped, read before anything is added: which of its columns are which, the
// first few rows as they will land, and how many will not and why. One press adds them, and the card says how it went.
export function LeadsImport({ cardId, first, onClose }: { cardId: string; first: string; onClose: () => void }) {
  const [text, setText] = useState(first);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState<Imported | null>(null);
  const read = useMemo(() => readLeads(text), [text]);
  const found = FIELDS.filter((one) => read.columns[one.field] || (one.field === 'name' && read.columns.first));

  async function go() {
    setBusy(true);
    setProblem('');
    try { setDone(await request<Imported>(`/api/leads/${cardId}/import`, send('POST', { text }))); setText(''); }
    catch (error) { setProblem((error as Error).message); }
    finally { setBusy(false); }
  }
  async function drop(event: DragEvent) {
    if (!csvIn(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const words = await readDropped(event);
    if (words === null) { setProblem('That is not a spreadsheet. Drop a .csv file, or paste the rows.'); return; }
    setDone(null);
    setProblem('');
    setText(words);
  }

  return (
    <aside
      className="leadsimport nodrag nowheel" role="dialog" aria-label="Import leads" data-holds-escape
      onKeyDown={(event) => { if (pressed(event, 'cancel')) { event.stopPropagation(); onClose(); } }}
      onDragOver={(event) => { if (csvIn(event)) event.preventDefault(); }} onDrop={(event) => void drop(event)}
    >
      <div className="leadview__head">
        <div>
          <h3>Import leads</h3>
          <p>Paste rows from a spreadsheet, or drop a CSV file here. The first row names the columns.</p>
        </div>
        <button type="button" aria-label="Close import" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      <div className="leadsimport__body">
        <textarea
          aria-label="Rows to import" autoFocus spellCheck={false} value={text}
          placeholder={'Name, Company, Email, LinkedIn\nAda Lovelace, Analytical Engines, ada@analytical.io, linkedin.com/in/ada'}
          onChange={(event) => { setText(event.target.value); setDone(null); setProblem(''); }}
        />
        {done && <p className="leadsimport__done" role="status">{importedLine(done)}</p>}
        {!done && read.problem && <p className="leadsimport__note is-problem">{read.problem}</p>}
        {!done && !read.problem && read.rows.length + read.skipped.length > 0 && (
          <>
            <p className="leadsimport__note">
              Reads {found.map((one) => one.label).join(', ')}.
              {read.skipped.length ? ` ${read.skipped.length} ${read.skipped.length === 1 ? 'row has' : 'rows have'} no ${[...new Set(read.skipped.map((one) => one.why.replace(/^no /, '')))].join(' or ')} and will be left out.` : ''}
              {' '}Anyone already on the card stays as they are.
            </p>
            {read.rows.length > 0 && (
              <table className="leadsimport__rows">
                <thead><tr>{FIELDS.map((one) => <th key={one.field} scope="col">{one.label}</th>)}</tr></thead>
                <tbody>
                  {read.rows.slice(0, SHOWN).map((row) => (
                    <tr key={row.row}>
                      <td>{row.name}</td><td>{row.company}</td><td>{row.email ?? ''}</td>
                      <td>{row.linkedin ? <span className="leadsimport__yes" aria-label="Has a LinkedIn link">in</span> : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {read.rows.length > SHOWN && <p className="leadsimport__note">and {read.rows.length - SHOWN} more</p>}
          </>
        )}
        {problem && <p className="leadview__problem">{problem}</p>}
      </div>
      <div className="leadview__end">
        {/* Remade once it is done, so the focus lands on it: the button that pressed Import has gone. */}
        <button key={done ? 'done' : 'cancel'} type="button" autoFocus={!!done} onClick={onClose}>{done ? 'Done' : 'Cancel'}</button>
        {!done && (
          <button type="button" className="primary" disabled={busy || !read.rows.length} onClick={() => void go()}>
            {busy ? 'Importing…' : read.rows.length ? `Import ${read.rows.length} ${read.rows.length === 1 ? 'lead' : 'leads'}` : 'Import'}
          </button>
        )}
      </div>
    </aside>
  );
}
