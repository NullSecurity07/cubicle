import { useEffect, useRef, useState } from 'react';
import type { Framework } from '../../shared/frameworks';
import type { ForgeJob, ForgeMode, Person, Proposal } from '../../shared/forge';
import { callsLine, FORGE_STEPS } from '../../shared/forge';
import type { Case } from '../../shared/frameworks';
import { forgeBuild, forgePropose, getForge, stopForge } from '../api';
import { refreshFrameworks } from '../frameworks';
import { useNotes } from '../library';
import { usePoll } from '../poll';
import { useModels } from '../models';

// The forge, inside the Frameworks panel: the founder picks the notes they learned from, says in a line what they
// want a team for, and watches one get written. The middle of it is the preview — nothing is built until they have
// read the people a model proposed and changed whatever they like.

const HOW_OFTEN = 1500;
// Where each state of a job stands in the six steps the founder is shown.
const AT: Record<ForgeJob['state'], number> = { reading: 0, proposing: 1, previewing: 2, building: 3, testing: 4, done: 5, failed: -1 };
const MODES: ForgeMode[] = ['quick', 'full'];
const WORKING: ForgeJob['state'][] = ['reading', 'proposing', 'building', 'testing'];

const newCase = (key: string): Case => ({ id: '', keys: key ? [key] : [], input: '', addedBy: 'founder' });

// One box in the preview, with a word above it saying what it is. Four fields in a column all look alike, and the
// founder reading a proposal for the first time should not have to guess which one is the answer and which one is
// the criteria — the placeholder disappears the moment they type, and this does not.
const Cap = ({ children }: { children: string }) => <small className="forge__cap">{children}</small>;

// One test case, as the founder reads and changes it before anything is run against it.
function CaseRow({ held, onChange, onRemove }: { held: Case; onChange: (one: Case) => void; onRemove: () => void }) {
  return (
    <li className="forge__case">
      <Cap>Case for</Cap>
      <input aria-label="Whose case" placeholder="Whose case is it?" value={held.keys.join(', ')} onChange={(event) => onChange({ ...held, keys: event.target.value.split(',').map((key) => key.trim()).filter(Boolean) })} />
      <Cap>Asked</Cap>
      <textarea aria-label="What is asked" rows={2} placeholder="What is asked" value={held.input} onChange={(event) => onChange({ ...held, input: event.target.value })} />
      <Cap>The answer the notes state</Cap>
      <textarea aria-label="Expected answer" rows={1} placeholder="The answer your notes state, if they state one" value={held.expected ?? ''} onChange={(event) => onChange({ ...held, expected: event.target.value })} />
      <Cap>Criteria, in the notes' words</Cap>
      <textarea aria-label="Rubric" rows={1} placeholder="Or the criteria, in your notes' own words" value={held.rubric ?? ''} onChange={(event) => onChange({ ...held, rubric: event.target.value })} />
      <button type="button" className="forge__drop" onClick={onRemove}>Remove</button>
    </li>
  );
}

