import { useEffect, useRef, useState } from 'react';
import type { Skill } from '../../shared/model';
import { changeSkill, getFounder, putFounder, removeSkill } from '../api';
import { PanelShell } from '../overlay/PanelShell';
import { usePlaybook } from '../overlay/playbook';
import { showPlaybook, usePlaybookAt } from '../overlay/store';

const PROFILE_CHARS = 1200;
const whole = (count: number) => count.toLocaleString();
type Draft = Pick<Skill, 'name' | 'when' | 'procedure' | 'pitfalls' | 'verify'>;
const draftOf = (skill: Skill): Draft => ({ name: skill.name, when: skill.when, procedure: [...skill.procedure], pitfalls: [...skill.pitfalls], verify: skill.verify });
const timesUsed = (uses: number) => (uses === 0 ? 'not used yet' : uses === 1 ? 'used once' : `used ${uses} times`);

// The page every person has read about the founder. Small on purpose, and theirs to rewrite: a line a person added
// here can be changed or taken out like any other.
function AboutYou() {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'problem'>('idle');
  const [problem, setProblem] = useState('');

  useEffect(() => { getFounder().then((held) => { setText(held); setSaved(held); }).catch((error: Error) => { setState('problem'); setProblem(error.message); }); }, []);

  const size = text?.length ?? 0;
  const over = size - PROFILE_CHARS;
  async function save() {
    setState('saving');
    setProblem('');
    try { await putFounder(text ?? ''); setSaved(text ?? ''); setState('idle'); } catch (error) { setState('problem'); setProblem((error as Error).message); }
  }

  return (
    <section className="playbook__you">
      <h3>About you<span className={over > 0 ? 'is-over' : undefined}>{whole(size)} of {whole(PROFILE_CHARS)} characters</span></h3>
      <textarea
        aria-label="About you" rows={5} value={text ?? ''} disabled={text === null}
        placeholder="How you like to be answered, what you care about, anything you find yourself saying twice."
        onChange={(event) => setText(event.target.value)}
      />
      <p className="playbook__note">Everyone here reads this before they answer you, and adds a line now and then. Every line is yours to change.</p>
      {over > 0 && <p className="msg--problem">That is {whole(over)} characters more than fits. Take a line out, or say it shorter.</p>}
      {state === 'problem' && <p className="msg--problem">{problem}</p>}
      <div className="playbook__end">
        <button type="button" className="playbook__act primary" disabled={text === null || text === saved || over > 0 || state === 'saving'} onClick={() => void save()}>Save</button>
      </div>
    </section>
  );
}

