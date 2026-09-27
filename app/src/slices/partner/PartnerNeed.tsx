import { useState } from 'react';
import type { Attention } from '../../../shared/model';
import { overlay } from '../../overlay/store';
import { answerBet, answerPlan, closeBet, closePromise, morningDone } from './api';
import { takeBetLabel } from './words';

// What the founder can do from Needs you about the partner's things: read the morning note where it was written and
// say it is read, take a suggested bet or leave it, say how a bet went, put a plan's steps on the board, and close a
// promise they made.
// The bet or plan is named in the entry's id, so Needs you needs nothing else to answer it.
export function PartnerNeed({ entry, attempt }: { entry: Attention; attempt: (work: Promise<unknown>) => void }) {
  const item = entry.id.slice(entry.id.indexOf(':') + 1);
  if (entry.kind === 'morning-note') {
    const open = () => {
      overlay.close({ kind: 'panel', name: 'needs' });
      overlay.close({ kind: 'panel', name: 'dashboard' });
      if (entry.roomId) overlay.open({ kind: 'focus', id: entry.roomId });
    };
    return <>
      <button type="button" onClick={() => attempt(morningDone())}>Done</button>
      {entry.roomId && <button type="button" className="primary" onClick={open}>Talk it over</button>}
    </>;
  }
  if (entry.kind === 'proposed-bet') return <>
    <button type="button" onClick={() => attempt(answerBet(item, false))}>Decline</button>
    <button type="button" className="primary" onClick={() => attempt(answerBet(item, true))}>{takeBetLabel(entry.detail)}</button>
  </>;
  if (entry.kind === 'bet-check') return <>
    <button type="button" onClick={() => attempt(closeBet(item, 'did-not'))}>It did not work</button>
    <button type="button" className="primary" onClick={() => attempt(closeBet(item, 'worked'))}>It worked</button>
  </>;
  if (entry.kind === 'proposed-plan') return <PlanNeed item={item} attempt={attempt} />;
  // Only the founder closes their own promise.
  if (entry.kind === 'promise') return <>
    <button type="button" onClick={() => attempt(closePromise(item, false))}>Drop it</button>
    <button type="button" className="primary" onClick={() => attempt(closePromise(item, true))}>Done</button>
  </>;
  return null;
}

// A plan's steps: on the board, or not now. With no board on the stage the row says so where the founder pressed,
// and offers to make one, wired to whoever wrote the plan, and put the steps on it.
function PlanNeed({ item, attempt }: { item: string; attempt: (work: Promise<unknown>) => void }) {
  const [noBoard, setNoBoard] = useState('');
  const add = (makeBoard: boolean) => attempt(answerPlan(item, true, makeBoard).catch((error: Error) => {
    if (/no task board/i.test(error.message)) { setNoBoard(error.message); return; }
    throw error;
  }));
  return <>
    {noBoard && <p className="partner-need__problem" role="status">{noBoard}</p>}
    <button type="button" onClick={() => attempt(answerPlan(item, false))}>Not now</button>
    {noBoard
      ? <button type="button" className="primary" onClick={() => add(true)}>Add a board and put them on it</button>
      : <button type="button" className="primary" onClick={() => add(false)}>Add to the board</button>}
  </>;
}
