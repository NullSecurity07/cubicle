import { useState } from 'react';
import type { Case, Framework } from '../../shared/frameworks';
import { matchesFramework, shelve, sizeLine } from '../../shared/frameworks';
import { removeFramework, rerunEvals, saveFramework, takeFrameworkUpdate } from '../api';
import { refreshFrameworks, useFrameworks, usePlaceFramework } from '../frameworks';
import { useNotes } from '../library';
import { overlay } from '../overlay/store';
import { PanelShell } from '../overlay/PanelShell';
import { ForgeView } from './ForgeView';
import { Runs, ScorePill } from './EvalsView';
import { pressed } from '../keys';
import { useModels } from '../models';

// The icon frameworks wear in the dock and here: blocks stacked into a group, the shape of a team that lands in one
// press. Drawn in the same stroked line as everything else on the dock.
export const BlocksIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.800l6 3.200-6 3.200-6-3.200zM4 10l6 3.200 6-3.200M4 13.800l6 3.200 6-3.200" /></svg>
);

// A note this framework was built from, named in words when it is not in the library to be looked up.
const nameOfNote = (id: string) => id.replace(/-/g, ' ').replace(/^./, (first) => first.toUpperCase());

// One test case, written or changed. Four plain fields, because that is what a case is: whose it is, what is asked,
// the answer the founder's notes state, and the criteria they state instead.
function CaseForm({ held, onSave, onCancel }: { held?: Case; onSave: (one: Case) => void; onCancel: () => void }) {
  const [keys, setKeys] = useState((held?.keys ?? []).join(', '));
  const [input, setInput] = useState(held?.input ?? '');
  const [expected, setExpected] = useState(held?.expected ?? '');
  const [rubric, setRubric] = useState(held?.rubric ?? '');

  return (
    <form
      className="cases__form"
      data-holds-escape
      onKeyDown={(event) => { if (pressed(event, 'cancel')) { event.stopPropagation(); onCancel(); } }}
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ id: held?.id ?? '', keys: keys.split(',').map((key) => key.trim()).filter(Boolean), input, expected, rubric, addedBy: held?.addedBy ?? 'founder' });
      }}
    >
      <input aria-label="Whose case" placeholder="Whose case is it? (assumption, verdict)" value={keys} onChange={(event) => setKeys(event.target.value)} />
      <textarea aria-label="What is asked" rows={3} placeholder="What is asked" value={input} onChange={(event) => setInput(event.target.value)} />
      <textarea aria-label="Expected answer" rows={2} placeholder="The answer your notes state, if they state one" value={expected} onChange={(event) => setExpected(event.target.value)} />
      <textarea aria-label="Rubric" rows={2} placeholder="Or the criteria, in your notes' own words" value={rubric} onChange={(event) => setRubric(event.target.value)} />
      <div className="library__end">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={!input.trim() || !keys.trim()}>Save case</button>
      </div>
    </form>
  );
}

