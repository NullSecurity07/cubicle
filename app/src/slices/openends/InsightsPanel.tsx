import { useEffect, useRef, useState } from 'react';
import type { Skill } from '../../../shared/model';
import type { Insights, Share } from '../../../shared/openends';
import { PanelShell } from '../../overlay/PanelShell';
import { usePlaybook } from '../../overlay/playbook';
import { bringInSkill, getInsights, readPicked, saveAs, skillAsFile } from './api';

// What the work came to, out of what was already written down: no request leaves this machine to work it out.
// The bars read like the rings in the dock — one length, one colour, the numbers in the same tabular figures.
const whole = (count: number) => count.toLocaleString();
const WINDOWS = [7, 30] as const;

function Bars({ title, rows, empty }: { title: string; rows: Share[]; empty: string }) {
  const most = Math.max(1, ...rows.map((one) => one.tokens));
  return (
    <section className="insights__part">
      <h3>{title}</h3>
      {!rows.length && <p className="panel__empty">{empty}</p>}
      {rows.length > 0 && (
        <ul className="insights__bars">
          {rows.map((row) => (
            <li key={row.name}>
              <span className="insights__name">{row.name}</span>
              <span className="insights__track"><span className="insights__fill" style={{ width: `${Math.max(2, Math.round((row.tokens / most) * 100))}%` }} /></span>
              <span className="insights__numbers">{whole(row.tokens)}<small>{row.turns === 1 ? '1 turn' : `${whole(row.turns)} turns`}{row.failed ? ` · ${whole(row.failed)} failed` : ''}</small></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// A skill can travel: one file out, one file in. What comes in goes through the same door everything else does, so
// the same limits hold, and it arrives switched off until you have read it.
function Travelling() {
  const { skills } = usePlaybook();
  const [chosen, setChosen] = useState('');
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const id = chosen || skills[0]?.id || '';

  async function out() {
    setProblem('');
    setSaid('');
    try { const file = await skillAsFile(id); saveAs(file.file, file.text); setSaid(`Saved "${skills.find((one) => one.id === id)?.name}" as ${file.file}.`); }
    catch (error) { setProblem((error as Error).message); }
  }
  async function into(file: File | undefined) {
    setProblem('');
    setSaid('');
    if (!file) return;
    try { const born: Skill = await bringInSkill(await readPicked(file)); setSaid(`Brought in "${born.name}". It is switched off until you have read it, in the playbook.`); }
    catch (error) { setProblem((error as Error).message); }
    finally { if (picker.current) picker.current.value = ''; }
  }

  return (
    <section className="insights__part">
      <h3>Skills in and out</h3>
      <p className="playbook__note">A skill is one small file. Take one somewhere else, or bring one back — it lands switched off, and you decide.</p>
      <div className="insights__travel">
        <select aria-label="Skill to save" value={id} disabled={!skills.length} onChange={(event) => setChosen(event.target.value)}>
          {!skills.length && <option value="">Nothing learned yet</option>}
          {skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
        </select>
        <button type="button" className="playbook__act" disabled={!id} onClick={() => void out()}>Save to a file</button>
        {/* The browser's own file button looks like nothing else here, so the label is the button and the input hides behind it. */}
        <label className="playbook__act primary insights__pick">
          Bring one in
          <input ref={picker} type="file" accept=".md,text/markdown,text/plain" aria-label="Bring in a skill file" onChange={(event) => void into(event.target.files?.[0])} />
        </label>
      </div>
      {said && <p className="playbook__note insights__said">{said}</p>}
      {problem && <p className="msg--problem">{problem}</p>}
    </section>
  );
}

export function InsightsPanel() {
  const [days, setDays] = useState<number>(WINDOWS[0]);
  const [held, setHeld] = useState<Insights | null>(null);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let live = true;
    getInsights(days).then((found) => { if (live) setHeld(found); }, (error: Error) => { if (live) setProblem(error.message); });
    return () => { live = false; };
  }, [days]);

  const nothing = held && !held.turns;
  return (
    <PanelShell name="insights" title="Insights" note={held ? (held.turns === 1 ? '1 turn' : `${whole(held.turns)} turns`) : undefined}>
      <div className="insights">
        <div className="insights__when" role="group" aria-label="How far back">
          {WINDOWS.map((window) => (
            <button key={window} type="button" className={`playbook__act${days === window ? ' primary' : ''}`} aria-pressed={days === window} onClick={() => setDays(window)}>
              Last {window} days
            </button>
          ))}
        </div>
        {problem && <p className="msg--problem">{problem}</p>}
        {nothing && <p className="panel__empty">Nothing to show for these days yet. This fills itself in as the people work — you never have to set anything up.</p>}
        {held && !nothing && (
          <>
            <ul className="insights__totals">
              <li><b>{whole(held.input + held.output)}</b><small>tokens, all free</small></li>
              <li><b>{whole(held.turns)}</b><small>{held.turns === 1 ? 'turn' : 'turns'}</small></li>
              <li><b>{whole(held.tools)}</b><small>tool calls{held.failed ? `, ${whole(held.failed)} failed` : ''}</small></li>
              <li><b>{whole(held.skills.learned)}</b><small>things learned</small></li>
            </ul>
            <Bars title="Who did the work" rows={held.people} empty="Nobody has been asked anything yet." />
            <Bars title="Which model answered" rows={held.providers} empty="No model has answered yet." />
          </>
        )}
        {/* The one number here that is about right now: what is left of each free day, the same share the rings show. */}
        {held && held.today.length > 0 && (
          <section className="insights__part">
            <h3>Today<span>free allowance left</span></h3>
            <ul className="insights__bars insights__today">
              {held.today.map((one) => (
                <li key={one.name}>
                  <span className="insights__name">{one.name}</span>
                  <span className="insights__track"><span className={`insights__fill ring--${one.left <= 0.05 ? 'out' : one.left < 0.2 ? 'low' : 'fine'}`} style={{ width: `${Math.round(one.left * 100)}%` }} /></span>
                  <span className="insights__numbers">{Math.round(one.left * 100)}% left<small>{one.requests === 1 ? '1 reply' : `${whole(one.requests)} replies`} · $0</small></span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {held && (
          <p className="playbook__note">
            {whole(held.skills.active)} {held.skills.active === 1 ? 'skill is' : 'skills are'} in use, and {whole(held.skills.used)} {held.skills.used === 1 ? 'was' : 'were'} reached for in these days.
          </p>
        )}
        <Travelling />
      </div>
    </PanelShell>
  );
}
