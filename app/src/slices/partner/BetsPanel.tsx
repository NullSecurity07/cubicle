import { useEffect, useState } from 'react';
import { VERDICT_WORDS, type Bet } from '../../../shared/partner';
import { PanelShell } from '../../overlay/PanelShell';
import { overlay } from '../../overlay/store';
import { getPartner, type PartnerView } from './api';

// The ledger in one view: the last morning note on top, then the bets waiting for the founder's yes, the open ones
// with their check day, and the ones already checked with how they went. Taking and closing happen in Needs you.
export function BetsPanel() {
  const [view, setView] = useState<PartnerView | null>(null);
  const [problem, setProblem] = useState('');
  useEffect(() => { getPartner().then(setView).catch((error: Error) => setProblem(error.message)); }, []);
  const bets = view?.bets ?? [];
  const group = (status: Bet['status']) => bets.filter((bet) => bet.status === status);
  const open = group('open');
  const note = view?.morning;
  const toPartner = () => { if (!view?.partner) return; overlay.close({ kind: 'panel', name: 'bets' }); overlay.open({ kind: 'focus', id: view.partner.roomId }); };

  return (
    <PanelShell name="bets" title="Bets" note={open.length ? `${open.length} open` : undefined}>
      {problem && <p className="msg--problem">{problem}</p>}
      {note && (
        <section className="bets__morning">
          <h3>Morning note, {note.day}{view?.partner && <button type="button" className="playbook__act" onClick={toPartner}>Talk it over</button>}</h3>
          <ol>{note.things.map((thing) => <li key={thing}>{thing}</li>)}</ol>
          <p><b>Risk:</b> {note.risk}</p>
          <p><b>Question:</b> {note.question}</p>
        </section>
      )}
      {view && !bets.length && (
        <p className="panel__empty">
          No bets yet. A bet is something the company tries, the number it should move and the day to look. Ask a person
          to propose one; it lands in Needs you, and on its day the number is read from its card for you.
        </p>
      )}
      {([['proposed', 'Waiting for your yes'], ['open', 'Open'], ['closed', 'Checked']] as const).map(([status, heading]) => {
        const list = group(status);
        if (!list.length) return null;
        return (
          <section key={status}>
            <h3 className="bets__heading">{heading}</h3>
            <ul className="bets">
              {list.map((bet) => (
                <li key={bet.id} className={`bets__item bets__item--${bet.result?.verdict ?? status}`}>
                  <div className="bets__what"><b>{bet.what}</b>{bet.hypothesis && <span>{bet.hypothesis}</span>}</div>
                  <small>
                    {bet.status === 'closed' && bet.result
                      ? `${VERDICT_WORDS[bet.result.verdict]}: ${bet.metric} was ${bet.result.value ?? 'unread'} against ${bet.target}`
                      : `${bet.metric} to ${bet.target} by ${bet.checkDate}`}
                  </small>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </PanelShell>
  );
}
