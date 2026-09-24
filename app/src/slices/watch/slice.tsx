import { useEffect, useState } from 'react';
import type { UiSlice } from '..';
import { request as ask, send } from '../../api';
import { listen } from '../../bus';
import './watch.css';

type Watched = { id: string; url: string; title: string };

// The pages this person keeps an eye on, beside who they are wired to. Nothing at all when they watch none.
function Watching({ roomId }: { roomId: string }) {
  const [list, setList] = useState<Watched[]>([]);
  const load = () => { ask<Watched[]>(`/api/watch/${roomId}`).then(setList).catch(() => {}); };
  useEffect(load, [roomId]);
  // A person starts or stops watching a page during a turn, so look again when a turn ends here (usage moved) and
  // when somebody else's turn changed this person's conversation.
  useEffect(() => {
    const stops = [listen('usage', load), listen('effect', (effect) => { if (effect.kind === 'chat-changed' && effect.id === roomId) load(); })];
    return () => { for (const stop of stops) stop(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);
  if (!list.length) return null;
  const stop = (id: string) => { ask(`/api/watch/${roomId}/stop`, send('POST', { id })).then(load).catch(() => {}); };
  return (
    <section>
      <h3>Watching {list.length === 1 ? '1 page' : `${list.length} pages`}</h3>
      <ul>
        {list.map((one) => (
          <li key={one.id} className="watch-row">
            <a href={one.url} target="_blank" rel="noreferrer" title={one.title}>{one.url.replace(/^https?:\/\/(www\.)?/, '')}</a>
            <button type="button" onClick={() => stop(one.id)}>Stop</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default { name: 'watch', person: Watching } satisfies UiSlice;
