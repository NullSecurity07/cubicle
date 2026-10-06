import { useState } from 'react';
import type { Lead, ThreadEvent } from '../../shared/leads';
import { eventLine, lastEvent, readAskId, waitingReply } from '../../shared/leads-thread';
import type { Attention } from '../../shared/model';
import { answerLeadAsk, leadMeeting, leadMeetingNotes, leadReplied, leadReplyAsk } from '../api';
import { emit } from '../bus';
import { overlay } from '../overlay/store';
import { useAttention } from '../overlay/attention';
import './lead-thread.css';

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// The founder in front of the person, with the ask typed: the road "Draft first message" takes.
function askPerson(roomId: string, text: string) {
  overlay.close({ kind: 'panel', name: 'needs' });
  overlay.close({ kind: 'panel', name: 'dashboard' });
  overlay.open({ kind: 'focus', id: roomId });
  emit('ask', { roomId, text });
}

// The thread's newest event under a lead's name on the card: what happened last, and when.
export function LeadThreadLine({ lead }: { lead: Lead }) {
  const last = lastEvent(lead);
  if (!last) return null;
  return <span className="lead__thread" title={last.text ?? undefined}>{last.kind === 'meeting' ? eventLine(last) : `${eventLine(last)} · ${day(last.at)}`}</span>;
}

// The thread in the lead's own view, with what the founder can move it by: they replied, a meeting is set, and how
// the meeting went once its day is over.
export function LeadThreadView({ cardId, lead, writer, attempt }: { cardId: string; lead: Lead; writer?: { id: string; name: string }; attempt: (work: Promise<unknown>) => void }) {
  const [open, setOpen] = useState<'replied' | 'meeting' | null>(null);
  const [words, setWords] = useState('');
  const [when, setWhen] = useState('');
  const [notes, setNotes] = useState('');
  const shown = (lead.thread ?? []).filter((event) => event.kind !== 'closed');
  const reply = waitingReply(lead);
  // The notes are asked for here exactly while Needs you asks for them: the server's day decides, not this window's.
  const owed = useAttention().some((entry) => entry.kind === 'lead-notes' && readAskId(entry.id)?.leadId === lead.id && readAskId(entry.id)?.cardId === cardId);
  const close = () => { setOpen(null); setWords(''); setWhen(''); };
  const draftAnswer = () => attempt(leadReplyAsk(cardId, lead.id).then(({ roomId, text }) => askPerson(roomId, text)));

  return (
    <section className="thread" aria-label="Thread">
      {shown.length > 0 && (
        <ol className="thread__events">
          {shown.slice(-6).map((event: ThreadEvent) => (
            <li key={event.at} className={`thread__event thread__event--${event.kind}`}>
              <span>{eventLine(event)}</span><small>{day(event.at)}</small>
              {event.kind === 'replied' && event.text && <q>{event.text}</q>}
              {event.kind === 'notes' && event.text && <q>{event.text}</q>}
            </li>
          ))}
        </ol>
      )}
      {owed && (
        <form className="thread__form" onSubmit={(event) => { event.preventDefault(); if (notes.trim()) attempt(leadMeetingNotes(cardId, lead.id, notes).then(() => setNotes(''))); }}>
          <label>How did the meeting go?
            <textarea rows={3} aria-label="Meeting notes" placeholder="What they said, what they want, what comes next" value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <div><button type="submit" className="primary" disabled={!notes.trim()}>Save notes</button></div>
        </form>
      )}
      {open === 'replied' && (
        <form className="thread__form" onSubmit={(event) => { event.preventDefault(); if (words.trim()) attempt(leadReplied(cardId, lead.id, words).then(close)); }}>
          <textarea rows={3} aria-label="Their reply" placeholder="Paste what they wrote" value={words} onChange={(event) => setWords(event.target.value)} autoFocus />
          <div><button type="button" onClick={close}>Cancel</button><button type="submit" className="primary" disabled={!words.trim()}>Save reply</button></div>
        </form>
      )}
      {open === 'meeting' && (
        <form className="thread__form" onSubmit={(event) => { event.preventDefault(); if (when) attempt(leadMeeting(cardId, lead.id, when).then(close)); }}>
          <label>Meeting day<input type="date" aria-label="Meeting day" value={when} onChange={(event) => setWhen(event.target.value)} autoFocus /></label>
          <div><button type="button" onClick={close}>Cancel</button><button type="submit" className="primary" disabled={!when}>Set meeting</button></div>
        </form>
      )}
      {!open && (
        <div className="thread__acts">
          <button type="button" onClick={() => setOpen('replied')}>They replied</button>
          <button type="button" onClick={() => setOpen('meeting')}>Meeting set</button>
          {reply && <button type="button" className="primary" disabled={!writer} title={writer ? `${writer.name} drafts it; you send it` : 'Wire a person to this card first'} onClick={draftAnswer}>Draft an answer</button>}
        </div>
      )}
    </section>
  );
}

// What waits in Needs you from a lead's thread: an answer to draft, notes to write, a reading to log.
export function LeadThreadNeed({ entry, attempt }: { entry: Attention; attempt: (work: Promise<unknown>) => void }) {
  const [notes, setNotes] = useState('');
  const named = readAskId(entry.id);
  if (!named || entry.kind !== named.kind) return null;
  const dismiss = <button type="button" onClick={() => attempt(answerLeadAsk(entry.id, { do: 'dismiss' }))}>{named.kind === 'lead-reading' ? 'Decline' : 'Dismiss'}</button>;
  if (named.kind === 'lead-replied') return <>
    {dismiss}
    <button type="button" className="primary" disabled={!entry.roomId} title={entry.roomId ? 'A wired person drafts it; you send it' : 'Wire a person to the Leads card first'}
      onClick={() => attempt(leadReplyAsk(named.cardId, named.leadId).then(({ roomId, text }) => askPerson(roomId, text)))}>Draft an answer</button>
  </>;
  if (named.kind === 'lead-reading') return <>{dismiss}<button type="button" className="primary" onClick={() => attempt(answerLeadAsk(entry.id, { do: 'log' }))}>Log it</button></>;
  const form = `notes-${entry.id}`;
  return <>
    <form id={form} className="needs__notes" onSubmit={(event) => { event.preventDefault(); if (notes.trim()) attempt(answerLeadAsk(entry.id, { do: 'notes', text: notes })); }}>
      <textarea rows={2} aria-label="Meeting notes" placeholder="How it went, in a few lines" value={notes} onChange={(event) => setNotes(event.target.value)} />
    </form>
    {dismiss}
    <button type="submit" form={form} className="primary" disabled={!notes.trim()}>Save notes</button>
  </>;
}
