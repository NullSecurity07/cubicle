import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import type { Case, Framework } from '../../shared/frameworks';
import { sizeLine, spanOf } from '../../shared/frameworks';
import { placeFramework, removeFramework, saveFramework } from '../api';
import { MARGIN, refreshFrameworks, useFrameworks } from '../frameworks';
import { useNotes } from '../library';
import { freeSpot } from '../place';
import { overlay } from '../overlay/store';
import { PanelShell } from '../overlay/PanelShell';
import { ForgeView } from './ForgeView';
import { toFlow, type StageNode } from '../stage';
import { useFlushStage } from '../sync';

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
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}
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

// The frameworks the founder has: what each one is for, what it will put on the stage, which of their notes it needs,
// and the one press that lands it.
export function FrameworksPanel() {
  const frameworks = useFrameworks();
  const notes = useNotes();
  const flush = useFlushStage();
  const { fitBounds, getNodes, screenToFlowPosition, setNodes, setEdges } = useReactFlow<StageNode>();
  const [open, setOpen] = useState<string | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState('');
  // Which framework is being asked "really?". Throwing a team away takes two presses, in the place the first one was.
  const [sure, setSure] = useState<string | null>(null);
  // The forge lives inside this panel rather than beside it in the dock: forging a team and keeping one are the same
  // shelf, and a founder who has just built a team is one press from placing it.
  const [forging, setForging] = useState(false);

  async function put(framework: Framework) {
    try { setProblem(''); await saveFramework(framework.id, framework); await refreshFrameworks(); }
    catch (error) { setProblem((error as Error).message); }
  }

  async function land(framework: Framework) {
    setBusy(framework.id);
    try {
      setProblem('');
      // The top-left of what the founder can see, with a margin — and then the nearest place that big where nothing
      // already stands, the same rule a single new card follows. A team dropped on top of the stage the founder
      // already has is five people they then have to dig out from behind their own cards.
      const corner = screenToFlowPosition({ x: MARGIN, y: MARGIN });
      const span = spanOf(framework);
      const at = freeSpot(getNodes(), { x: Math.round(corner.x), y: Math.round(corner.y) }, span.w, span.h);
      const { nodes, edges } = toFlow(await placeFramework(framework.id, at));
      setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...nodes.map((node) => ({ ...node, selected: true }))]);
      setEdges((current) => [...current, ...edges]);
      // Saved at once rather than after the quiet period: the server has already written the docs' words, and the
      // people it just minted have to exist on the stage before anybody can be asked anything. The wait is for the
      // canvas to have drawn them first — saving reads what is on it, not what is about to be.
      await new Promise((drawn) => { setTimeout(drawn, 0); });
      await flush();
      overlay.close({ kind: 'panel', name: 'frameworks' });
      // And the view moves to the team, whole: a group is wider than one card, so the founder should not have to go
      // looking for the five people they just asked for.
      void fitBounds({ x: at.x, y: at.y, width: span.w, height: span.h }, { duration: 400, padding: 0.12 });
    } catch (error) { setProblem((error as Error).message); } finally { setBusy(''); }
  }

  async function forget(framework: Framework) {
    setSure(null);
    try { setProblem(''); await removeFramework(framework.id); await refreshFrameworks(); }
    catch (error) { setProblem((error as Error).message); }
  }

  return (
    <PanelShell name="frameworks" title="Frameworks" note="Teams that land ready to work">
      {forging ? <ForgeView onPlace={land} onBack={() => setForging(false)} /> : (
      <>
      <div className="library__ways">
        <button type="button" onClick={() => { setProblem(''); setForging(true); }}>Forge</button>
        <span className="forge__hint">Build a team from your notes</span>
      </div>
      {problem && <p className="msg--problem">{problem}</p>}
      {frameworks.length === 0 ? <p className="library__empty">Nothing here yet. Select a few cards on the stage and save them as a framework, and they will come back in one press.</p> : (
        <ul className="frameworks__list">
          {frameworks.map((framework) => {
            const missing = framework.notes.filter((note) => !notes.some((held) => held.id === note.id));
            return (
              <li key={framework.id} className="frameworks__one">
                <div className="frameworks__head">
                  <BlocksIcon />
                  <div className="frameworks__what">
                    <b>{framework.name}</b>
                    {framework.intent && <p>{framework.intent}</p>}
                    <small>{sizeLine(framework)}</small>
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
                <div className="frameworks__acts">
                  <button type="button" aria-expanded={open === framework.id} onClick={() => setOpen(open === framework.id ? null : framework.id)}>
                    {framework.dataset.length === 1 ? '1 test case' : `${framework.dataset.length} test cases`}
                  </button>
                  {sure === framework.id ? (
                    <>
                      <span>Remove this team?</span>
                      <button type="button" onClick={() => void forget(framework)}>Remove</button>
                      <button type="button" onClick={() => setSure(null)}>Keep</button>
                    </>
                  ) : <button type="button" onClick={() => { setProblem(''); setSure(framework.id); }}>Remove</button>}
                </div>
                {open === framework.id && <Cases framework={framework} onChanged={put} />}
              </li>
            );
          })}
        </ul>
      )}
      </>
      )}
    </PanelShell>
  );
}
