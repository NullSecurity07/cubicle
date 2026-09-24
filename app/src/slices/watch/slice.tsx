import { useEffect, useState } from 'react';
import type { UiSlice } from '..';
import './watch.css';

type Watched = { id: string; url: string; title: string };
async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.json() as Promise<T>;
}

// The pages this person keeps an eye on, beside who they are wired to. Nothing at all when they watch none.
function Watching({ roomId }: { roomId: string }) {
  const [list, setList] = useState<Watched[]>([]);
  const load = () => { ask<Watched[]>(`/api/watch/${roomId}`).then(setList).catch(() => {}); };
  useEffect(load, [roomId]);
  if (!list.length) return null;
  const stop = (id: string) => { ask(`/api/watch/${roomId}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).then(load).catch(() => {}); };
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
