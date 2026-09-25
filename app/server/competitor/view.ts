import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { changePhrase, diffLines, FOUNDER, OVERDUE_MS, pageLabel, samePage, type ChangeRow, type CompetitorView, type LastCrawl, type WatchedPage } from '../../shared/competitor.ts';
import type { Card, Stage } from '../../shared/model.ts';
import type { Watch, WatchChange, Watches } from '../slices/crawl.ts';
import { wired } from '../prompt.ts';

export type CompetitorCard = Extract<Card, { kind: 'competitor' }>;
export const competitorCards = (stage: Stage) => (stage.cards ?? []).filter((card): card is CompetitorCard => card.kind === 'competitor');
export const SHOWN = 30;

// Every change a watch has seen, oldest first. A watch saved before it kept a history has only its last one.
export function changesOf(watch: Pick<Watch, 'history' | 'changedAt' | 'diff'>): WatchChange[] {
  const history = [...(watch.history ?? [])];
  if (watch.changedAt && !history.some((one) => one.at === watch.changedAt)) history.push({ at: watch.changedAt, diff: watch.diff ?? '' });
  return history.sort((one, other) => one.at - other.at);
}

// The person who speaks for this card: the first one wired to it, whichever way the wire was drawn.
export const personOf = (stage: Stage, cardId: string) => {
  const id = wired(stage, cardId, stage.rooms.filter((room) => room.name).map((room) => room.id))[0];
  return id ? stage.rooms.find((room) => room.id === id)! : null;
};

// The watches this card shows: the one for each page it lists (one it started first, else anybody's), and any it
// started whose page has since left the list, so nothing it owns goes unseen.
export function joinWatches(card: CompetitorCard, all: Watch[]): { url: string; watch?: Watch }[] {
  const rows: { url: string; watch?: Watch }[] = [];
  for (const url of card.pages ?? []) {
    if (rows.some((row) => samePage(row.url, url))) continue;
    const matching = all.filter((one) => samePage(one.url, url));
    rows.push({ url, watch: matching.find((one) => one.cardId === card.id) ?? matching[0] });
  }
  for (const one of all) if (one.cardId === card.id && !rows.some((row) => samePage(row.url, one.url))) rows.push({ url: one.url, watch: one });
  return rows;
}

// What the card shows, worked out from the card, the watch store and the newest whole-site read. No model is asked.
export function buildView(card: CompetitorCard, all: Watch[], stage: Stage, now: number, crawl: LastCrawl | null = null): CompetitorView {
  const rows = joinWatches(card, all);
  const ownerOf = (roomId: string) => (roomId === FOUNDER ? 'you' : stage.rooms.find((room) => room.id === roomId)?.name || 'you');
  const pages: WatchedPage[] = rows.map(({ url, watch }) => ({
    url, label: pageLabel(url),
    ...(watch ? { watch: { id: watch.id, title: watch.title, readAt: watch.readAt, changedAt: watch.changedAt, fails: watch.fails, lastFail: watch.lastFail, owner: ownerOf(watch.roomId) } } : {}),
  }));
  const changes: ChangeRow[] = rows.flatMap(({ watch }) => (watch ? changesOf(watch).map((change) => ({
    id: `${watch.id}:${change.at}`, url: watch.url, label: pageLabel(watch.url), at: change.at,
    lines: diffLines(change.diff), phrase: changePhrase(change.diff), ...(change.note ? { note: change.note } : {}),
  })) : [])).sort((one, other) => other.at - one.at).slice(0, SHOWN);
  const reads = rows.flatMap(({ watch }) => (watch?.readAt ? [watch.readAt] : []));
  const lastRead = reads.length ? Math.max(...reads) : null;
  return { pages, changes, lastRead, overdue: lastRead !== null && now - lastRead > OVERDUE_MS, crawl, person: personOf(stage, card.id)?.name ?? null };
}

// The newest whole-site read of this host in the shared files, as crawl_site names them: `crawls/<host>-<day>.md`.
export async function lastCrawl(filesDir: string, host: string): Promise<LastCrawl | null> {
  if (!host) return null;
  const bare = host.replace(/^www\./, '').toLowerCase();
  const names = (await readdir(join(filesDir, 'crawls')).catch(() => [] as string[]))
    .map((name) => ({ name, found: /^(.+)-(\d{4}-\d{2}-\d{2})\.md$/.exec(name) }))
    .filter((one) => one.found && one.found[1].toLowerCase().replace(/^www\./, '') === bare.replace(/[^a-z0-9.-]+/g, '-'))
    .sort((one, other) => one.found![2].localeCompare(other.found![2]));
  const newest = names.at(-1);
  if (!newest) return null;
  const head = (await readFile(join(filesDir, 'crawls', newest.name), 'utf8').catch(() => '')).slice(0, 600);
  return { file: `crawls/${newest.name}`, day: newest.found![2], pages: Number(/ (\d+) pages?\./.exec(head)?.[1] ?? 0) };
}

// Writes what a person made of one change beside it. A change from before the history began joins the history first.
export async function noteChange(watches: Watches, watch: Pick<Watch, 'id' | 'roomId'>, at: number, note: { by: string; text: string }): Promise<boolean> {
  return watches.change(watch.roomId, (list) => {
    const one = list.find((candidate) => candidate.id === watch.id);
    if (!one) return false;
    one.history = changesOf(one);
    const change = one.history.find((candidate) => candidate.at === at);
    if (!change) return false;
    change.note = note;
    return true;
  });
}

// What is said back, trimmed to the two short lines the card has room for.
export function twoLines(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 2);
  return lines.map((line) => (line.length > 200 ? `${line.slice(0, 199).trimEnd()}…` : line)).join('\n');
}
