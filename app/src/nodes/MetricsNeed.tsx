import type { Attention } from '../../shared/model';
import { answerTarget, dismissMetricAlert } from './metricsApi';

// What the founder can do about a Metrics card from Needs you: take a suggested target or leave it, or wave an alert
// away. The card and the suggestion are named in the entry's id, so Needs you needs nothing else to answer it.
export function MetricsNeed({ entry, attempt }: { entry: Attention; attempt: (work: Promise<unknown>) => void }) {
  const [kind, cardId, item] = entry.id.split(':');
  if (entry.kind === 'proposed-target' && kind === 'proposed-target' && cardId && item) return <>
    <button type="button" onClick={() => attempt(answerTarget(cardId, item, false))}>Decline</button>
    <button type="button" className="primary" onClick={() => attempt(answerTarget(cardId, item, true))}>Accept</button>
  </>;
  if (entry.kind === 'metric-alert' && cardId) return <button type="button" onClick={() => attempt(dismissMetricAlert(cardId, entry.id))}>Dismiss</button>;
  return null;
}
