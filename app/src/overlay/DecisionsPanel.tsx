import { useEffect, useState } from 'react';
import type { Decision } from '../../shared/model';
import { decide, getDecisions, recordDecision, removeDecision } from '../api';
import { useAttention } from './attention';
import { PanelShell } from './PanelShell';
import { showDecision, useDecision } from './store';

const date = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
type Verdict = { title: string; context: string; chosen: string; why: string; effect: string; review: string };

// The form the founder decides in: pick one of the options or write another, say why, and when to look again.
// `onWhy` hears the Why as it is typed: a proposal declined keeps it as the reason for the no (journey 17).
function DecideForm({ decision, onDone, onWhy }: { decision: Decision | null; onDone: (saved: Decision) => void; onWhy?: (why: string) => void }) {
  const [draft, setDraft] = useState<Verdict>({ title: '', context: '', chosen: decision?.chosen ?? '', why: decision?.why ?? '', effect: decision?.effect ?? '', review: decision?.review ?? '' });
  const [state, setState] = useState<'idle' | 'saving'>('idle');
  const [problem, setProblem] = useState('');
  const set = (patch: Partial<Verdict>) => setDraft((current) => ({ ...current, ...patch }));

  async function save() {
    setState('saving'); setProblem('');
    try {
      const { title, context, ...verdict } = draft;
      onDone(decision ? await decide(decision.id, verdict) : await recordDecision({ title, context, options: [], ...verdict }));
    } catch (error) { setProblem((error as Error).message); setState('idle'); }
  }

  return (
    <form className="decide" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {!decision && <>
        <label>What is decided<input aria-label="Title" value={draft.title} placeholder="Pricing model" onChange={(event) => set({ title: event.target.value })} /></label>
        <label>Context<textarea aria-label="Context" rows={3} value={draft.context} placeholder="What led to this, and what depends on it" onChange={(event) => set({ context: event.target.value })} /></label>
      </>}
      {!!decision?.options.length && (
        <fieldset>
          <legend>Options</legend>
          {decision.options.map((option, index) => (
            <label key={option} className={`decide__option${draft.chosen === option ? ' is-chosen' : ''}`}>
              <input type="radio" name="chosen" checked={draft.chosen === option} onChange={() => set({ chosen: option })} />
              <kbd>{index + 1}</kbd><span>{option}</span>
            </label>
          ))}
        </fieldset>
      )}
      <label>{decision?.options.length ? 'Chosen (pick above, or write your own)' : 'Chosen'}<input aria-label="Chosen" value={draft.chosen} placeholder="What you decided" onChange={(event) => set({ chosen: event.target.value })} /></label>
      <label>Why<textarea aria-label="Why" rows={3} value={draft.why} placeholder="The reason, for you in three months" onChange={(event) => { set({ why: event.target.value }); onWhy?.(event.target.value); }} /></label>
      <label>Expected effect<textarea aria-label="Expected effect" rows={2} value={draft.effect} placeholder="What should be different if this was right" onChange={(event) => set({ effect: event.target.value })} /></label>
      <label className="decide__date">Look at it again on<input type="date" aria-label="Review date" value={draft.review} onChange={(event) => set({ review: event.target.value })} /></label>
      {problem && <p className="msg--problem">{problem}</p>}
      <div className="decide__end"><button type="submit" className="primary" disabled={state === 'saving' || !draft.chosen.trim() || (!decision && !draft.title.trim())}>{decision?.status === 'decided' ? 'Save' : 'Decide'}</button></div>
    </form>
  );
}

