import { join } from 'node:path';
import { competitorChannel, competitorLine, FOUNDER, hostOf, pageLabel, siteUrl, type CompetitorView } from '../../shared/competitor.ts';
import type { Stage } from '../../shared/model.ts';
import { localDay } from '../clock.ts';
import { buildView, changesOf, competitorCards, joinWatches, lastCrawl, noteChange, guardedNote, personOf, type CompetitorCard } from '../competitor/view.ts';
import { hub } from '../events.ts';
import type { Deps, Slice } from '../install.ts';
import { wired } from '../prompt.ts';
import { complete, promptSize } from '../providers.ts';
import { route as routeModels } from '../router.ts';
import type { Handler } from '../seams.ts';
import { fakeSite, runCrawl, sameUrl as sameWatched, startWatch, watchesAt, type CrawlOptions, type Watch } from './crawl.ts';

// The Competitor card: one rival, a few of their pages watched, and a timeline of what changed on them with what a
// wired person makes of each change. It keeps no store of its own: the watches are the crawl slice's, joined to the
// card by address, and a whole-site read is the file crawl_site already writes under `crawls/`.

// Changes older than this are not sent to a person to be read: a card added to an old watch does not spend a month of calls.
const NOTE_WITHIN = 30 * 86_400_000;
export const FAKE_NOTE = 'Fake mode reads no model, so this line stands where the wired person would say what the change means.';
// The fixed ask, in the person's own voice and with everything they know: what the change is and what it may mean.
export const noteAsk = (name: string, label: string, url: string, at: number, diff: string) =>
  `The ${label.toLowerCase()} page of our competitor ${name} (${url}) changed on ${localDay(at)}. The lines that changed:\n${diff}\n\n`
  + 'In two short lines and nothing else: first what changed, in plain words; then what it may mean for us. No preamble, no tools.';

