import { useEffect, useState } from 'react';
import { parseSchedule, sayRepeat } from '../../../shared/automation';
import type { Skill, Task } from '../../../shared/model';
import { listSkills, setAutomation, type AutomationPatch } from './api';
import './automation.css';
import { pressed } from '../../keys';

// What a task does without the founder: when it runs, whether it is a script rather than a person, the skill it works
// from and the task it waits for. It lives inside the task view and uses that view's own labels and boxes, so it reads
// as one column with everything else.

const STARTER = {
  javascript: "// What this prints is the result.\nconsole.log('It ran.');",
  python: '# What this prints is the result.\nprint("It ran.")',
};
const moment = (at: number) => new Date(at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
// A one-off cannot be written back as the words that made it, so the field is left empty and the hint says when it is.
const wordsFor = (task: Task) => (task.repeat && task.repeat.every !== 'once' ? sayRepeat(task.repeat) : '');

export function Automation({ boardId, task, tasks, act }: { boardId: string; task: Task; tasks: Task[]; act: (job: Promise<unknown>) => void }) {
  const [typed, setTyped] = useState(() => wordsFor(task));
  const [saved, setSaved] = useState(() => wordsFor(task));
  const [code, setCode] = useState(task.script?.code ?? '');
  const [skills, setSkills] = useState<Skill[]>([]);

  useEffect(() => { void listSkills().then((held) => setSkills(held.filter((one) => one.state !== 'off'))).catch(() => {}); }, []);

  const set = (patch: AutomationPatch) => act(setAutomation(boardId, task.id, patch));
  const read = typed.trim() ? parseSchedule(typed, Date.now()) : null;
  const language = task.script?.language ?? 'javascript';

  // Kept when they leave the field, and only when it says something new: a sentence half typed is never a schedule.
  function keep() {
    if (typed === saved) return;
    if (!typed.trim()) { setSaved(''); set({ repeat: null }); return; }
    if (read && 'repeat' in read) { setSaved(typed); set({ repeat: read.repeat }); }
  }

  return (
    <div className="automation">
      <label>When it runs
        <input
          aria-label="When it runs" placeholder="every day at 9am" value={typed}
          onChange={(event) => setTyped(event.target.value)} onBlur={keep}
          onKeyDown={(event) => { if (pressed(event, 'send')) { event.preventDefault(); keep(); } }}
        />
      </label>
      {read && 'problem' in read && <p className="taskview__hint automation__problem">{read.problem}</p>}
      {read && 'repeat' in read && <p className="taskview__hint">Next: {moment(read.next)}. {read.note ?? 'It runs only while the app is open.'}</p>}
      {!read && (
        <p className="taskview__hint">
          {task.repeat?.every === 'once' && task.nextRun ? `Runs once, ${moment(task.nextRun)}. ` : task.missed ? 'The last one was missed. ' : ''}
          Say it in words: every day at 9am, weekdays at 9, mondays at 14:30, every 30 minutes, in 2 hours.
        </p>
      )}
      {task.repeat && (
        <label>If one is missed while the app is closed
          <select aria-label="If one is missed" value={task.onMissed ?? ''} onChange={(event) => set({ onMissed: event.target.value as 'once' | 'skip' })}>
            <option value="">Whatever suits this schedule</option>
            <option value="once">Run it once when I am back</option>
            <option value="skip">Leave it until the next one</option>
          </select>
        </label>
      )}
      <label>How it is done
        <select
          aria-label="How it is done" value={task.script ? 'script' : 'person'}
          onChange={(event) => { const asked = event.target.value === 'script'; setCode(asked ? code || STARTER.javascript : code); set({ script: asked ? { language: 'javascript', code: code || STARTER.javascript } : null }); }}
        >
          <option value="person">By a person</option>
          <option value="script">By a small script</option>
        </select>
      </label>
      {task.script && (
        <>
          <label>Written in
            <select aria-label="Written in" value={language} onChange={(event) => { const next = event.target.value as 'javascript' | 'python'; const swap = code.trim() === STARTER[language] ? STARTER[next] : code; setCode(swap); set({ script: { language: next, code: swap } }); }}>
              <option value="javascript">JavaScript</option>
              <option value="python">Python</option>
            </select>
          </label>
          <label>The script
            <textarea
              aria-label="The script" className="automation__code" rows={7} spellCheck={false} value={code}
              onChange={(event) => setCode(event.target.value)}
              onBlur={() => { if (code !== (task.script?.code ?? '')) set({ script: { language, code } }); }}
            />
          </label>
          <p className="taskview__hint">It runs here on this machine, with no way out to the internet, and nobody is asked to think about it. What it prints is the result.</p>
        </>
      )}
      {!task.script && (
        <label>Work from a skill
          <select aria-label="Work from a skill" value={task.skill ?? ''} onChange={(event) => set({ skill: event.target.value })}>
            <option value="">Nothing in particular</option>
            {skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}
            {task.skill && !skills.some((skill) => skill.id === task.skill) && <option value={task.skill}>{task.skill} (gone or switched off)</option>}
          </select>
        </label>
      )}
      <label>Start it after
        <select aria-label="Start it after" value={task.after ?? ''} onChange={(event) => set({ after: event.target.value })}>
          <option value="">Nothing — I start it</option>
          {tasks.filter((one) => one.id !== task.id).map((one) => <option key={one.id} value={one.id}>{one.title}</option>)}
        </select>
      </label>
      {task.after && <p className="taskview__hint">It starts on its own when that task is done, and reads what came of it as material.</p>}
    </div>
  );
}
