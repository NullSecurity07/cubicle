import { useEffect, useRef, useState } from 'react';
import type { Backup, Backups, Check, Outside } from '../../../shared/openends';
import { PanelShell } from '../../overlay/PanelShell';
import type { BackupPlaces } from '../../../shared/keys-file';
import { backUpTo, getBackupPlaces, getBackups, getHealth, getOutside, makeBackup, markSafe } from './api';
import { pressed } from '../../keys';

// Is everything working? One line a thing, green or red, and when it is red, what you would do about it.
// Nothing here says what a key is — only that there is one, and how many a provider has.
const whole = (count: number) => count.toLocaleString();
const size = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Row({ check }: { check: Check }) {
  return (
    <li className={`health__row${check.ok ? (check.warn ? ' is-warn' : '') : ' is-bad'}`}>
      <span className={`quota__dot${check.ok ? (check.warn ? ' ring--low' : '') : ' ring--out'}`} aria-hidden="true" />
      <div>
        <b>{check.name}</b>
        <small>{check.detail}</small>
        {(!check.ok || check.warn) && check.fix && <p className="playbook__note">{check.fix}</p>}
      </div>
      <span className="health__verdict">{check.ok ? (check.warn ? 'Worth a look' : 'Fine') : 'Needs you'}</span>
    </li>
  );
}

