import { useEffect, useState } from 'react';
import type { Thread } from '../../shared/model';
import { getThreads } from '../api';
import { listen } from '../bus';
import { Message } from '../nodes/Message';
import { ago } from './attention';
import { PanelShell } from './PanelShell';
import { setHostElement, showThread, useThread } from './store';

const pane = setHostElement('messages');

// Every conversation in one place. A person's thread is their own card, moved into the pane with whatever it is in
// the middle of; a thread between two people is read-only, picked out of the room where the question was answered.
// How long a window waits before saying out loud that it is not getting an answer. A request that never comes back
// used to leave this panel looking like an app with nothing in it, which is how the founder read it.
const PATIENCE = 4000;

export function MessagesPanel() {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [lost, setLost] = useState(false);
  const [query, setQuery] = useState('');
  const open = useThread();

  useEffect(() => {
    let answered = false;
    const load = () => { getThreads(query).then((got) => { answered = true; setThreads(got); setLost(false); }).catch(() => setLost(true)); };
    const soon = setTimeout(load, query ? 180 : 0);
    const every = setInterval(load, 5000);
    // Nothing has come back and nothing has failed either: say so rather than sit there looking like an empty app.
    const patience = setTimeout(() => { if (!answered) setLost(true); }, PATIENCE);
    const stops = [listen('usage', load), listen('effect', (effect) => { if (effect.kind === 'chat-changed') load(); })];
    return () => { clearTimeout(soon); clearTimeout(patience); clearInterval(every); for (const stop of stops) stop(); };
  }, [query]);
  // The first time the view opens it shows the latest conversation.
  useEffect(() => { if (threads?.length && !threads.some((thread) => thread.id === open) && !query) showThread(threads[0].id); }, [threads, open, query]);

  const current = threads?.find((thread) => thread.id === open);
  return (
    <PanelShell name="messages" title="Messages" wide>
      <div className={`threads${current ? ' has-open' : ''}`}>
        <nav className="threads__list" aria-label="Conversations">
          <input type="search" aria-label="Search conversations" placeholder="Search what was said" value={query} onChange={(event) => setQuery(event.target.value)} />
          {threads?.length === 0 && <p className="panel__empty">{query ? 'Nobody said that.' : 'No conversations yet.'}</p>}
          {!threads && <p className="panel__empty">{lost ? 'Could not load your conversations. Trying again…' : 'Reading your conversations…'}</p>}
          <ul>
            {threads?.map((thread) => (
              <li key={thread.id}>
                <button type="button" className={thread.id === open ? 'is-open' : undefined} aria-current={thread.id === open ? 'true' : undefined} onClick={() => showThread(thread.id)}>
                  <span className="threads__faces" aria-hidden="true">{thread.accents.map((accent, index) => <i key={index} style={{ background: accent }} />)}</span>
                  <span className="threads__text">
                    <b>{thread.title}{thread.live && <em className="threads__live" title="Replying now" aria-label="replying now" />}</b>
                    <small>{thread.hit ?? (thread.last ? `${thread.last.by}: ${thread.last.text}` : 'Nothing said yet')}</small>
                  </span>
                  {thread.last && <time>{ago(thread.last.at)}</time>}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="threads__pane">
          <button type="button" className="threads__back" onClick={() => showThread(null)}>All conversations</button>
          {/* A person's thread: their card arrives in this element. */}
          <div className="threads__card" ref={pane} hidden={current?.kind !== 'room'} />
          {current?.kind === 'consult' && (
            <div className="threads__read" aria-label={current.title}>
              <p className="threads__note">{current.title.split(' ↔ ')[0]} asked, {current.title.split(' ↔ ')[1]} answered. This happened inside a turn you started; it is kept in {current.title.split(' ↔ ')[1]}'s room.</p>
              <div className="chat">{current.messages?.map((message) => <Message key={message.id} message={message} />)}</div>
            </div>
          )}
          {!current && threads && threads.length > 0 && <p className="panel__empty">Pick a conversation.</p>}
        </div>
      </div>
    </PanelShell>
  );
}
