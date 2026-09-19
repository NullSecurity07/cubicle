import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import type { Attention } from '../../shared/model';
import { changeTask, dismissAttention, removeTask } from '../api';
import { Approval } from '../nodes/Approval';
import { useAttention } from './attention';
import { PanelShell } from './PanelShell';
import { overlay, showDecision } from './store';

const WHAT: Record<Attention['kind'], string> = {
  approval: 'needs your OK', 'run-approval': 'needs your OK on a task', 'proposed-task': 'suggests a task', 'proposed-decision': 'asks for a decision',
  'run-failed': 'could not finish', missed: 'missed a repeat', 'review-due': 'Decision to look at again',
};
export const ago = (at: number, now = Date.now()) => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
};

// Everything that waits for the founder, in one place. Answer here, or go to where it lives.
export function NeedsPanel() {
  const list = useAttention();
  const { fitView, setNodes } = useReactFlow();
  const [problem, setProblem] = useState('');
  const attempt = (work: Promise<unknown>) => { setProblem(''); work.catch((error: Error) => setProblem(error.message)); };

  function show(id?: string) {
    if (!id) return;
    overlay.close({ kind: 'panel', name: 'needs' });
    setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === id })));
    void fitView({ nodes: [{ id }], duration: 450, maxZoom: 1, padding: 0.35 });
  }

  return (
    <PanelShell name="needs" title="Needs you" note={list.length ? `${list.length} waiting` : undefined}>
      {!list.length && <p className="panel__empty">Nothing is waiting for you.</p>}
      {problem && <p className="msg--problem">{problem}</p>}
      <ul className="needs">
        {list.map((entry) => {
          const home = entry.kind === 'approval' ? entry.roomId : entry.cardId ?? entry.roomId;
          return (
            <li key={entry.id} className={`needs__item needs__item--${entry.kind}`}>
              <div className="needs__head">
                <span className="needs__who">{entry.who ? `${entry.who} ${WHAT[entry.kind]}` : WHAT[entry.kind]}</span>
                <time>{ago(entry.at)}</time>
              </div>
              {entry.lapsed
                ? <p className="needs__title">"{entry.title}" was waiting when the app closed, and that turn is over. Ask {entry.who ?? 'them'} again if you still want it.</p>
                : entry.event ? <>{entry.detail && <p className="needs__detail">Task: {entry.detail}</p>}<Approval tool={entry.event} /></>
                : <><p className="needs__title">{entry.title}</p>{entry.detail && <p className="needs__detail">{entry.detail}</p>}</>}
              <div className="needs__end">
                {home && <button type="button" className="needs__show" onClick={() => show(home)}>Show on the stage</button>}
                {entry.kind === 'proposed-task' && entry.cardId && entry.taskId && <>
                  <button type="button" onClick={() => attempt(removeTask(entry.cardId!, entry.taskId!))}>Decline</button>
                  <button type="button" className="primary" onClick={() => attempt(changeTask(entry.cardId!, entry.taskId!, { column: 'todo' }))}>Accept</button>
                </>}
                {entry.decisionId && <button type="button" className="primary" onClick={() => { showDecision(entry.decisionId!); overlay.open({ kind: 'panel', name: 'decisions' }); }}>{entry.kind === 'review-due' ? 'Look at it' : 'Decide'}</button>}
                {(entry.lapsed || entry.kind === 'run-failed' || entry.kind === 'missed' || entry.kind === 'review-due') && <button type="button" onClick={() => attempt(dismissAttention(entry.id))}>Dismiss</button>}
              </div>
            </li>
          );
        })}
      </ul>
    </PanelShell>
  );
}