// The proposal, editable in place. Everything here is the founder's to change: a brief they rewrite is the brief the
// candidates are measured against, and a case they add is a case the team has to pass.
function Preview({ draft, onChange }: { draft: Proposal; onChange: (next: Proposal) => void }) {
  const person = (key: string, over: Partial<Person>) => onChange({ ...draft, rooms: draft.rooms.map((one) => (one.key === key ? { ...one, ...over } : one)) });
  const cases = (dataset: Case[]) => onChange({ ...draft, dataset });
  return (
    <div className="forge__preview">
      <h3>{draft.name}</h3>
      <ul className="forge__people">
        {draft.rooms.map((one) => (
          <li key={one.key} className="forge__person" style={{ borderLeftColor: one.accent }}>
            <div className="forge__who">
              <input aria-label="Person name" value={one.name} onChange={(event) => person(one.key, { name: event.target.value })} />
              <input aria-label="Person role" value={one.role} onChange={(event) => person(one.key, { role: event.target.value })} />
              <button type="button" className="forge__drop" onClick={() => onChange({
                ...draft,
                rooms: draft.rooms.filter((other) => other.key !== one.key),
                wires: draft.wires.filter((wire) => wire.from !== one.key && wire.to !== one.key),
                // A case that was only theirs goes with them; one they shared stays with whoever is left.
                dataset: draft.dataset.map((kase) => ({ ...kase, keys: kase.keys.filter((key) => key !== one.key) })).filter((kase) => kase.keys.length),
              })}>Remove</button>
            </div>
            <textarea aria-label={`Brief for ${one.name}`} rows={5} value={one.brief} onChange={(event) => person(one.key, { brief: event.target.value })} />
          </li>
        ))}
      </ul>
      {draft.docs.length > 0 && (
        <div className="forge__docs">
          {draft.docs.map((doc) => (
            <label key={doc.key} className="forge__doc">
              <Cap>Doc</Cap>
              <input
                aria-label="Document title" value={doc.title}
                onChange={(event) => onChange({ ...draft, docs: draft.docs.map((one) => (one.key === doc.key ? { ...one, title: event.target.value } : one)) })}
              />
            </label>
          ))}
        </div>
      )}
      <ul className="forge__cases">
        {draft.dataset.map((kase, index) => (
          <CaseRow
            key={`${kase.id}-${index}`} held={kase}
            onChange={(one) => cases(draft.dataset.map((other, at) => (at === index ? one : other)))}
            onRemove={() => cases(draft.dataset.filter((_other, at) => at !== index))}
          />
        ))}
      </ul>
      <button type="button" className="cases__add" onClick={() => cases([...draft.dataset, newCase(draft.rooms[0]?.key ?? '')])}>Add a case</button>
    </div>
  );
}

