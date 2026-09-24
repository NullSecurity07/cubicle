import { useEffect, useRef } from 'react';

// Looks now, then every `every` ms, for as long as the view is open and `seen` does not answer false. For a job that
// moves on its own for a while and then stops (a test run, a forge job): once it stops, nothing more is asked. A look
// that comes back after the view moved on is dropped. `ask` null means there is nothing to watch yet. The callbacks
// are read fresh on every look, so only `deps` starts the watch over.
export function usePoll<T>(ask: (() => Promise<T>) | null, every: number, seen: (value: T) => boolean | void, failed: (error: Error) => void, deps: unknown[]) {
  const latest = useRef({ ask, seen, failed });
  latest.current = { ask, seen, failed };
  const watching = !!ask;
  useEffect(() => {
    if (!watching) return;
    let gone = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const look = async () => {
      try {
        const value = await latest.current.ask!();
        if (!gone && latest.current.seen(value) === false) clearInterval(timer);
      } catch (error) { if (!gone) latest.current.failed(error as Error); }
    };
    void look();
    timer = setInterval(() => { void look(); }, every);
    return () => { gone = true; clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller says what starts a new watch
  }, [watching, every, ...deps]);
}
