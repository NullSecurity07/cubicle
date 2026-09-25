import { competitorChannel, type CompetitorEvent, type CompetitorView, type LastCrawl } from '../../shared/competitor';
import { feed } from '../feed';

// The Competitor card's own calls, kept beside the card so the card is its own few files.
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `${response.status} ${path}`);
  return response.json() as Promise<T>;
}
const base = (cardId: string) => `/api/competitor/${cardId}`;

export const getCompetitor = (cardId: string) => call<CompetitorView>(base(cardId));
export const watchCompetitorPage = (cardId: string, url: string) => call<{ ok: true; text: string }>(`${base(cardId)}/watch`, 'POST', { url });
export const stopCompetitorPage = (cardId: string, url: string) => call<{ ok: true; stopped: number }>(`${base(cardId)}/stop`, 'POST', { url });
export const crawlCompetitor = (cardId: string) => call<{ text: string; crawl: LastCrawl | null }>(`${base(cardId)}/crawl`, 'POST');

// The card's view, read once (tried again for a few seconds, since a card just added may be asked about a moment before
// the server has its saved stage), read again whenever the feed says something moved, and every minute so "3 h ago"
// stays true. `again` reads it at once, after the founder changed something. While a wired person is still reading a
// change it is read every few seconds for a minute: their note can land before this window's feed is listening.
const SOON = 4000;
const SOON_TRIES = 15;
export function followCompetitor(cardId: string, onView: (view: CompetitorView) => void) {
  let gone = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let soon: ReturnType<typeof setTimeout> | undefined;
  let waited = 0;
  let asked = 0;
  const read = (tries = 0) => {
    const mine = ++asked;
    void getCompetitor(cardId).then((view) => {
      if (gone || mine !== asked) return;
      onView(view);
      clearTimeout(soon);
      const pending = !!view.person && view.changes.some((change) => !change.note);
      waited = pending ? waited + 1 : 0;
      if (pending && waited <= SOON_TRIES) soon = setTimeout(() => read(), SOON);
    }, () => {
      if (!gone && tries < 12) timer = setTimeout(() => read(tries + 1), 250 + tries * 150);
    });
  };
  const stop = feed<CompetitorEvent>(competitorChannel(cardId), () => read());
  const minute = setInterval(() => read(), 60_000);
  read();
  return { again: () => read(), stop: () => { gone = true; clearTimeout(timer); clearTimeout(soon); clearInterval(minute); stop(); } };
}
