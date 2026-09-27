import { Panel, useStore } from '@xyflow/react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Mission, ToolEffect } from '../shared/model';
import { dismissMissions, getMissions } from './api';
import { listen } from './bus';
import { useAttention } from './overlay/attention';

// The effects that can tick a mission: somebody spoke, a doc (the brief) was written, a doc was made. A studio's
// progress lines are effects too, one per log line, and must not each cost a request.
const TICKS = new Set<ToolEffect['kind']>(['chat-changed', 'doc-changed', 'doc-created']);

// The list and whether it is open live here, not in the corner card, because the dock's Getting started button shows
// the same progress and opens the same list. Closed, the corner is empty and the button is the way back.
type Held = { dismissed: boolean; missions: Mission[] } | null;
let held: Held = null;
let opened = (() => { try { return localStorage.getItem('missions') !== 'closed'; } catch { return true; } })();
const hearers = new Set<() => void>();
const tell = () => { for (const one of hearers) one(); };
const subscribe = (one: () => void) => { hearers.add(one); return () => { hearers.delete(one); }; };
const setState = (next: Held) => { held = next; tell(); };
export const useMissions = () => ({ state: useSyncExternalStore(subscribe, () => held), open: useSyncExternalStore(subscribe, () => opened) });
export function setMissionsOpen(open: boolean) {
  opened = open;
  try { localStorage.setItem('missions', open ? 'open' : 'closed'); } catch { /* private window */ }
  tell();
}

// The first-run list, in the corner until the founder closes it or sends it away. The server works each tick out
// from what the workspace holds; this only shows it. Open, it names the next thing to try and how.
export function Missions() {
  const { state, open } = useMissions();
  const [shown, setShown] = useState<string | null>(null);
  // Only the counts: a card being dragged changes neither, so the list is not drawn again every frame.
  const cards = useStore((flow) => flow.nodes.length + flow.edges.length);
  const waiting = useAttention();

  // Whatever could tick a mission: a turn ending, a card or a wire coming or going, the founder's list changing.
  useEffect(() => {
    if (state?.dismissed) return;
    const load = () => { getMissions().then(setState).catch(() => {}); };
    const soon = setTimeout(load, 700);
    const stops = [listen('usage', load), listen('effect', (effect) => { if (TICKS.has(effect.kind)) load(); })];
    // Typing in the brief or recording a decision sends no signal this far: while the list is open, look now and then.
    const every = open ? setInterval(load, 5000) : undefined;
    return () => { clearTimeout(soon); clearInterval(every); for (const stop of stops) stop(); };
  }, [cards, waiting, open, state?.dismissed]);

  if (!state || state.dismissed || !open) return null;
  const done = state.missions.filter((mission) => mission.done).length;
  const next = state.missions.find((mission) => !mission.done);

  return (
    <Panel position="bottom-left" className="missions">
      <button type="button" className="missions__head" aria-expanded="true" onClick={() => setMissionsOpen(false)}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" className="ring__track" /><circle cx="10" cy="10" r="7" pathLength={100} strokeDasharray={`${Math.round((done / state.missions.length) * 100)} 100`} transform="rotate(-90 10 10)" /></svg>
        <b>{done === state.missions.length ? 'You know your way around' : 'Getting started'}</b><span>{done} of {state.missions.length}</span>
      </button>
      <div className="missions__body">
        <ul aria-label="Getting started">
          {state.missions.map((mission) => (
            <li key={mission.id} className={mission.done ? 'is-done' : undefined}>
              <button type="button" aria-expanded={(shown ?? next?.id) === mission.id} onClick={() => setShown(mission.id)}>
                <i aria-hidden="true">{mission.done && <svg viewBox="0 0 12 12"><path d="M2.500 6.300l2.300 2.300 4.700-5" /></svg>}</i>
                <span>{mission.title}{mission.done && <em className="visually-hidden"> (done)</em>}</span>
              </button>
              {(shown ?? next?.id) === mission.id && <p>{mission.tip}</p>}
            </li>
          ))}
        </ul>
        <button type="button" className="missions__dismiss" onClick={() => { void dismissMissions().then(() => setState({ ...state, dismissed: true })); }}>{done === state.missions.length ? 'Done, hide this' : 'Hide this for good'}</button>
      </div>
    </Panel>
  );
}
