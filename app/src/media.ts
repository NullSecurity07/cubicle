import { useCallback, useEffect, useRef, useState } from 'react';
import type { Media } from '../shared/model';
import { getMedia, makeMedia, watchMedia } from './api';
import { emit, listen } from './bus';
import { useFlushStage } from './sync';

const EMPTY: Media = { state: 'idle', log: [], results: [] };

// One feed for the whole stage, opened while a studio card is on it. Every server event becomes the same bus effect a
// person's tool makes, so a card shows the founder's own work and a person's work by exactly one path.
let watching = 0;
let close = () => {};
function share() {
  if (watching === 0) {
    close = watchMedia((event) => emit('effect', 'line' in event
      ? { kind: 'media-progress', id: event.id, line: event.line, roomId: '' }
      : { kind: 'media-made', id: event.id, roomId: '' }), () => emit('media-feed', null));
  }
  watching += 1;
  return () => { watching -= 1; if (watching === 0) close(); };
}

// What one studio card holds: the sidecar the server owns, kept fresh, and `hint` when no backend is set up yet.
// `make` asks for something new; the server answers at once and the job itself arrives on the feed, which is what a
// render taking minutes needs. `problem` is what stopped the asking; the sidecar keeps the last job's own failure.
export function useMedia(id: string) {
  const [media, setMedia] = useState<Media>(EMPTY);
  const [hint, setHint] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [problem, setProblem] = useState('');
  const flushStage = useFlushStage();
  // Reading the card again, for the things a card changes without a job: a file dropped on it, or one taken off.
  const reload = useCallback(() => { if (id) void getMedia(id).then((got) => { setMedia(got); setHint(got.hint); }).catch(() => {}); }, [id]);

  useEffect(() => {
    // No card to watch: a caller asking about a studio that is not there gets the empty one and asks nobody.
    if (!id) return;
    let gone = false;
    const load = () => getMedia(id).then((got) => { if (!gone) { setMedia(got); setHint(got.hint); } }).catch(() => {});
    // The server must know this card before it will answer for it.
    const stops = [listen('effect', (effect) => {
      if (effect.id !== id) return;
      if (effect.kind === 'media-progress') setMedia((current) => ({ ...current, state: 'making', log: [...current.log.slice(-199), effect.line] }));
      // Every change ends the asking, whether something was made or something went wrong.
      if (effect.kind === 'media-made') { setAsked(false); void load(); }
    })];
    // The feed came back after a gap: whatever it carried meanwhile is lost, so read the card again.
    stops.push(listen('media-feed', () => { void load(); }));
    void flushStage().then(() => { if (!gone) { void load(); stops.push(share()); } });
    return () => { gone = true; for (const stop of stops) stop(); };
  }, [id, flushStage]);

  // The feed is the fast path, never the only one: while something is being made the card also asks the server itself,
  // so a lost event can slow a card down but never leave it waiting for good.
  const making = asked || media.state === 'making';
  const askedAt = useRef(0);
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => {
      void getMedia(id).then((got) => {
        setMedia(got); setHint(got.hint);
        const settled = got.state !== 'making' && (Date.now() - askedAt.current > 3000 || (got.results[0]?.at ?? 0) >= askedAt.current);
        if (settled) setAsked(false);
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [id, making]);

  const make = useCallback(async (ask: { prompt: string } & Record<string, unknown>) => {
    setProblem('');
    askedAt.current = Date.now();
    setAsked(true);
    try { await makeMedia(id, ask); }
    catch (error) { setProblem((error as Error).message); setAsked(false); }
  }, [id]);

  return { media, hint, making, problem, make, reload };
}

// How long a card has been at it, as the founder reads it: proof of life beside the step it is on.
export function useElapsed(making: boolean): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!making) { setSeconds(0); return; }
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [making]);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}