// One thing the people learned. Closed it is a name and who learned it; open it is the whole lesson, and the founder
// can rewrite any part of it, switch it out of everybody's prompts, put their last change back, or throw it away.
function SkillRow({ skill, open, mine, onOpen }: { skill: Skill; open: boolean; mine: boolean; onOpen: (id: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(skill));
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const row = useRef<HTMLLIElement>(null);

  useEffect(() => { if (open) row.current?.scrollIntoView({ block: 'nearest' }); }, [open]);

  async function attempt(work: Promise<unknown>) {
    setProblem('');
    setBusy(true);
    // The server answers an over-long edit with the sentence that says which part is too long: the founder reads it here.
    try { await work; return true; } catch (error) { setProblem((error as Error).message); return false; } finally { setBusy(false); }
  }
  function edit() {
    setDraft(draftOf(skill));
    setEditing(true);
    if (!open) onOpen(skill.id);
  }

  return (
    <li ref={row} className={`skill${open ? ' is-open' : ''}${skill.state === 'active' ? '' : ' is-off'}${mine ? ' is-theirs' : ''}`}>
      <div className="skill__head">
        <button type="button" className="skill__name" aria-expanded={open} onClick={() => onOpen(open ? null : skill.id)}>
          <svg className="skill__mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 4l4 4-4 4" /></svg>
          <b>{skill.name}</b>
          <small>{skill.by.name} learned this · {timesUsed(skill.uses)}</small>
        </button>
        <div className="skill__acts">
          <button type="button" className="playbook__act" onClick={edit}>Edit</button>
          {skill.history.length > 0 && <button type="button" className="playbook__act" disabled={busy} onClick={() => void attempt(changeSkill(skill.id, { undo: true }))}>Undo last change</button>}
          <button type="button" className="playbook__act" onClick={() => setAsking(true)}>Delete</button>
        </div>
        <label className="skill__switch" title={skill.state === 'active' ? 'In use' : 'Not in use'}>
          <input
            type="checkbox" checked={skill.state === 'active'} disabled={busy}
            aria-label={`Use "${skill.name}"`}
            onChange={(event) => void attempt(changeSkill(skill.id, { state: event.target.checked ? 'active' : 'off' }))}
          />
          <span />
        </label>
      </div>
      {asking && (
        <div className="skill__ask" role="alertdialog" aria-label={`Delete ${skill.name}`}>
          <p>Delete this? Its file moves to the workspace trash.</p>
          <button type="button" className="playbook__act" onClick={() => setAsking(false)}>Keep</button>
          <button type="button" className="playbook__act danger" disabled={busy} onClick={() => void attempt(removeSkill(skill.id))}>Delete</button>
        </div>
      )}
      {open && !editing && (
        <div className="skill__detail">
          <div><h4>When</h4><p>{skill.when}</p></div>
          <div><h4>What to do</h4><ol>{skill.procedure.map((step, at) => <li key={at}>{step}</li>)}</ol></div>
          {skill.pitfalls.length > 0 && <div><h4>Watch out for</h4><ul>{skill.pitfalls.map((one, at) => <li key={at}>{one}</li>)}</ul></div>}
          <div><h4>Done when</h4><p>{skill.verify}</p></div>
          {skill.state !== 'active' && <p className="playbook__note">Switched off, so nobody is shown it. It stays here until you throw it away.</p>}
          {problem && <p className="msg--problem">{problem}</p>}
        </div>
      )}
      {open && editing && (
        <div className="skill__detail">
          <label>Name<input aria-label="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label>When it applies<textarea aria-label="When it applies" rows={2} value={draft.when} onChange={(event) => setDraft({ ...draft, when: event.target.value })} /></label>
          <label>What to do, one step to a line<textarea aria-label="What to do" rows={Math.max(3, draft.procedure.length + 1)} value={draft.procedure.join('\n')} onChange={(event) => setDraft({ ...draft, procedure: event.target.value.split('\n') })} /></label>
          <label>Watch out for, one to a line<textarea aria-label="Watch out for" rows={Math.max(2, draft.pitfalls.length + 1)} value={draft.pitfalls.join('\n')} onChange={(event) => setDraft({ ...draft, pitfalls: event.target.value.split('\n') })} /></label>
          <label>Done when<textarea aria-label="Done when" rows={2} value={draft.verify} onChange={(event) => setDraft({ ...draft, verify: event.target.value })} /></label>
          {problem && <p className="msg--problem">{problem}</p>}
          <div className="playbook__end">
            <button type="button" className="playbook__act" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="playbook__act primary" disabled={busy} onClick={() => { void attempt(changeSkill(skill.id, draft)).then((done) => { if (done) setEditing(false); }); }}>Save</button>
          </div>
        </div>
      )}
    </li>
  );
}

// The one playbook everybody shares. Nothing in it was asked for, so everything in it can be read, rewritten,
// switched off or thrown away — and it is always what the people are really working from, live.
export function PlaybookPanel() {
  const { skills, ready } = usePlaybook();
  const at = usePlaybookAt();
  const [open, setOpen] = useState<string | null>(null);

  // Opened from the line in a chat: that one skill is what the founder came for. It is found once, so closing it stays closed.
  const wanted = at.skill ? skills.find((one) => one.name === at.skill)?.id : undefined;
  useEffect(() => { if (wanted) setOpen(wanted); }, [wanted]);
  useEffect(() => () => showPlaybook({}), []);

  const theirs = at.roomId;
  const whose = theirs ? skills.find((one) => one.by.roomId === theirs)?.by.name : undefined;
  const asleep = skills.filter((one) => one.state === 'stale');
  const live = skills.filter((one) => one.state !== 'stale');
  const row = (skill: Skill) => <SkillRow key={skill.id} skill={skill} open={skill.id === open} mine={!!theirs && skill.by.roomId === theirs} onOpen={setOpen} />;

  return (
    <PanelShell name="playbook" title="Playbook" note={skills.length ? `${skills.length} ${skills.length === 1 ? 'thing' : 'things'} learned` : undefined}>
      <div className="playbook">
        <AboutYou />
        <section>
          <h3>What the people learned{whose && <span>{whose}'s are marked</span>}</h3>
          {!skills.length && ready && (
            <p className="panel__empty">
              Nothing here yet, and nothing to set up. People pick things up as they work — from a task they finish, and
              from the times you put them right — and whatever they learn lands here for you to read or change.
            </p>
          )}
          {live.length > 0 && <ul className="skills">{live.map(row)}</ul>}
          {asleep.length > 0 && (
            <details className="skill__folded">
              <summary>Not used lately ({asleep.length})</summary>
              <ul className="skills">{asleep.map(row)}</ul>
            </details>
          )}
        </section>
      </div>
    </PanelShell>
  );
}
