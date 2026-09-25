import { useEffect, useState } from 'react';
import type { Today, TodayItem } from '../../shared/today';
import { request, send } from '../api';
import { useJumpTo } from '../flow';
import { overlay, showDecision } from './store';
import './today.css';

// Today's five, at the top of the dashboard: the few things most worth the founder's morning, ranked on the server by a
// fixed table (no model picks them). Each row opens the place it came from; resting on it says why it is here; the
// small cross puts it away until tomorrow. Read again whenever the dashboard is (`stamp` moves).
export function TodayFive({ stamp }: { stamp: number }) {
  const [items, setItems] = useState<TodayItem[] | null>(null);
  const [problem, setProblem] = useState('');
  const jumpTo = useJumpTo();

  useEffect(() => {
    let live = true;
    request<Today>('/api/today').then((today) => { if (live) { setItems(today.items); setProblem(''); } }).catch((error: Error) => { if (live) setProblem(error.message); });
    return () => { live = false; };
  }, [stamp]);

  const close = () => overlay.close({ kind: 'panel', name: 'dashboard' });
  // The same doors the rest of the dashboard uses: the decision, the person asked, the card, or Needs you.
  function go(one: TodayItem) {
    close();
    if (one.decisionId) { showDecision(one.decisionId); overlay.open({ kind: 'panel', name: 'decisions' }); return; }
    if (one.roomId && (one.kind === 'approval' || !one.cardId)) { overlay.open({ kind: 'focus', id: one.roomId }); return; }
    const place = one.cardId ?? one.docId;
    if (place) jumpTo(place); else overlay.open({ kind: 'panel', name: 'needs' });
  }
  function notToday(one: TodayItem) {
    setItems((now) => now?.filter((held) => held.id !== one.id) ?? now);
    request<Today>('/api/today/dismiss', send('POST', { id: one.id })).then((today) => setItems(today.items)).catch((error: Error) => setProblem(error.message));
  }

  if (!items && !problem) return null;
  return (
    <div className="dash__group today">
      <h4>Today's five</h4>
      {problem && <p className="msg--problem">{problem}</p>}
      {items && !items.length && <p className="dash__empty">Nothing is asking for you today. The quiet is real: every door below is shut.</p>}
      {items && items.length > 0 && (
        <ol className="today__list" aria-label="Today's five">
          {items.map((one, index) => (
            <li key={one.id} className="today__item" style={{ animationDelay: `${index * 40}ms` }}>
              <button type="button" className="today__row" onClick={() => go(one)} title={one.why} aria-label={one.title}>
                <span className="today__rank" aria-hidden="true">{index + 1}</span>
                <span className="dash__text"><b>{one.title}</b><small>{one.reason}</small></span>
                <svg className="dash__chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.500 2.500L8 6l-3.500 3.500" /></svg>
              </button>
              <button type="button" className="today__away" onClick={() => notToday(one)} aria-label={`Not today: ${one.title}`} title="Not today">
                <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.500 3.500l5 5M8.500 3.500l-5 5" /></svg>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
