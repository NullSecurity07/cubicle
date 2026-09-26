import type { Attention } from '../../../shared/model';
import { overlay } from '../../overlay/store';
import { answerBet, answerPlan, closeBet, morningDone } from './api';

// What the founder can do from Needs you about the partner's things: read the morning note where it was written and
// say it is read, take a suggested bet or leave it, say how a bet went, and put a plan's steps on the board.
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
    <button type="button" className="primary" onClick={() => attempt(answerBet(item, true))}>Take the bet</button>
  </>;
  if (entry.kind === 'bet-check') return <>
    <button type="button" onClick={() => attempt(closeBet(item, 'did-not'))}>It did not work</button>
    <button type="button" className="primary" onClick={() => attempt(closeBet(item, 'worked'))}>It worked</button>
  </>;
  if (entry.kind === 'proposed-plan') return <>
    <button type="button" onClick={() => attempt(answerPlan(item, false))}>Not now</button>
    <button type="button" className="primary" onClick={() => attempt(answerPlan(item, true))}>Add to the board</button>
  </>;
  return null;
}
