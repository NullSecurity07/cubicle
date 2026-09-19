import { useCallback, useEffect, useState } from 'react';
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
      : { kind: 'media-made', id: event.id, roomId: '' }));
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
  const reload = useCallback(() => { void getMedia(id).then((got) => { setMedia(got); setHint(got.hint); }).catch(() => {}); }, [id]);

  useEffect(() => {
    let gone = false;
    const load = () => getMedia(id).then((got) => { if (!gone) { setMedia(got); setHint(got.hint); } }).catch(() => {});
    // The server must know this card before it will answer for it.
    const stops = [listen('effect', (effect) => {
      if (effect.id !== id) return;
      if (effect.kind === 'media-progress') setMedia((current) => ({ ...current, state: 'making', log: [...current.log.slice(-199), effect.line] }));
      // Every change ends the asking, whether something was made or something went wrong.
      if (effect.kind === 'media-made') { setAsked(false); void load(); }
    })];
    void flushStage().then(() => { if (!gone) { void load(); stops.push(share()); } });
    return () => { gone = true; for (const stop of stops) stop(); };
  }, [id, flushStage]);

  const make = useCallback(async (ask: { prompt: string } & Record<string, unknown>) => {
    setProblem('');
    setAsked(true);
    try { await makeMedia(id, ask); }
    catch (error) { setProblem((error as Error).message); setAsked(false); }
  }, [id]);

  return { media, hint, making: asked || media.state === 'making', problem, make, reload };
}