export default {
  name: 'competitor',
  install(deps: Deps) {
    const watches = watchesAt(join(deps.workspace, 'watch'));
    const options: CrawlOptions = {
      workspace: deps.workspace, cache: false,
      ...(deps.fake ? { http: fakeSite, resolveHost: async () => [] } : {}),
      save: (name, text) => deps.store.writeFile(name, text),
    };
    const cardOn = async (cardId: string) => competitorCards(await deps.store.loadStage()).find((card) => card.id === cardId) ?? null;
    const viewOf = async (card: CompetitorCard, stage: Stage): Promise<CompetitorView> =>
      buildView(card, await watches.all(), stage, Date.now(), await lastCrawl(deps.store.filesDir, hostOf(card.url)));
    const nudge = (cardId: string) => hub.say(competitorChannel(cardId), { changed: true });

    // One person's two lines on one change, asked the way their own chat asks them: their prompt, then the fixed ask.
    async function ask(stage: Stage, roomId: string, card: CompetitorCard, watch: Watch, at: number, diff: string): Promise<string> {
      if (deps.fake) return FAKE_NOTE;
      const messages = [...await deps.promptFor(stage, roomId, [], true), { role: 'user' as const, content: noteAsk(card.name || hostOf(card.url), pageLabel(watch.url), watch.url, at, diff) }];
      const { order } = routeModels(deps.clients, deps.usage, { promptChars: promptSize(messages), tools: false });
      const reply = await complete(messages, { onToken: () => {} }, order);
      deps.usage.record(reply.client.name, reply.usage, reply.quota);
      return guardedNote(reply.text, diff);
    }

    // One change without a note, on any card with a person wired, is read at a time. A failure is left for the next tick.
    let noting: Promise<void> | null = null;
    const failed = new Set<string>();
    const noteOne = () => (noting ??= (async () => {
      try {
        const stage = await deps.store.loadStage();
        const all = await watches.all();
        for (const card of competitorCards(stage)) {
          const person = personOf(stage, card.id);
          if (!person) continue;
          for (const { watch } of joinWatches(card, all)) {
            const open = watch ? changesOf(watch).filter((change) => !change.note && Date.now() - change.at < NOTE_WITHIN && !failed.has(`${watch.id}:${change.at}`)).at(-1) : undefined;
            if (!watch || !open) continue;
            try {
              const text = await ask(stage, person.id, card, watch, open.at, open.diff);
              if (text) await noteChange(watches, watch, open.at, { by: person.name, text });
              else failed.add(`${watch.id}:${open.at}`);
            } catch { failed.add(`${watch.id}:${open.at}`); }
            nudge(card.id);
            return;
          }
        }
      } finally { noting = null; }
    })());

    // A card hears when anything it shows moved: a page read, a change, a note. Compared on each tick, sent only on a difference.
    const seen = new Map<string, string>();
    async function tick() {
      failed.clear();
      await noteOne().catch(() => {});
      const stage = await deps.store.loadStage();
      const all = await watches.all();
      for (const card of competitorCards(stage)) {
        const mark = JSON.stringify(joinWatches(card, all).map(({ watch }) => watch && [watch.id, watch.readAt, watch.changedAt, watch.fails, changesOf(watch).map((change) => !!change.note)]));
        if (seen.has(card.id) && seen.get(card.id) !== mark) nudge(card.id);
        seen.set(card.id, mark);
      }
    }

    // A person wired to a Competitor card reads one dated line for it: how much changed this month and the latest change.
    const before: Handler<'turn:before'> = async (payload, next) => {
      const [system, ...rest] = payload.messages;
      if (system?.role !== 'system') return next(payload);
      const stage = await deps.store.loadStage().catch(() => null);
      const cards = stage ? competitorCards(stage) : [];
      const mine = stage ? wired(stage, payload.roomId, cards.map((card) => card.id)) : [];
      if (!stage || !mine.length) return next(payload);
      const all = await watches.all();
      const now = Date.now();
      const lines = cards.filter((card) => mine.includes(card.id)).map((card) => competitorLine(card, buildView(card, all, stage, now), now));
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${lines.join('\n')}\n  Read a rival's whole site with crawl_site; watch another page of theirs with watch_page.` }, ...rest] });
    };
    const off = deps.seams ? [deps.seams.on('turn:before', before)] : [];

    return {
      tick,
      async route(req, res, path) {
        const asked = /^\/api\/competitor\/([a-z0-9][a-z0-9-]{0,63})(?:\/(watch|stop|crawl))?$/.exec(path);
        if (!asked) return false;
        const [, cardId, part] = asked;
        const card = await cardOn(cardId);
        if (!card) { deps.json(res, 404, { error: 'there is no Competitor card by that name' }); return true; }
        const method = req.method ?? 'GET';
        const stage = await deps.store.loadStage();
        if (!part && method === 'GET') {
          deps.json(res, 200, await viewOf(card, stage));
          void noteOne().catch(() => {});
          return true;
        }
        if (method !== 'POST') return false;
        // A page watched from the card belongs to the person wired to it, so a change reaches their room; with nobody
        // wired it is the founder's, and reaches Needs you only.
        if (part === 'watch') {
          const url = siteUrl(String((await deps.body(req))?.url ?? ''));
          if (!url) { deps.json(res, 400, { error: 'Give a page\'s address, like acme.com/pricing.' }); return true; }
          const owner = personOf(stage, card.id)?.id ?? FOUNDER;
          const started = await startWatch(watches, options, { roomId: owner, url, what: `${card.name || hostOf(card.url)}: what changes on this page`, cardId: card.id });
          await deps.attention.refresh().catch(() => {});
          nudge(card.id);
          deps.json(res, started.ok ? 200 : 400, started.ok ? { ok: true, text: started.text } : { error: started.text });
          return true;
        }
        // Only a watch the card started stops with the card's ×: a page a person chose to watch stays theirs.
        if (part === 'stop') {
          const url = String((await deps.body(req))?.url ?? '');
          const mine = (await watches.all()).filter((one) => one.cardId === card.id && sameWatched(one.url, url));
          for (const one of mine) await watches.change(one.roomId, (list) => { const at = list.findIndex((candidate) => candidate.id === one.id); if (at >= 0) list.splice(at, 1); });
          await deps.attention.refresh().catch(() => {});
          nudge(card.id);
          deps.json(res, 200, { ok: true, stopped: mine.length });
          return true;
        }
        if (part === 'crawl') {
          const url = siteUrl(card.url);
          if (!url) { deps.json(res, 400, { error: 'Give the competitor\'s website first.' }); return true; }
          const text = await runCrawl({ url }, options);
          nudge(card.id);
          deps.json(res, 200, { text, crawl: await lastCrawl(deps.store.filesDir, hostOf(card.url)) });
          return true;
        }
        return false;
      },
      async close() {
        for (const stop of off) stop();
        await noting?.catch(() => {});
        await watches.settled();
      },
    };
  },
} satisfies Slice;
