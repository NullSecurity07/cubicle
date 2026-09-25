import type { NodeProps } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { draftAsk, LEAD_STAGES, leadsCsv, STAGE_NAMES, type Lead, type LeadStage, type TwentyStatus } from '../../shared/leads';
import { addLead, moveLead, noteLead, removeLead, watchLeads, watchTwenty } from '../api';
import { emit } from '../bus';
import { overlay } from '../overlay/store';
import type { LeadsNodeType } from '../stage';
import { useWired } from '../flow';
import { useFlushStage } from '../sync';
import { CardActions, Frame } from './Frame';
import './leads.css';
import { pressed } from '../keys';
import { useAttempt } from '../attempt';

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const SOURCE: Record<Lead['source'], string> = { founder: 'added by you', person: 'added by a person', openoutreach: 'found by OpenOutreach', twenty: 'added in Twenty' };

// The founder's leads: who they might sell to and where each one stands. A column with nobody in it shrinks to its
// count, so the stages that hold people get the room. People wired to the card add, score and note; the founder
// moves a lead to contacted, and sends.
export function LeadsNode({ id, selected }: NodeProps<LeadsNodeType>) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', company: '', line: '' });
  const [note, setNote] = useState('');
  const { problem, setProblem, attempt: act } = useAttempt();
  const [copied, setCopied] = useState(false);
  const [drafter, setDrafter] = useState('');
  const [twenty, setTwenty] = useState<TwentyStatus | null>(null);
  const flushStage = useFlushStage();

  useEffect(() => {
    let stop = () => {};
    let gone = false;
    // The server must know this card before it will say anything about it.
    void flushStage().then(() => { if (!gone) stop = watchLeads(id, (event) => setLeads(event.leads)); });
    return () => { gone = true; stop(); };
  }, [id, flushStage]);

  // Only a founder who connected Twenty hears about it, and only while it is failing.
  useEffect(() => watchTwenty(setTwenty), []);

  // People wired to this card, whichever way the wire was drawn: who can draft a message.
  const wired = useWired(id, 'room');
  const people = () => wired.filter((node) => node.data.name).map((node) => ({ id: node.id, name: String(node.data.name) }));
  const open = leads.find((lead) => lead.id === openId);
  const empty = leads.length === 0;

  function add() {
    const name = draft.name.trim();
    const company = draft.company.trim();
    if (!name || !company) { setProblem('A lead needs a name and a company.'); return; }
    act(addLead(id, { name, company, line: draft.line }).then(() => setDraft({ name: '', company: '', line: '' })));
  }
  function copy() {
    act(navigator.clipboard.writeText(leadsCsv(leads)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }));
  }
  // The founder in front of the person, with the ask already sent: the road the command bar takes.
  function draftWith(lead: Lead, roomId: string) {
    overlay.open({ kind: 'focus', id: roomId });
    emit('ask', { roomId, text: draftAsk(lead) });
  }

  const wiredPeople = open ? people() : [];
  const writer = wiredPeople.find((person) => person.id === drafter) ?? wiredPeople[0];

  return (
    <Frame selected={!!selected} minWidth={560} minHeight={300}>
      <header className="card__header card__header--doc">
        <svg className="doc-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="5.5" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M1.800 13.500c.5-2.600 2.200-4 4.200-4s3.700 1.400 4.200 4M11 4.500h3.500M11 7.500h3.500M12 10.500h2.500" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
        <div className="card__name">Leads {!empty && <span>{leads.length}</span>}</div>
        {!empty && <button type="button" className="leads__copy nodrag" onClick={copy}>{copied ? 'Copied' : 'Copy as CSV'}</button>}
        <CardActions id={id} what="this Leads card (its leads stay in the workspace)" />
      </header>
      <div className="leads nodrag nowheel">
        <form className="leads__add" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <input aria-label="Lead name" placeholder="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <input aria-label="Company" placeholder="Company" value={draft.company} onChange={(event) => setDraft({ ...draft, company: event.target.value })} />
          <input className="leads__line" aria-label="One line about them" placeholder="One line: why they might buy" value={draft.line} onChange={(event) => setDraft({ ...draft, line: event.target.value })} />
          <button type="submit" disabled={!draft.name.trim() || !draft.company.trim()}>Add</button>
        </form>
        <div className="leads__stages">
          {LEAD_STAGES.map((stage) => {
            const mine = leads.filter((lead) => lead.stage === stage);
            if (!mine.length) return (
              <section key={stage} className="leads__col leads__col--empty" aria-label={`${STAGE_NAMES[stage]}: none`} title={`${STAGE_NAMES[stage]}: none yet`}>
                <span className="leads__count">0</span><span className="leads__side">{STAGE_NAMES[stage]}</span>
              </section>
            );
            return (
              <section key={stage} className="leads__col" aria-label={STAGE_NAMES[stage]}>
                <h3>{STAGE_NAMES[stage]} <span>{mine.length}</span></h3>
                <div className="leads__rows">
                  {mine.map((lead) => (
                    <button key={lead.id} type="button" className={`lead${lead.id === openId ? ' is-open' : ''}`} onClick={() => { setOpenId(lead.id); setNote(''); setProblem(''); }}>
                      <span className="lead__name">{lead.person.name}</span>
                      <span className="lead__company">{lead.company.name}</span>
                      {lead.fit && <span className={`lead__fit${lead.fit.score >= 7 ? ' is-good' : ''}`} title={lead.fit.why}>{lead.fit.score}</span>}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
          {empty && <p className="leads__empty">No leads yet. Add one above, or wire a person to this card and ask them to find some.</p>}
        </div>
      </div>
      {twenty?.connected && twenty.problem && (
        <p className="leads__twenty nodrag" title={twenty.url}>Twenty: {twenty.problem} since {new Date(twenty.since ?? Date.now()).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</p>
      )}
      {problem && !open && <p className="board__problem nodrag">{problem}</p>}
      {open && (
        <aside className="leadview nodrag nowheel" role="dialog" aria-label={open.person.name}>
          <div className="leadview__head">
            <div>
              <h3>{open.person.name}</h3>
              <p>{[open.person.title, open.company.name].filter(Boolean).join(' · ')}</p>
            </div>
            <button type="button" aria-label="Close lead" onClick={() => setOpenId(null)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
          <div className="leadview__body">
            {(open.person.linkedin || open.person.email || open.company.site) && (
              <p className="leadview__links">
                {open.person.linkedin && <a href={open.person.linkedin} target="_blank" rel="noreferrer">LinkedIn</a>}
                {open.person.email && <a href={`mailto:${open.person.email}`}>{open.person.email}</a>}
                {open.company.site && <a href={open.company.site} target="_blank" rel="noreferrer">{open.company.site.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</a>}
              </p>
            )}
            <label>Stage
              <select aria-label="Stage" value={open.stage} onChange={(event) => act(moveLead(id, open.id, event.target.value as LeadStage))}>
                {LEAD_STAGES.map((stage) => <option key={stage} value={stage}>{STAGE_NAMES[stage]}</option>)}
              </select>
            </label>
            {open.fit && <p className="leadview__fit"><b>{open.fit.score}/10</b> {open.fit.why}</p>}
            <div className="leadview__notes" aria-label="Notes">
              {open.notes.map((one, index) => (
                <div key={index} className="leadview__note"><small>{one.by} · {day(one.at)}</small>{one.text}</div>
              ))}
              {!open.notes.length && <p className="leadview__quiet">No notes yet.</p>}
            </div>
            <form className="leadview__add" onSubmit={(event) => { event.preventDefault(); if (note.trim()) act(noteLead(id, open.id, note).then(() => setNote(''))); }}>
              <textarea rows={2} aria-label="New note" placeholder="Add a note" value={note} onChange={(event) => setNote(event.target.value)}
                onKeyDown={(event) => { if (pressed(event, 'send')) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
            </form>
            <p className="leadview__quiet">{SOURCE[open.source]} · {day(open.addedAt)}</p>
            {problem && <p className="leadview__problem">{problem}</p>}
          </div>
          <div className="leadview__end">
            <button type="button" className="danger" onClick={() => { act(removeLead(id, open.id)); setOpenId(null); }}>Delete</button>
            {wiredPeople.length > 1 && (
              <select aria-label="Who drafts" value={writer?.id} onChange={(event) => setDrafter(event.target.value)}>
                {wiredPeople.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
              </select>
            )}
            <button type="button" className="primary" disabled={!writer} title={writer ? `${writer.name} drafts it; you send it` : 'Wire a person to this card first'} onClick={() => writer && draftWith(open, writer.id)}>
              Draft first message
            </button>
          </div>
        </aside>
      )}
    </Frame>
  );
}