// The framework's dataset: what its people will be tested on when the evals round comes. Plain rows, because these
// are the founder's own examples and what matters is reading them at a glance.
function Cases({ framework, onChanged }: { framework: Framework; onChanged: (next: Framework) => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const write = async (dataset: Case[]) => { setEditing(null); await onChanged({ ...framework, dataset }); };
  const save = (held: Case) => {
    const id = held.id || `case-${Date.now().toString(36)}`;
    const next = framework.dataset.some((one) => one.id === id)
      ? framework.dataset.map((one) => (one.id === id ? { ...held, id } : one))
      : [...framework.dataset, { ...held, id }];
    return write(next);
  };

  return (
    <div className="cases">
      <ul className="cases__list">
        {framework.dataset.map((held) => (
          <li key={held.id} className="cases__case">
            {editing === held.id ? <CaseForm held={held} onSave={(one) => void save(one)} onCancel={() => setEditing(null)} /> : (
              <>
                <div className="cases__what">
                  <small>{held.keys.join(', ')}</small>
                  <p>{held.input}</p>
                  {held.expected && <p className="cases__expected">Expected: {held.expected}</p>}
                </div>
                <div className="library__acts">
                  <button type="button" onClick={() => setEditing(held.id)}>Edit</button>
                  <button type="button" onClick={() => void write(framework.dataset.filter((one) => one.id !== held.id))}>Delete</button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {editing === 'new' ? <CaseForm onSave={(one) => void save(one)} onCancel={() => setEditing(null)} />
        : <button type="button" className="cases__add" onClick={() => setEditing('new')}>Add a case</button>}
    </div>
  );
}

// The briefs the framework's people work to. A brief is the team — it is what was written, scored and promoted — so
// editing one here is not a saved preference, it is a change that has to earn its place: the panel writes the
// framework and runs every case against it at once, and the runs list says whether the change was an improvement.
function Briefs({ framework, onSave }: { framework: Framework; onSave: (next: Framework) => Promise<void> }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const briefOf = (key: string, was: string) => drafts[key] ?? was;
  const changed = framework.rooms.some((room) => briefOf(room.key, room.brief) !== room.brief);

  return (
    <div className="briefs">
      {framework.rooms.map((room) => (
        <label key={room.key} className="briefs__one">
          <small className="forge__cap">{room.name} · {room.role}</small>
          <textarea
            aria-label={`Brief for ${room.name}`} rows={5} value={briefOf(room.key, room.brief)}
            onChange={(event) => setDrafts((was) => ({ ...was, [room.key]: event.target.value }))}
          />
        </label>
      ))}
      <div className="library__end">
        <button
          type="button" className="primary" disabled={!changed}
          onClick={() => { void onSave({ ...framework, rooms: framework.rooms.map((room) => ({ ...room, brief: briefOf(room.key, room.brief) })) }).then(() => setDrafts({})); }}
        >
          Save and score
        </button>
      </div>
    </div>
  );
}

// The frameworks the founder has: what each one is for, what it will put on the stage, which of their notes it needs,
// what it scored last time it was asked, and the one press that lands it.
export function FrameworksPanel() {
  const frameworks = useFrameworks();
  const notes = useNotes();
  const place = usePlaceFramework();
  // Which framework is open, and at which of its three shelves: its test cases, its briefs, or its runs. One at a
  // time, because the panel is a column and three lists stacked in it is a page nobody reads.
  const [open, setOpen] = useState<{ id: string; what: 'cases' | 'people' | 'runs' } | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState('');
  // Which models are set up here right now. A scorecard turns amber when the model that made it has gone, so the
  // panel has to know what is configured, and it is one small question asked once.
  const models = (useModels() ?? []).map((model) => model.name);
  // Bumped when a rerun starts, so the runs list under that framework starts watching again.
  const [watch, setWatch] = useState(0);
  // Which framework is being asked "really?". Throwing a team away takes two presses, in the place the first one was.
  const [sure, setSure] = useState<string | null>(null);
  // The forge lives inside this panel rather than beside it in the dock: forging a team and keeping one are the same
  // shelf, and a founder who has just built a team is one press from placing it.
  const [forging, setForging] = useState(false);
  const [query, setQuery] = useState('');

  async function put(framework: Framework) {
    try { setProblem(''); await saveFramework(framework.id, framework); await refreshFrameworks(); }
    catch (error) { setProblem((error as Error).message); }
  }

  async function land(framework: Framework) {
    setBusy(framework.id);
    try { setProblem(''); await place(framework, () => overlay.close({ kind: 'panel', name: 'frameworks' })); }
    catch (error) { setProblem((error as Error).message); } finally { setBusy(''); }
  }

  // Running every case again, against the briefs this framework holds now. The founder is answered at once and the
  // runs list, which opens with it, shows what is happening line by line.
  async function score(framework: Framework) {
    setOpen({ id: framework.id, what: 'runs' });
    try { setProblem(''); await rerunEvals(framework.id); setWatch((was) => was + 1); }
    catch (error) { setProblem((error as Error).message); }
  }

  // A brief the founder rewrote: written down, and then scored, because a team nobody measured again is a team whose
  // scorecard is about somebody else.
  async function rewrite(framework: Framework) {
    await put(framework);
    await score(framework);
  }

  // A built-in team the founder changed, and the app has changed since: their copy goes to trash and today's team takes
  // its place. The stage is left alone, so people already placed keep the briefs they were placed with.
  async function take(framework: Framework) {
    setBusy(framework.id);
    try { setProblem(''); await takeFrameworkUpdate(framework.id); await refreshFrameworks(); setOpen(null); }
    catch (error) { setProblem((error as Error).message); } finally { setBusy(''); }
  }

  async function forget(framework: Framework) {
    setSure(null);
    try { setProblem(''); await removeFramework(framework.id); await refreshFrameworks(); }
    catch (error) { setProblem((error as Error).message); }
  }

  // What the founder typed into the search, and the shelf it leaves: the four stages of a company in order, then
  // everything else, each one only when something on it matches.
  const shelves = shelve(frameworks.filter((framework) => matchesFramework(framework, query)));

  // One team on the shelf: what it is for, what it puts on the stage, what it needs, and what can be done with it.
  const row = (framework: Framework) => {
    const missing = framework.notes.filter((note) => !notes.some((held) => held.id === note.id));
    return (
      <li key={framework.id} className="frameworks__one">
        <div className="frameworks__head">
          <BlocksIcon />
          <div className="frameworks__what">
            <b>{framework.name}</b>
            {framework.intent && <p>{framework.intent}</p>}
            <small className="frameworks__size">
              {sizeLine(framework)}
              <ScorePill framework={framework} notes={notes} models={models} />
            </small>
            {framework.notes.length > 0 && (
              <small className={missing.length ? 'frameworks__needs is-missing' : 'frameworks__needs'}>
                {missing.length
                  ? `Add ${missing.map((note) => nameOfNote(note.id)).join(', ')} to your notes: its people read from it.`
                  : `Built from ${framework.notes.map((note) => notes.find((held) => held.id === note.id)?.title ?? nameOfNote(note.id)).join(', ')}`}
              </small>
            )}
          </div>
          <button type="button" className="frameworks__place" disabled={busy === framework.id} onClick={() => void land(framework)}>Place</button>
        </div>
        {framework.update && (
          <div className="frameworks__update">
            <p><b>An update is available.</b> Your copy has changes of yours, so it was kept. Teams already on the stage keep their briefs either way.</p>
            <button type="button" disabled={busy === framework.id} onClick={() => void take(framework)}>Take the update</button>
          </div>
        )}
        <div className="frameworks__acts">
          <button type="button" aria-expanded={open?.id === framework.id && open.what === 'cases'} onClick={() => setOpen(open?.id === framework.id && open.what === 'cases' ? null : { id: framework.id, what: 'cases' })}>
            {framework.dataset.length === 1 ? '1 test case' : `${framework.dataset.length} test cases`}
          </button>
          {framework.rooms.length > 0 && (
            <button type="button" aria-expanded={open?.id === framework.id && open.what === 'people'} onClick={() => setOpen(open?.id === framework.id && open.what === 'people' ? null : { id: framework.id, what: 'people' })}>
              Briefs
            </button>
          )}
          <button type="button" aria-expanded={open?.id === framework.id && open.what === 'runs'} onClick={() => setOpen(open?.id === framework.id && open.what === 'runs' ? null : { id: framework.id, what: 'runs' })}>
            Runs
          </button>
          {framework.dataset.length > 0 && <button type="button" onClick={() => void score(framework)}>Rerun evals</button>}
          {sure === framework.id ? (
            <>
              <span>Remove this team?</span>
              <button type="button" onClick={() => void forget(framework)}>Remove</button>
              <button type="button" onClick={() => setSure(null)}>Keep</button>
            </>
          ) : <button type="button" onClick={() => { setProblem(''); setSure(framework.id); }}>Remove</button>}
        </div>
        {open?.id === framework.id && open.what === 'cases' && <Cases framework={framework} onChanged={put} />}
        {open?.id === framework.id && open.what === 'people' && <Briefs framework={framework} onSave={rewrite} />}
        {open?.id === framework.id && open.what === 'runs' && <Runs framework={framework} watch={watch} onChanged={async () => { await refreshFrameworks(); }} />}
      </li>
    );
  };

  return (
    <PanelShell name="frameworks" title="Frameworks" note="Teams that land ready to work">
      {forging ? <ForgeView onPlace={land} onBack={() => setForging(false)} /> : (
      <>
      <div className="frameworks__top">
        <input
          type="search" className="frameworks__search" aria-label="Search frameworks" placeholder="Search teams by name or what they are for"
          value={query} onChange={(event) => setQuery(event.target.value)} {...(query ? { 'data-holds-escape': '' } : {})}
          onKeyDown={(event) => { if (pressed(event, 'cancel') && query) { event.stopPropagation(); setQuery(''); } }}
        />
        <button type="button" className="frameworks__forge" title="Build a team from your notes" onClick={() => { setProblem(''); setForging(true); }}>Forge</button>
      </div>
      {problem && <p className="msg--problem">{problem}</p>}
      {frameworks.length === 0 ? <p className="library__empty">Nothing here yet. Select a few cards on the stage and save them as a framework, and they will come back in one press.</p>
        : shelves.length === 0 ? <p className="library__empty">No team matches “{query.trim()}”.</p> : shelves.map((group) => (
          <section key={group.shelf} className="frameworks__shelf" aria-label={group.shelf}>
            <h3 className="frameworks__shelf-name">{group.shelf}<span>{group.frameworks.length}</span></h3>
            <ul className="frameworks__list">{group.frameworks.map(row)}</ul>
          </section>
        ))}
      </>
      )}
    </PanelShell>
  );
}
