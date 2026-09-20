// One way to keep a live feed alive, for every feed in the window. A browser reopens a feed that was refused or cut,
// but it cannot tell a feed that has gone quiet from one that has died: when the server restarts, or the machine
// sleeps, whatever sits in between (Vite's proxy, the shell's web view) may keep this end open and say nothing. The
// window then sat there looking connected, and nothing the people did reached the canvas until it was reloaded.
// So the server says "still here" every quarter of a minute, and a feed that has heard nothing for QUIET is opened
// again. `onOpen` is told whether it had been open before: whoever missed a gap reads afresh rather than guess.
export const QUIET = 40_000;
const RETRY = 1_500;

type Source = Pick<EventSource, 'close' | 'readyState' | 'addEventListener'> & { onopen: unknown; onmessage: unknown; onerror: unknown };

export function feed<T>(url: string, onEvent: (event: T) => void, onOpen: (again: boolean) => void = () => {}, make: (url: string) => Source = (one) => new EventSource(one)) {
  let source: Source | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let opened = false;
  let closed = false;

  const open = () => {
    if (closed) return;
    source?.close();
    const mine = make(url);
    source = mine;
    const heard = () => { clearTimeout(watchdog); watchdog = setTimeout(open, QUIET); };
    heard();
    mine.onopen = () => { heard(); onOpen(opened); opened = true; };
    mine.onmessage = (message: MessageEvent) => { heard(); onEvent(JSON.parse(message.data) as T); };
    mine.addEventListener('pulse', heard);
    // A refused feed is closed for good by the browser; one that is merely reconnecting is left to get on with it.
    mine.onerror = () => { if (closed || source !== mine || mine.readyState !== 2) return; clearTimeout(retry); retry = setTimeout(open, RETRY); };
  };
  open();
  return () => { closed = true; clearTimeout(retry); clearTimeout(watchdog); source?.close(); };
}