export function ForgeView({ onPlace, onBack }: { onPlace: (framework: Framework) => Promise<void>; onBack: () => void }) {
  const notes = useNotes();
  const [chosen, setChosen] = useState<string[]>([]);
  const [intent, setIntent] = useState('');
  const [mode, setMode] = useState<ForgeMode>('quick');
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<ForgeJob | null>(null);
  const [draft, setDraft] = useState<Proposal | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  // Bumped whenever there is something new to watch: the job goes quiet between the preview and Build, and the
  // window stops asking until the founder sets it going again.
  const [watch, setWatch] = useState(0);
  const models = useModels();
  const quota = !models ? '' : models.length ? `${Math.round(Math.max(0, ...models.map((model) => model.left)) * 100)}% of today's free models left` : 'no models are set up yet';
  // The last step reached, so a failure is shown where it happened rather than throwing the list away.
  const reached = useRef(0);
  const lines = useRef<HTMLDivElement>(null);


  // Watching one job. The panel asks rather than listens: a forge job says something every few seconds at most, and
  // one question every second and a half costs less than a place in the window's one live connection.
  usePoll(jobId ? () => getForge(jobId) : null, HOW_OFTEN, (held) => {
    setJob(held);
    if (held.state === 'previewing') setDraft((was) => was ?? held.proposal ?? null);
    if (held.state === 'done') { setDraft(held.proposal ?? null); void refreshFrameworks(); }
    // Nothing moves on its own once the job is waiting for the founder or finished, so nothing is asked either.
    return WORKING.includes(held.state);
  }, (error) => setProblem(error.message), [jobId, watch]);

  useEffect(() => { lines.current?.scrollTo({ top: lines.current.scrollHeight }); }, [job?.lines.length]);

  const state = job?.state ?? 'reading';
  if (job && AT[state] >= 0) reached.current = AT[state];
  const working = !!job && WORKING.includes(state);

  async function propose() {
    setBusy(true);
    setProblem('');
    setDraft(null);
    setJob(null);
    try { setJobId((await forgePropose({ noteIds: chosen, intent, mode })).jobId); }
    catch (error) { setProblem((error as Error).message); } finally { setBusy(false); }
  }

  async function build() {
    if (!draft || !jobId) return;
    setBusy(true);
    setProblem('');
    try { await forgeBuild({ jobId, proposal: draft, mode }); setWatch((was) => was + 1); }
    catch (error) { setProblem((error as Error).message); } finally { setBusy(false); }
  }

  const framework = job?.framework;
  const nameOf = (key: string) => draft?.rooms.find((one) => one.key === key)?.name ?? key;

  return (
    <div className="forge">
      <div className="forge__head">
        <button type="button" className="forge__back" onClick={onBack}>Frameworks</button>
        {job && <span className="forge__spent">{job.calls === 1 ? '1 call used' : `${job.calls} calls used`}</span>}
      </div>

      {!job ? (
        <form className="forge__ask" onSubmit={(event) => { event.preventDefault(); void propose(); }}>
          <p className="forge__lead">Choose what you learned from, say what the team is for, and a team is written from your own notes.</p>
          {notes.length === 0 ? <p className="library__empty">There is nothing in your library yet. Add a note first, and the forge builds from it.</p> : (
            <ul className="forge__notes">
              {notes.map((note) => (
                <li key={note.id}>
                  <label>
                    <input
                      type="checkbox" checked={chosen.includes(note.id)}
                      onChange={(event) => setChosen((was) => (event.target.checked ? [...was, note.id] : was.filter((id) => id !== note.id)))}
                    />
                    <span>{note.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <input aria-label="What is this team for?" placeholder="What is this team for? (a team that pressure-tests a startup idea)" value={intent} onChange={(event) => setIntent(event.target.value)} />
          <div className="forge__modes" role="group" aria-label="How thorough">
            {MODES.map((one) => (
              <button key={one} type="button" className={one === mode ? 'is-on' : ''} aria-pressed={one === mode} onClick={() => setMode(one)}>
                <b>{one === 'quick' ? 'Quick' : 'Full'}</b>
                <small>{callsLine(one)}</small>
              </button>
            ))}
          </div>
          {quota && <p className="forge__quota">{quota}</p>}
          {problem && <p className="msg--problem">{problem}</p>}
          <div className="library__end">
            <button type="submit" className="primary" disabled={busy || !chosen.length || !intent.trim()}>Forge a team</button>
          </div>
        </form>
      ) : (
        <>
          <ol className="forge__steps">
            {FORGE_STEPS.map((step, index) => (
              <li key={step} className={index < reached.current ? 'is-done' : index === reached.current ? (state === 'failed' ? 'is-stuck' : 'is-now') : ''}>
                <span className="forge__mark" />
                {step}
              </li>
            ))}
          </ol>

          {draft && state === 'previewing' && <Preview draft={draft} onChange={setDraft} />}

          {(working || job.lines.length > 0) && (
            <div className="forge__lines" ref={lines}>
              {job.lines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}
            </div>
          )}

          {framework?.scorecard && state === 'done' && (
            <div className="forge__card">
              <b>{framework.name} · {framework.scorecard.mean.toFixed(2)}</b>
              <small>{framework.scorecard.cases === 1 ? '1 case' : `${framework.scorecard.cases} cases`} · {framework.scorecard.models.join(', ')}</small>
              <ul>
                {Object.entries(framework.scorecard.byPerson).map(([key, score]) => (
                  <li key={key}>
                    <span>{nameOf(key)}</span>
                    <b>{score.toFixed(2)}</b>
                    {job.critiques?.[key] && <small>{job.critiques[key]}</small>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(problem || job.error) && (
            <div className="forge__problem">
              <p className="msg--problem">{problem || job.error}</p>
              <button type="button" onClick={() => (draft ? void build() : void propose())}>Try again</button>
            </div>
          )}

          <div className="library__end">
            {working && <button type="button" onClick={() => void stopForge(jobId).catch(() => {})}>Stop</button>}
            {state === 'previewing' && <button type="button" className="primary" disabled={busy || !draft?.rooms.length} onClick={() => void build()}>Build</button>}
            {state === 'done' && framework && <button type="button" className="primary" onClick={() => void onPlace(framework)}>Place</button>}
            {(state === 'done' || state === 'failed') && (
              <button type="button" onClick={() => { setJob(null); setJobId(''); setDraft(null); setProblem(''); reached.current = 0; }}>Forge another</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
