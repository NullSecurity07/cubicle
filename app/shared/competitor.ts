// The Competitor card: one rival, the pages of theirs being watched, and what changed on them. The card keeps only
// the rival's name, site and the pages the founder chose; the watches and their changes live in the watch store, and
// a whole-site read lives in the shared files under `crawls/`. Everything counted here is counted in TypeScript.

export const competitorChannel = (cardId: string) => `competitor:${cardId}`;
// Pages are read every six hours while the app is open. Past this since the last read, the card says so in amber.
export const OVERDUE_MS = 7 * 3600_000;
// Who a watch belongs to when the founder started it from the card and nobody was wired to it.
export const FOUNDER = 'founder';

export type WatchedPage = {
  url: string; label: string;
  // The watch that reads this page, when there is one. `owner` is the name of the person it belongs to, or "you".
  watch?: { id: string; title: string; readAt?: number; changedAt?: number; fails?: number; lastFail?: string; owner: string };
};
export type ChangeRow = { id: string; url: string; label: string; at: number; lines: string[]; phrase: string; note?: { by: string; text: string } };
export type LastCrawl = { file: string; day: string; pages: number };
export type CompetitorView = {
  pages: WatchedPage[]; changes: ChangeRow[];
  // The newest read of any watched page, and whether that is longer ago than a six-hourly read should be.
  lastRead: number | null; overdue: boolean;
  crawl: LastCrawl | null;
  // The person wired to the card, who says what each change means. Null when nobody is.
  person: string | null;
};
// What the card's feed carries: a nudge that something it shows changed. The card reads its view again.
export type CompetitorEvent = { changed: true };

// The address as typed, made whole: a bare "acme.com" is https://acme.com.
export function siteUrl(raw?: string): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.href;
  } catch { return null; }
}
export const hostOf = (raw?: string) => { const url = siteUrl(raw); return url ? new URL(url).hostname.replace(/^www\./, '') : ''; };

// The page as one key: no fragment, no closing slash, no case. Two spellings of one page are one page.
export const pageKey = (raw: string) => {
  const url = siteUrl(raw);
  if (!url) return raw.trim().toLowerCase();
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname.replace(/\/+$/, '') || '/'}${parsed.search}`.toLowerCase();
};
export const samePage = (one: string, other: string) => pageKey(one) === pageKey(other);

// The three pages a founder watches first on any rival: the front door, the prices and what shipped.
export function suggestedPages(site: string): { url: string; label: string }[] {
  const url = siteUrl(site);
  if (!url) return [];
  const origin = new URL(url).origin;
  return [{ url: `${origin}/`, label: 'Home' }, { url: `${origin}/pricing`, label: 'Pricing' }, { url: `${origin}/changelog`, label: 'Changelog' }];
}

// What to call a page on the card and to a person: "Home" for the front door, else its last path part in words.
export function pageLabel(raw: string): string {
  const url = siteUrl(raw);
  if (!url) return raw.trim();
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const last = parts.at(-1);
  if (!last) return 'Home';
  const words = decodeURIComponent(last).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Home';
}

// A diff as the watch wrote it ("+ added", "− removed", "(and 3 more changed lines)") as its lines.
export const diffLines = (diff: string) => diff.split('\n').map((line) => line.trimEnd()).filter(Boolean);

const clip = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text);
// The one change in a few words: "Pro $29 → $39" when a line was replaced, else the first line added or taken out.
export function changePhrase(diff: string, most = 120): string {
  const lines = diffLines(diff);
  const added = lines.filter((line) => line.startsWith('+ ')).map((line) => line.slice(2).trim());
  const gone = lines.filter((line) => /^[−-] /.test(line)).map((line) => line.slice(2).trim());
  if (added.length && gone.length) {
    const before = gone[0].split(/\s+/);
    const after = added[0].split(/\s+/);
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
    let tail = 0;
    while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
    const old = before.slice(head, before.length - tail).join(' ');
    const now = after.slice(head, after.length - tail).join(' ');
    const lead = before.slice(0, head).join(' ');
    const rest = before.slice(before.length - tail).join(' ');
    if (old && now) return clip(`${lead ? `${lead} ` : ''}${old} → ${now}${rest ? ` ${rest}` : ''}`, most);
    return clip(`${gone[0]} → ${added[0]}`, most);
  }
  if (added.length) return clip(added[0], most);
  if (gone.length) return clip(`removed: ${gone[0]}`, most);
  return clip(lines[0] ?? 'changed', most);
}

// A day as the founder's calendar names it, YYYY-MM-DD in local time.
export const localDay = (at: number) => { const day = new Date(at); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; };

// The line a person wired to the card reads each turn, compact and dated:
// "- Competitor Acme (acme.com): 3 changes this month, latest 2026-09-22 pricing page: Pro $29 → $39."
export function competitorLine(card: { name?: string; url?: string }, view: Pick<CompetitorView, 'pages' | 'changes' | 'lastRead' | 'overdue'>, now: number): string {
  const host = hostOf(card.url);
  const who = `- Competitor ${(card.name ?? '').trim() || host || 'unnamed'}${host ? ` (${host})` : ''}`;
  const watched = view.pages.filter((page) => page.watch).length;
  if (!watched) return `${who}: no page watched yet.`;
  const month = localDay(now).slice(0, 7);
  const thisMonth = view.changes.filter((change) => localDay(change.at).startsWith(month)).length;
  const latest = view.changes[0];
  const stale = view.overdue && view.lastRead ? ` Last read ${localDay(view.lastRead)}, so newer changes may not be seen yet.` : '';
  if (!latest) return `${who}: ${watched} page${watched === 1 ? '' : 's'} watched, no change seen yet${view.lastRead ? `, last read ${localDay(view.lastRead)}` : ''}.${stale}`;
  return `${who}: ${thisMonth} change${thisMonth === 1 ? '' : 's'} this month, latest ${localDay(latest.at)} ${latest.label.toLowerCase()} page: ${latest.phrase.replace(/\.$/, '')}.${stale}`;
}

// "3 h ago", the way the rest of the app says it.
export const agoText = (at: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
};