// Everything the founder has written, in one file, five of them kept. What is left out is only what can be made
// again — browser logins, the search index, caches and the trash.
function Backing({ held, onMade }: { held: Backups | null; onMade: (held: Backups) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [made, setMade] = useState<Backup | null>(null);
  // Choosing where they go: the places this machine has, and the folder typed so far. null: not choosing.
  const [places, setPlaces] = useState<BackupPlaces | null>(null);
  const [folder, setFolder] = useState('');

  async function now() {
    setBusy(true);
    setProblem('');
    try { const done = await makeBackup(); setMade(done.backups[0] ?? null); onMade(done); }
    catch (error) { setProblem((error as Error).message); }
    finally { setBusy(false); }
  }
  async function choose() {
    setProblem('');
    try { const found = await getBackupPlaces(); setPlaces(found); setFolder(found.current); }
    catch (error) { setProblem((error as Error).message); }
  }
  // The folder is made and written to once before it is kept, so a drive that is not plugged in says so here.
  async function keep(next: string) {
    setBusy(true);
    setProblem('');
    try { await backUpTo(next); setPlaces(null); setMade(null); onMade(await getBackups()); }
    catch (error) { setProblem((error as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="health__part">
      <h3>Backup<span>{held ? `${held.backups.length} of ${held.kept} kept` : ''}</span></h3>
      <p className="playbook__note">
        One file with everything you have written in it — your stage, your conversations, your docs and the playbook.
        One is made by itself once a day while the app is open.
        {held ? ` They go to ${held.dir}, and the oldest goes when there are more than ${held.kept}.` : ''}
      </p>
      <p className="playbook__note"><b>A backup on this same disk dies with it.</b> Use "Back up to…" to point them at a second disk or a folder a sync service carries.</p>
      {held && held.backups.length > 0 && (
        <ul className="health__files">
          {held.backups.map((one) => (
            <li key={one.file} className={one.file === made?.file ? 'is-new' : undefined}>
              <b>{one.file}</b><small>{when(one.at)} · {size(one.bytes)}</small>
            </li>
          ))}
        </ul>
      )}
      {held && !held.backups.length && <p className="panel__empty">Nothing has been backed up yet.</p>}
      {places && (
        <form
          className="backup__where" aria-label="Where backups go" data-holds-escape
          onSubmit={(event) => { event.preventDefault(); if (folder.trim()) void keep(folder); }}
          onKeyDown={(event) => { if (pressed(event, 'cancel')) { event.stopPropagation(); setPlaces(null); setProblem(''); } }}
        >
          <p className="playbook__note">A USB drive or a folder a sync service carries, so a copy lives off this machine. The next backup goes there; the ones already made stay where they are.</p>
          {places.places.length > 0 && (
            <div className="backup__places">
              {places.places.map((one) => (
                <button key={one.path} type="button" className={folder === one.path ? 'is-on' : undefined} title={one.path} onClick={() => { setFolder(one.path); setProblem(''); }}>{one.label}</button>
              ))}
            </div>
          )}
          <input aria-label="Backup folder" autoFocus spellCheck={false} value={folder} placeholder="/run/media/you/USB/Cubicle backups" onChange={(event) => { setFolder(event.target.value); setProblem(''); }} />
          <div className="playbook__end">
            {places.custom && <button type="button" className="playbook__act" disabled={busy} onClick={() => void keep('')}>Use the default</button>}
            <button type="button" className="playbook__act" onClick={() => { setPlaces(null); setProblem(''); }}>Cancel</button>
            <button type="submit" className="playbook__act primary" disabled={busy || !folder.trim() || folder.trim() === places.current}>Use this folder</button>
          </div>
        </form>
      )}
      {problem && <p className="msg--problem">{problem}</p>}
      {!places && (
        <div className="playbook__end">
          <button type="button" className="playbook__act" disabled={busy} onClick={() => void choose()}>Back up to…</button>
          <button type="button" className="playbook__act primary" disabled={busy} onClick={() => void now()}>{busy ? 'Backing up…' : 'Back up now'}</button>
        </div>
      )}
    </section>
  );
}

// Tools that live in other programs. They are read once, when the app starts, and every one of them asks you before
// it runs unless you have said it is safe.
function Outsiders({ held, onChange }: { held: Outside | null; onChange: (held: Outside) => void }) {
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');

  async function mark(name: string, safe: boolean) {
    setBusy(name);
    setProblem('');
    try { onChange(await markSafe(name, safe)); } catch (error) { setProblem((error as Error).message); } finally { setBusy(''); }
  }
  if (!held) return null;

  return (
    <section className="health__part">
      <h3>Outside tools<span>{held.servers.length ? `${held.servers.length} ${held.servers.length === 1 ? 'program' : 'programs'}` : ''}</span></h3>
      <p className="playbook__note">
        Other programs on this machine can lend your people a few tools. You list them in {held.file}. That list is read
        when the app starts, so after you change it, start the app again to see the difference.
      </p>
      {!held.servers.length && (
        <>
          <p className="panel__empty">No outside programs yet. Anything you put in that file shows up here the next time the app starts.</p>
          <pre className="outside__example">{'{ "mcpServers": { "notes": { "command": "node", "args": ["notes-server.js"] } } }'}</pre>
        </>
      )}
      {held.servers.map((server) => (
        <div key={server.name} className="outside__server">
          <div className="outside__head">
            <span className={`quota__dot${server.ok ? '' : ' ring--out'}`} aria-hidden="true" />
            <b>{server.name}</b>
            <small>{server.how === 'web' ? 'over the web' : 'on this machine'} · {server.detail}</small>
          </div>
          {server.tools.length > 0 && (
            <ul className="outside__tools">
              {server.tools.map((tool) => (
                <li key={tool.name}>
                  <div className="outside__what"><b>{tool.tool}</b><small>{tool.description}</small></div>
                  <label className="skill__switch" title={tool.safe ? 'Runs without asking' : 'Asks you first'}>
                    <input
                      type="checkbox" checked={tool.safe} disabled={busy === tool.name}
                      aria-label={`Let "${tool.tool}" run without asking`}
                      onChange={(event) => void mark(tool.name, event.target.checked)}
                    />
                    <span />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {problem && <p className="msg--problem">{problem}</p>}
      <p className="playbook__note">A switch on means that tool runs without asking you. Everything else stops and asks, and shows you what it was about to send.</p>
    </section>
  );
}

export function HealthPanel() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [backups, setBackups] = useState<Backups | null>(null);
  const [outside, setOutside] = useState<Outside | null>(null);
  const [problem, setProblem] = useState('');

  // Each part is asked for on its own and shown as it comes: the checks can take seconds, and a backup list that
  // arrives after the founder has already made one, or moved them somewhere else, must not put the old list back.
  const moved = useRef(false);
  // The checks are asked again after a backup; only the latest answer is shown, whichever arrives first.
  const asked = useRef(0);
  const recheck = () => { const mine = ++asked.current; return getHealth().then((one) => { if (mine === asked.current) setChecks(one); }); };
  useEffect(() => {
    let live = true;
    const fail = (error: Error) => { if (live) setProblem(error.message); };
    recheck().catch(fail);
    getBackups().then((two) => { if (live && !moved.current) setBackups(two); }, fail);
    getOutside().then((three) => { if (live) setOutside(three); }, fail);
    return () => { live = false; };
  }, []);

  const bad = checks?.filter((one) => !one.ok).length ?? 0;
  const note = checks ? (bad ? `${whole(bad)} of ${whole(checks.length)} need you` : `all ${whole(checks.length)} are fine`) : undefined;

  return (
    <PanelShell name="health" title="Health" note={note}>
      <div className="health">
        {problem && <p className="msg--problem">{problem}</p>}
        {!checks && !problem && <p className="panel__empty">Looking…</p>}
        {checks && <ul className="health__rows">{checks.map((check) => <Row key={check.name} check={check} />)}</ul>}
        {/* A backup answers one of the rows above it, so the rows are asked again the moment one is made. */}
        <Backing held={backups} onMade={(held) => { moved.current = true; setBackups(held); void recheck().catch(() => {}); }} />
        <Outsiders held={outside} onChange={setOutside} />
      </div>
    </PanelShell>
  );
}
