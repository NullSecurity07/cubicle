import type { Card } from './model.ts';

// A site's name without the www, so 'www.startups.rip' and 'startups.rip' are the same source. It parses the address
// itself because the guard that refuses local addresses lives on the server, and this file is shared.
export const hostOf = (raw: string): string => new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, '').toLowerCase();

// A host that cannot be parsed is no host, rather than a throw in the middle of building a prompt.
export const safeHost = (raw: string): string => { try { return hostOf(raw); } catch { return ''; } };

export type SourceCard = Card & { kind: 'source' };

export const sourceCards = (cards: Card[] | undefined): SourceCard[] => (cards ?? []).filter((card): card is SourceCard => card.kind === 'source' && Boolean(card.url));

// Small models name a source either way, so a source answers to its title or its host, in any case.
export function findSource(cards: Card[] | undefined, wanted: string): SourceCard | undefined {
  const name = wanted.trim().toLowerCase();
  if (!name) return undefined;
  const asHost = safeHost(name);
  return sourceCards(cards).find((card) => card.title?.trim().toLowerCase() === name || safeHost(card.url) === name || (asHost && safeHost(card.url) === asHost));
}
