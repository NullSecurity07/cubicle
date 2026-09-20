// One live connection for the whole window, carrying every feed. A browser allows about six connections to a site
// and a feed holds one for as long as the window is open: a page that opened one per feed, plus one per board card,
// ran out of them on an ordinary stage, and everything asked for afterwards — the founder's conversations, their
// missions, a picture — queued behind feeds that never end. So everything arrives on one stream, each piece of news
// in an envelope that says which channel it came from.
//
// The rest is one way to keep that connection alive. A browser reopens a feed that was refused or cut, but it cannot
// tell a feed that has gone quiet from one that has died: when the server restarts, or the machine sleeps, whatever
// sits in between (Vite's proxy, the shell's web view) may keep this end open and say nothing. The window then sat
// there looking connected, and nothing the people did reached the canvas until it was reloaded. So the server says
// "still here" every quarter of a minute, and a connection that has heard nothing for QUIET is opened again.
// `onOpen` is told whether it had been open before: whoever missed a gap reads afresh rather than guess.
export const QUIET = 40_000;
const RETRY = 1_500;
const HUB = '/api/events';

type Source = Pick<EventSource, 'close' | 'readyState' | 'addEventListener'> & { onopen: unknown; onmessage: unknown; onerror: unknown };
type Envelope = { channel: string; data: unknown; snapshot?: true };
type Listener = { hear: (event: never) => void; opened: (again: boolean) => void };

const channels = new Map<string, Set<Listener>>();
// What each channel said on opening, so a card that arrives after the connection did is whole without waiting for
// the next thing to happen. Only the server marks a message as one of these.
const snapshots = new Map<string, unknown>();
let make: (url: string) => Source = (url) => new EventSource(url);
let source: Source | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let opened = false;

function open() {
  source?.close();
  const mine = make(HUB);
  source = mine;
  const heard = () => { clearTimeout(watchdog); watchdog = setTimeout(open, QUIET); };
  heard();
  mine.onopen = () => { heard(); for (const one of everyone()) one.opened(opened); opened = true; };
  mine.onmessage = (message: MessageEvent) => { heard(); deliver(JSON.parse(message.data) as Envelope); };
  mine.addEventListener('pulse', heard);
  // A refused connection is closed for good by the browser; one that is merely reconnecting is left to get on with it.
  mine.onerror = () => { if (source !== mine || mine.readyState !== 2) return; clearTimeout(retry); retry = setTimeout(open, RETRY); };
}

function shut() {
  clearTimeout(retry);
  clearTimeout(watchdog);
  source?.close();
  source = null;
  opened = false;
  snapshots.clear();
}

const everyone = () => [...channels.values()].flatMap((here) => [...here]);
function deliver(envelope: Envelope) {
  if (envelope.snapshot) snapshots.set(envelope.channel, envelope.data);
  for (const one of [...(channels.get(envelope.channel) ?? [])]) one.hear(envelope.data as never);
}

// Listen to one channel. The connection opens with the first listener and closes when the last one leaves; `made` is
// the browser's own EventSource, or the one a test drives by hand.
export function feed<T>(channel: string, onEvent: (event: T) => void, onOpen: (again: boolean) => void = () => {}, made?: (url: string) => Source) {
  if (made) make = made;
  const here = channels.get(channel) ?? new Set<Listener>();
  channels.set(channel, here);
  const one: Listener = { hear: onEvent as Listener['hear'], opened: onOpen };
  here.add(one);
  // Whatever this channel said when the connection opened, for a listener that was not there to hear it. Not while
  // the caller is still subscribing: a card is told about its own state after it has finished asking for it.
  const known = snapshots.get(channel);
  if (known !== undefined) queueMicrotask(() => { if (here.has(one)) onEvent(known as T); });
  if (!source) open();
  return () => {
    here.delete(one);
    if (!here.size) channels.delete(channel);
    if (!channels.size) shut();
  };
}

// Whether this channel's opening news is already in hand, for a card that has to read itself once otherwise.
export const snapshot = (channel: string) => snapshots.get(channel);

// Vite re-evaluates this module on every hot reload in development, and the connection the old copy held was closed
// by nobody: a few saves in a row and the window had none left for anything else. This is how the founder's window
// ran out today. Not `hot.dispose`, which is only called for the module a hot update is accepted in, and this one is
// never that: `hot.data` is kept under this file's own path across the swap, so the new copy shuts the old one.
// Written out as a plain `if`, because a build replaces the whole `import.meta.hot` with nothing.
if (import.meta.hot) {
  (import.meta.hot.data.shut as (() => void) | undefined)?.();
  import.meta.hot.data.shut = shut;
}
