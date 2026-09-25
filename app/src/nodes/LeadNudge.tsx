import { useState } from 'react';
import { draftWord, markLine, nudgeId, readNudgeId } from '../../shared/leads-nudge';
import type { Lead } from '../../shared/leads';
import type { Attention } from '../../shared/model';
import { request, send } from '../api';
import { emit } from '../bus';
import { overlay } from '../overlay/store';
import { useAttention } from '../overlay/attention';
import './leads-nudge.css';

// Follow-up nudges, as the founder sees them. The mark on a lead is read from the same live Needs you list, so the two
// can never disagree: a nudge dismissed or answered takes its mark with it.
export function LeadStaleMark({ cardId, lead }: { cardId: string; lead: Lead }) {
  const list = useAttention();
  const id = nudgeId(cardId, lead.id, lead.stage);
  const entry = list.find((one) => one.id === id);
  if (!entry) return null;
  return <span className="lead__chase" role="img" aria-label={markLine(lead.stage)} title={`${markLine(lead.stage)}. ${entry.detail ?? ''}`.trim()} />;
}

// What the founder can do about one from Needs you: have the wired person draft the message, or wave it away.
export function LeadNudgeNeed({ entry, attempt }: { entry: Attention; attempt: (work: Promise<unknown>) => void }) {
  const [asking, setAsking] = useState(false);
  const named = entry.kind === 'lead-stale' ? readNudgeId(entry.id) : null;
  if (!named) return null;
  // The words come from the server, so they describe the lead as it is at the moment of pressing.
  const draft = () => {
    setAsking(true);
    attempt(request<{ roomId: string; text: string }>('/api/nudges/ask', send('POST', { id: entry.id }))
      .then(({ roomId, text }) => {
        overlay.close({ kind: 'panel', name: 'needs' });
        overlay.close({ kind: 'panel', name: 'dashboard' });
        overlay.open({ kind: 'focus', id: roomId });
        emit('ask', { roomId, text });
      })
      .finally(() => setAsking(false)));
  };
  return <>
    <button type="button" onClick={() => attempt(request('/api/nudges/dismiss', send('POST', { id: entry.id })))}>Dismiss</button>
    <button type="button" className="primary" disabled={!entry.roomId || asking} title={entry.roomId ? 'A wired person drafts it; you send it' : 'Wire a person to the Leads card first'} onClick={draft}>
      {draftWord(named.stage)}
    </button>
  </>;
}
