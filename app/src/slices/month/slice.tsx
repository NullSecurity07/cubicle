import { useEffect, useSyncExternalStore } from 'react';
import type { UiSlice } from '..';
import type { Task } from '../../../shared/model';
import { request, send } from '../../api';
import { useJumpTo } from '../../flow';
import './month.css';

// The monthly investor update as a board template: one command puts "Draft the <month> update" on the first board,
// repeating on the first weekday of every month, with the monthly-update skill and the person wired to the board.
// What happened is said in one quiet line at the foot of the window, with a way to the board.

type Said = { text: string; boardId?: string; problem?: true } | null;
let said: Said = null;
const hearers = new Set<() => void>();
const say = (next: Said) => { said = next; for (const tell of hearers) tell(); };
const useSaid = () => useSyncExternalStore((tell) => { hearers.add(tell); return () => { hearers.delete(tell); }; }, () => said);

function addTemplate() {
  request<{ boardId: string; task: Task; added: boolean }>('/api/month/template', send('POST', {}))
    .then(({ boardId, task, added }) => say({
      boardId,
      text: added
        ? `"${task.title}" is on your board. It runs on the first weekday of each month at 09:00${task.assignee ? '' : ' once you give it to a person'}.`
        : `"${task.title}" is already on your board.`,
    }))
    .catch((error: Error) => say({ text: error.message, problem: true }));
}

function MonthNotice() {
  const now = useSaid();
  const jumpTo = useJumpTo();
  useEffect(() => {
    if (!now) return;
    const timer = setTimeout(() => say(null), 7000);
    return () => clearTimeout(timer);
  }, [now]);
  if (!now) return null;
  return (
    <div className={`month-notice${now.problem ? ' is-problem' : ''}`} role="status">
      <span>{now.text}</span>
      {now.boardId && <button type="button" onClick={() => { jumpTo(now.boardId!); say(null); }}>Show</button>}
      <button type="button" className="month-notice__close" aria-label="Close" onClick={() => say(null)}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.500 3.500l5 5M8.500 3.500l-5 5" /></svg>
      </button>
    </div>
  );
}

export default {
  name: 'month',
  commands: [{
    section: 'Do', label: 'Add the monthly investor update', hint: 'A board task on the first weekday of each month',
    action: { do: 'run', run: addTemplate }, when: (typed) => /\b(monthly|investor update|month(ly)? update)\b/.test(typed), say: ['monthly update'],
  }],
  overlay: MonthNotice,
} satisfies UiSlice;