// The founder's decisions: what was on the table, what was chosen and why. People propose; only the founder decides.
export function DecisionsPanel() {
  const [list, setList] = useState<Decision[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState('');
  // The Why typed on a proposal, sent with Decline so the no keeps its reason.
  const [why, setWhy] = useState('');
  const open = useDecision();
  const waiting = useAttention();

  const load = () => getDecisions().then(setList).catch((error: Error) => setProblem(error.message));
  // A proposal arriving, or one answered elsewhere, changes the founder's list: read again when it does.
  useEffect(() => { void load(); }, [waiting]);
  useEffect(() => { setEditing(false); setWhy(''); }, [open]);
  useEffect(() => { if (list?.length && open !== 'new' && !list.some((one) => one.id === open)) showDecision(list[0].id); }, [list, open]);

  const current = list?.find((one) => one.id === open) ?? null;
  const proposals = list?.filter((one) => one.status === 'proposed') ?? [];
  const decided = list?.filter((one) => one.status === 'decided') ?? [];
  const row = (one: Decision) => (
    <li key={one.id}>
      <button type="button" className={`${one.id === open ? 'is-open' : ''}${one.status === 'proposed' ? ' is-waiting' : ''}`} aria-current={one.id === open ? 'true' : undefined} onClick={() => showDecision(one.id)}>
        <span className="threads__text"><b>{one.title}</b><small>{one.status === 'proposed' ? `${one.proposedBy ?? 'Someone'} asks · ${one.options.length} options` : one.chosen}</small></span>
        <time>{date(one.decidedAt ?? one.at)}</time>
      </button>
    </li>
  );
  const done = (saved: Decision) => { setEditing(false); showDecision(saved.id); void load(); };

  return (
    <PanelShell name="decisions" title="Decisions" note={proposals.length ? `${proposals.length} to decide` : undefined} wide>
      <div className={`threads${open ? ' has-open' : ''}`}>
        <nav className="threads__list" aria-label="All decisions">
          <button type="button" className="decisions__new" onClick={() => showDecision('new')}>Record a decision</button>
          {list?.length === 0 && <p className="panel__empty">Nothing decided yet. Record one, or let a person lay a choice out for you.</p>}
          {proposals.length > 0 && <><h3>Waiting for you</h3><ul>{proposals.map(row)}</ul></>}
          {decided.length > 0 && <><h3>Decided</h3><ul>{decided.map(row)}</ul></>}
        </nav>
        <div className="threads__pane decision">
          <button type="button" className="threads__back" onClick={() => showDecision(null)}>All decisions</button>
          {problem && <p className="msg--problem">{problem}</p>}
          {open === 'new' && <><h3 className="decision__title">Record a decision</h3><DecideForm decision={null} onDone={done} /></>}
          {current && (
            <article aria-label={current.title}>
              <h3 className="decision__title">{current.title}</h3>
              <p className="decision__meta">{current.status === 'proposed' ? `${current.proposedBy ?? 'Someone'} laid this out on ${date(current.at)}. It is yours to decide.` : `Decided on ${date(current.decidedAt ?? current.at)}${current.proposedBy ? `, laid out by ${current.proposedBy}` : ''}${current.review ? ` · look again on ${current.review}` : ''}`}</p>
              {current.context && <section><h4>Context</h4><p>{current.context}</p></section>}
              {current.recommendation && <section><h4>{current.proposedBy ?? 'They'} would pick</h4><p>{current.recommendation}</p></section>}
              {current.status === 'proposed' || editing ? <DecideForm key={current.id} decision={current} onDone={done} onWhy={setWhy} /> : <>
                {current.options.length > 0 && <section><h4>Options that were on the table</h4><ol>{current.options.map((option) => <li key={option} className={option === current.chosen ? 'is-chosen' : undefined}>{option}</li>)}</ol></section>}
                <section><h4>Chosen</h4><p className="decision__chosen">{current.chosen}</p></section>
                {current.why && <section><h4>Why</h4><p>{current.why}</p></section>}
                {current.effect && <section><h4>Expected effect</h4><p>{current.effect}</p></section>}
              </>}
              <div className="decision__end">
                <button type="button" onClick={() => { removeDecision(current.id, current.status === 'proposed' ? why : undefined).then(() => { showDecision(null); void load(); }).catch((error: Error) => setProblem(error.message)); }}>{current.status === 'proposed' ? 'Decline' : 'Remove'}</button>
                {current.status === 'decided' && !editing && <button type="button" onClick={() => setEditing(true)}>Change</button>}
              </div>
            </article>
          )}
        </div>
      </div>
    </PanelShell>
  );
}
