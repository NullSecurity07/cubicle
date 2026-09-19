import { useReactFlow, type NodeProps } from '@xyflow/react';
import { useEffect, useState, type DragEvent } from 'react';
import { COLUMNS, type Column, type Repeat, type Task } from '../../shared/model';
import { addTask, changeTask, removeTask, runTask, stopTask, watchBoard } from '../api';
import { emit } from '../bus';
import type { BoardNodeType, StageNode } from '../stage';
import { useFlushStage } from '../sync';
import { Approval } from './Approval';
import { CardActions, Frame } from './Frame';
import { Words } from './Message';

const NAMES: Record<Column, string> = { proposed: 'Proposed', todo: 'To do', doing: 'Doing', review: 'Review', done: 'Done' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const repeatWords = (repeat?: Repeat) => (!repeat ? '' : `${repeat.every === 'day' ? 'daily' : repeat.every === 'weekdays' ? 'weekdays' : DAYS[repeat.weekday ?? 1].slice(0, 3)} ${repeat.time}`);
const active = (task: Task) => task.run?.state === 'running' || task.run?.state === 'waiting';

// The founder's task board. People wired to it may propose tasks; only the founder accepts, assigns and runs them.
export function BoardNode({ id, selected }: NodeProps<BoardNodeType>) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const { getNodes, getEdges } = useReactFlow<StageNode>();
  const flushStage = useFlushStage();

  useEffect(() => {
    let stop = () => {};
    let gone = false;
    // The server must know this card before it will stream it.
    void flushStage().then(() => { if (!gone) stop = watchBoard(id, (event) => { if ('tasks' in event) setTasks(event.tasks); else emit('effect', { ...event.effect, roomId: event.roomId }); }); });
    return () => { gone = true; stop(); };
  }, [id, flushStage]);

  // People wired to this board, whichever way the wire was drawn.
  const people = () => {
    const linked = new Set(getEdges().flatMap((edge) => (edge.source === id ? [edge.target] : edge.target === id ? [edge.source] : [])));
    return getNodes().filter((node) => node.type === 'room' && linked.has(node.id) && node.data.name).map((node) => ({ id: node.id, name: (node.data as { name: string }).name, accent: (node.data as { accent: string }).accent }));
  };
  const who = (roomId?: string) => getNodes().find((node) => node.id === roomId)?.data as { name?: string; accent?: string } | undefined;
  const act = (job: Promise<unknown>) => { setProblem(''); job.catch((error: Error) => setProblem(error.message)); };
  const open = tasks.find((task) => task.id === openId);
  const waiting = tasks.filter((task) => task.run?.state === 'waiting').length;

  function drop(event: DragEvent, column: Column) {
    event.preventDefault();
    const taskId = event.dataTransfer.getData('text/task');
    if (taskId) act(changeTask(id, taskId, { column }));
  }
  function create() {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    act(addTask(id, title));
  }

  return (
    <Frame selected={!!selected} minWidth={640} minHeight={300}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.500" width="12" height="11" rx="1.800" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M6 2.500v11M10 2.500v11" stroke="currentColor" strokeWidth="1.2" /></svg>
        <div className="card__name">Board</div>
        {waiting > 0 && <span className="board__badge" title="Tasks waiting for your OK">{waiting} need{waiting === 1 ? 's' : ''} you</span>}
        <CardActions id={id} what="this board (its tasks stay in the workspace)" />
      </header>
      <div className="board nodrag nowheel">
        {COLUMNS.map((column) => {
          const mine = tasks.filter((task) => task.column === column);
          return (
            <section key={column} className="board__column" aria-label={NAMES[column]} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, column)}>
              <h3>{NAMES[column]} <span>{mine.length || ''}</span></h3>
              <div className="board__tasks">
                {mine.map((task) => (
                  <button key={task.id} type="button" className={`task task--${task.run?.state ?? 'idle'}`} draggable onDragStart={(event) => event.dataTransfer.setData('text/task', task.id)} onClick={() => setOpenId(task.id)}>
                    <span className="task__title">{task.title}</span>
                    <span className="task__meta">
                      {task.assignee && <i style={{ background: who(task.assignee)?.accent }} />}{who(task.assignee)?.name}
                      {task.proposedBy && column === 'proposed' && <>from {task.proposedBy}</>}
                      {task.repeat && <em>↻ {repeatWords(task.repeat)}</em>}
                      {task.missed && <em className="task__missed">missed</em>}
                      {task.run?.state === 'waiting' && <em className="task__needs">needs you</em>}
                      {task.run?.state === 'running' && <em>working…</em>}
                      {task.run?.state === 'failed' && <em className="task__missed">failed</em>}
                    </span>
                  </button>
                ))}
              </div>
              {column === 'todo' && (
                <form onSubmit={(event) => { event.preventDefault(); create(); }}>
                  <input aria-label="New task" placeholder="Add a task…" value={draft} onChange={(event) => setDraft(event.target.value)} />
                </form>
              )}
            </section>
          );
        })}
      </div>
      {problem && <p className="board__problem nodrag">{problem}</p>}
      {open && (
        <div className="taskview nodrag nowheel" role="dialog" aria-label={open.title}>
          <div className="taskview__head">
            <input aria-label="Task title" defaultValue={open.title} key={`${open.id}-title`} onBlur={(event) => event.target.value.trim() !== open.title && act(changeTask(id, open.id, { title: event.target.value }))} />
            <button type="button" aria-label="Close task" onClick={() => setOpenId(null)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
          <div className="taskview__body">
            <div className="taskview__side">
              <label>What done looks like
                <textarea rows={4} aria-label="Task detail" defaultValue={open.detail} key={`${open.id}-detail`} placeholder="Anything the person needs to know" onBlur={(event) => event.target.value !== open.detail && act(changeTask(id, open.id, { detail: event.target.value }))} />
              </label>
              <label>Who
                <select aria-label="Assignee" value={open.assignee ?? ''} onChange={(event) => act(changeTask(id, open.id, { assignee: event.target.value }))}>
                  <option value="">Nobody yet</option>
                  {people().map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                  {open.assignee && !people().some((person) => person.id === open.assignee) && <option value={open.assignee}>{who(open.assignee)?.name ?? 'someone'} (not wired)</option>}
                </select>
              </label>
              {people().length === 0 && <p className="taskview__hint">Draw a wire from a person to this board to give them tasks.</p>}
              <label>Column
                <select aria-label="Column" value={open.column} onChange={(event) => act(changeTask(id, open.id, { column: event.target.value as Column }))}>
                  {COLUMNS.map((column) => <option key={column} value={column}>{NAMES[column]}</option>)}
                </select>
              </label>
              <label>Repeat
                <span className="taskview__repeat">
                  <select aria-label="Repeat" value={open.repeat?.every ?? ''} onChange={(event) => act(changeTask(id, open.id, { repeat: event.target.value ? { every: event.target.value as Repeat['every'], time: open.repeat?.time ?? '09:00', weekday: open.repeat?.weekday ?? 1 } : null }))}>
                    <option value="">Off</option><option value="day">Every day</option><option value="weekdays">Weekdays</option><option value="week">Every week</option>
                  </select>
                  {open.repeat?.every === 'week' && (
                    <select aria-label="Day" value={open.repeat.weekday ?? 1} onChange={(event) => act(changeTask(id, open.id, { repeat: { ...open.repeat!, weekday: Number(event.target.value) } }))}>
                      {DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
                    </select>
                  )}
                  {open.repeat && <input type="time" aria-label="Time" value={open.repeat.time} onChange={(event) => event.target.value && act(changeTask(id, open.id, { repeat: { ...open.repeat!, time: event.target.value } }))} />}
                </span>
              </label>
              {open.repeat && <p className="taskview__hint">Runs only while the app is open. {open.missed ? 'The last one was missed; press Run to catch up.' : open.nextRun ? `Next: ${new Date(open.nextRun).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : ''}</p>}
              <div className="taskview__end">
                <button type="button" className="danger" onClick={() => { act(removeTask(id, open.id)); setOpenId(null); }}>Remove</button>
                {open.column === 'proposed' && <button type="button" onClick={() => act(changeTask(id, open.id, { column: 'todo' }))}>Accept</button>}
                {active(open)
                  ? <button type="button" onClick={() => act(stopTask(id, open.id))}>Stop</button>
                  : <button type="button" className="primary" disabled={!open.assignee} title={open.assignee ? '' : 'Give the task to a person first'} onClick={() => act(runTask(id, open.id))}>{open.run ? 'Run again' : 'Run'}</button>}
              </div>
            </div>
            <div className="taskview__run">
              {!open.run && <p className="chat__empty">{open.proposedBy ? `${open.proposedBy} suggested this. ` : ''}Give it to a person and press Run. They work in the background and the result lands in Review for you.</p>}
              {open.run && <div className="taskview__log">{open.run.log.map((entry, index) => <div key={index}>{entry}</div>)}</div>}
              {open.run?.approval && <Approval tool={open.run.approval} />}
              {open.run?.result && <div className="md taskview__result"><Words text={open.run.result} /></div>}
              {open.run?.provider && <div className="msg__foot">{open.run.provider} · {open.run.model}{open.run.usage ? ` · ${open.run.usage.input + open.run.usage.output} tokens` : ''} · {open.run.state}</div>}
            </div>
          </div>
        </div>
      )}
    </Frame>
  );
}
