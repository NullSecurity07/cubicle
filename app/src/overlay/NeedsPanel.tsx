import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import type { Lapsed } from '../../shared/lapsed';
import type { Attention } from '../../shared/model';
import { useAddCard } from '../addCard';
import { changeTask, dismissAttention, dropSource, removeTask } from '../api';
import { emit } from '../bus';
import { Approval, asked } from '../nodes/Approval';
import { CoderAsk } from '../nodes/CoderAsk';
import { useAttention } from './attention';
import { PanelShell } from './PanelShell';
import { overlay, showDecision } from './store';

const WHAT: Record<Attention['kind'], string> = {
  approval: 'needs your OK', 'run-approval': 'needs your OK on a task', 'proposed-task': 'suggests a task', 'proposed-decision': 'asks for a decision',
  'run-failed': 'could not finish', missed: 'missed a repeat', 'review-due': 'Decision to look at again', 'proposed-source': 'suggests a website', 'page-changed': 'saw a watched page change',
  'metric-alert': 'A number to look at', 'proposed-target': 'suggests a target',
};
export const ago = (at: number, now = Date.now()) => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
};
// How long ago, said in a sentence the way the clock beside it says it.
const since = (at: number) => (ago(at) === 'now' ? 'just now' : `${ago(at)} ago`);
// What the founder says to start it over. It asks for the work, never for the step: the person still has to come back
// for the OK through the usual door, and pressing this has never said yes to anything.
const again = (title: string) => `Go ahead with what you asked me about: "${title}". Ask me again when you need my OK.`;

// Everything that waits for the founder, in one place. Answer here, or go to where it lives.
export function NeedsPanel() {
  const list = useAttention() as Lapsed[];
  const { fitView, setNodes } = useReactFlow();
  const addCard = useAddCard();
  const [problem, setProblem] = useState('');
  const attempt = (work: Promise<unknown>) => { setProblem(''); work.catch((error: Error) => setProblem(error.message)); };

  function show(id?: string) {
    if (!id) return;
    overlay.close({ kind: 'panel', name: 'needs' });
    setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === id })));
    void fitView({ nodes: [{ id }], duration: 450, maxZoom: 1, padding: 0.35 });
  }

  // The founder in front of the person again, with the ask already typed: the same road the command bar takes.
  function ask(entry: Lapsed, said: string) {
    if (!entry.roomId) return;
    overlay.close({ kind: 'panel', name: 'needs' });
    overlay.open({ kind: 'focus', id: entry.roomId });
    emit('ask', { roomId: entry.roomId, text: again(said) });
  }

  // The website lands on the stage and the panel steps aside, so the founder sees where the new card went.
  function accept(entry: Lapsed) {
    addCard('source', { url: entry.url ?? '', about: entry.about ?? '' });
    attempt(dropSource(entry.sourceId!));
    overlay.close({ kind: 'panel', name: 'needs' });
  }

  return (
    <PanelShell name="needs" title="Needs you" note={list.length ? `${list.length} waiting` : undefined}>
      {!list.length && <p className="panel__empty">Nothing is waiting for you.</p>}
      {problem && <p className="msg--problem">{problem}</p>}
      <ul className="needs">
        {list.map((entry) => {
          const home = entry.kind === 'approval' ? entry.roomId ?? entry.cardId : entry.cardId ?? entry.roomId;
          // A step that came with no question of its own was written down under the tool's plain name; here it is
          // given back the words the founder actually read on the card in the room.
          const said = entry.tool && entry.title === entry.tool.replace(/_/g, ' ') ? asked(entry.tool) : entry.title;
          return (
            <li key={entry.id} className={`needs__item needs__item--${entry.kind}`}>
              <div className="needs__head">
                <span className="needs__who">{entry.who ? `${entry.who} ${WHAT[entry.kind]}` : WHAT[entry.kind]}</span>
                <time>{ago(entry.at)}</time>
              </div>
              {entry.lapsed
                ? <>
                    <p className="needs__title">{entry.who ?? 'Someone'} asked: "{said}"</p>
                    <p className="needs__detail">That was {since(entry.at)}. The app restarted before you answered, so that step never ran.{entry.about ? ` The step was: ${entry.about}.` : ''}</p>
                  </>
                : entry.coder && entry.cardId ? <CoderAsk cardId={entry.cardId} ask={entry.coder} />
                : entry.event ? <>{entry.detail && <p className="needs__detail">Task: {entry.detail}</p>}<Approval tool={entry.event} /></>
                : <><p className="needs__title">{entry.title}</p>{entry.detail && <p className="needs__detail">{entry.detail}</p>}</>}
              <div className="needs__end">
                {home && <button type="button" className="needs__show" onClick={() => show(home)}>Show on the stage</button>}
                {entry.kind === 'proposed-task' && entry.cardId && entry.taskId && <>
                  <button type="button" onClick={() => attempt(removeTask(entry.cardId!, entry.taskId!))}>Decline</button>
                  <button type="button" className="primary" onClick={() => attempt(changeTask(entry.cardId!, entry.taskId!, { column: 'todo' }))}>Accept</button>
                </>}
                {entry.kind === 'proposed-source' && entry.sourceId && <>
                  <button type="button" onClick={() => attempt(dropSource(entry.sourceId!))}>Decline</button>
                  <button type="button" className="primary" onClick={() => accept(entry)}>Accept</button>
                </>}
                {entry.decisionId && <button type="button" className="primary" onClick={() => { showDecision(entry.decisionId!); overlay.open({ kind: 'panel', name: 'decisions' }); }}>{entry.kind === 'review-due' ? 'Look at it' : 'Decide'}</button>}
                {(entry.lapsed || entry.kind === 'run-failed' || entry.kind === 'missed' || entry.kind === 'review-due' || entry.kind === 'page-changed') && <button type="button" onClick={() => attempt(dismissAttention(entry.id))}>Dismiss</button>}
                {entry.lapsed && entry.roomId && <button type="button" className="primary" onClick={() => ask(entry, said)}>Ask {entry.who ?? 'them'} again</button>}
              </div>
            </li>
          );
        })}
      </ul>
    </PanelShell>
  );
}
