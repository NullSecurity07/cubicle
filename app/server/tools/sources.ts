import type { Card } from '../../shared/model.ts';
import { findSource, safeHost, sourceCards } from '../../shared/sources.ts';
import { webUrl, type Browser } from '../browser.ts';
import type { Sources } from '../sources.ts';
import { text, type Tool } from './registry.ts';
import { browserSession, howFar, list, MAX_EACH, RECENT, SNIPPETS, UNTRUSTED } from './web.ts';

export { findSource, hostOf } from '../../shared/sources.ts';

const MOST_LINKS = 12;
const RESULT = /^(\d+)\.\s(.*)$/;

const sourceName = (card: Card & { kind: 'source' }) => card.title?.trim() || safeHost(card.url);

// A search engine does not always honour site:, so every result whose address is on another host is dropped and the
// rest are numbered again. Returns the blocks and whether any result was left at all.
export function onHost(found: string, host: string): { text: string; any: boolean } {
  let any = false;
  const blocks = found.split(/\n\n(?=## )/).map((block) => {
    const lines = block.split('\n');
    const out: string[] = [];
    let kept = 0;
    let seen = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const head = RESULT.exec(lines[index]);
      if (!head) { out.push(lines[index]); continue; }
      const rest: string[] = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) rest.push(lines[(index += 1)]);
      seen += 1;
      if (safeHost(rest[0]?.trim() ?? '') !== host) continue;
      kept += 1;
      out.push(`${kept}. ${head[2]}`, ...rest);
    }
    if (seen && !kept) out.push(`Nothing from ${host} among the results.`);
    if (kept) any = true;
    return out.join('\n');
  });
  return { text: blocks.join('\n\n'), any };
}

// The home page links to itself from every page; that link is where the person already is.
const isHome = (url: string) => { try { return new URL(url).pathname.replace(/\/+$/, '') === ''; } catch { return true; } };

const wordsOf = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4));

// When the engine finds nothing inside the site, the site's own home page still links to what it holds: the links
// whose words meet a query's words are the next best thing to a search result.
export function homeLinks(home: string, host: string, queries: string[]): string {
  const links = new Map<string, string>();
  for (const match of home.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) if (!links.has(match[2])) links.set(match[2], match[1].trim());
  for (const match of home.matchAll(/(?<![(\w])https?:\/\/[^\s)\]]+/g)) if (!links.has(match[0])) links.set(match[0], new URL(match[0]).pathname.replace(/[/_-]+/g, ' ').trim());
  let left = MOST_LINKS;
  return queries.map((query) => {
    const wanted = wordsOf(query);
    const picked: string[] = [];
    for (const [url, text] of links) {
      if (!left || safeHost(url) !== host || isHome(url) || ![...wordsOf(`${text} ${url}`)].some((word) => wanted.has(word))) continue;
      picked.push(`- ${text || url}\n  ${url}`);
      links.delete(url);
      left -= 1;
    }
    return `## ${query}\n${picked.length ? `From the home page:\n${picked.join('\n')}` : `Nothing on ${host} matched, in the search or on its home page.`}`;
  }).join('\n\n');
}

export function sourceTools(browser: Pick<Browser, 'search' | 'read'>, sources: Pick<Sources, 'propose'>): Tool[] {
  return [
    {
      name: 'search_source',
      perTurn: 3,
      description: `Search inside one of the websites the founder trusts, when its description fits the question. Give the source by its name or host and every query at once (up to ${MAX_EACH}). Read the pages that matter with web_fetch before you quote them.`,
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'The source\'s name or host, as your instructions list it.' },
          queries: { type: 'array', items: { type: 'string' } },
          recent: { type: 'string', enum: RECENT, description: 'Only results from the last day, week, month or year.' },
        },
        required: ['source', 'queries'],
      },
      async run(args, context) {
        const wanted = typeof args.source === 'string' ? args.source : '';
        const card = findSource(context.stage.cards, wanted);
        if (!card) {
          const names = sourceCards(context.stage.cards).map(sourceName);
          throw new Error(`no source called "${wanted}". ${names.length ? `The sources are: ${names.join(', ')}` : 'The founder has not added any source websites.'}`);
        }
        const queries = list(args, 'queries');
        const host = safeHost(card.url);
        // The source card's own session, so the founder can watch the search on the card.
        const session = browserSession(card.id);
        const found = onHost(await browser.search(queries.map((query) => `site:${host} ${query}`), howFar(args), session), host);
        const body = found.any ? found.text : homeLinks(await browser.read([card.url], session), host, queries);
        return { text: UNTRUSTED + body + SNIPPETS, effect: { kind: 'browser-moved', id: card.id } };
      },
    },
    {
      name: 'propose_source',
      description: 'Propose a website for the founder to add to the sources every person searches, when a site keeps answering questions like the ones you get. '
        + 'Give its address, one line on what it holds, and why it is worth adding. The founder decides; it waits for them in Needs you.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The site\'s address.' },
          about: { type: 'string', description: 'One line on what the site holds, for example "startup case studies".' },
          why: { type: 'string', description: 'Why it is worth adding, in a sentence or two.' },
        },
        required: ['url', 'about', 'why'],
      },
      async run(args, context) {
        const url = webUrl(typeof args.url === 'string' ? args.url.trim() : '');
        const about = text(args, 'about', 160).trim().replace(/\s+/g, ' ');
        const why = text(args, 'why', 400).trim().replace(/\s+/g, ' ');
        const by = context.stage.rooms.find((room) => room.id === context.roomId)?.name || 'A person';
        const existing = sourceCards(context.stage.cards).map((card) => safeHost(card.url)).filter(Boolean);
        const made = await sources.propose({ url, about, why, by }, existing);
        return { text: `Proposed ${safeHost(made.url)}. It waits for the founder in Needs you.` };
      },
    },
  ];
}
