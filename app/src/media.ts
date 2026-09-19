import { useEffect, useState } from 'react';
import type { Media } from '../shared/model';
import { getMedia, watchMedia } from './api';
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
export function useMedia(id: string) {
  const [media, setMedia] = useState<Media>(EMPTY);
  const [hint, setHint] = useState<string | null>(null);
  const flushStage = useFlushStage();

  useEffect(() => {
    let gone = false;
    const load = () => getMedia(id).then((got) => { if (!gone) { setMedia(got); setHint(got.hint); } }).catch(() => {});
    // The server must know this card before it will answer for it.
    const stops = [listen('effect', (effect) => {
      if (effect.id !== id) return;
      if (effect.kind === 'media-progress') setMedia((current) => ({ ...current, state: 'making', log: [...current.log.slice(-199), effect.line] }));
      if (effect.kind === 'media-made') void load();
    })];
    void flushStage().then(() => { if (!gone) { void load(); stops.push(share()); } });
    return () => { gone = true; for (const stop of stops) stop(); };
  }, [id, flushStage]);

  return { media, hint };
}
