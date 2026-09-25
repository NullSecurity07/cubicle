import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deckChannel, isLook, isPurpose, type DeckEvent, type DeckLook, type DeckPurpose } from '../../shared/deck.ts';
import type { Card, Stage } from '../../shared/model.ts';
import { shortDay } from '../clock.ts';
import { hub } from '../events.ts';
import type { Material } from '../deck/critic.ts';
import { chromePath, NO_CHROME, printPdf, stubPdf } from '../deck/render.ts';
import { createDecks, type Decks, type Gathered } from '../deck/store.ts';
import { outlineOf, type Think } from '../deck/storyboard.ts';
import { projectDir } from '../folder.ts';
import type { Deps, Slice } from '../install.ts';
import { docsFor, sourcesFor, wiredTo } from '../media/gather.ts';
import { readProject } from '../media/sources.ts';
import { wired } from '../prompt.ts';
import { complete, promptSize } from '../providers.ts';
import { route as routeModels } from '../router.ts';
import type { Handler } from '../seams.ts';
import { text, type Tool, type ToolContext } from '../tools/registry.ts';

// The Deck card: a brief and what is wired to it become slides in the product's look, a strip of thumbnails and a
// PDF, all made on this machine. Notes remake only the slides they touch, as the next version beside the last.
// Nothing leaves the machine but the one storyboard call to the founder's own models, so nothing needs a yes.

export const DECK_TOOLS = ['make_deck', 'edit_deck', 'read_deck'];
export const NO_CARD = 'no Deck card is connected to your room. The founder adds one from the dock and draws a wire to it.';
const HINT = '- A Deck card: slides made from a brief and what is wired to it, printed to PDF. make_deck makes a new version, '
  + 'edit_deck({ notes }) remakes only the slides the notes touch ("merge 2 and 3", "drop 5", "slide 4: needs a source"), read_deck reads it slide by slide with the speaker notes.';

const decksOn = (stage: Stage) => (stage.cards ?? []).filter((card): card is Extract<Card, { kind: 'deck' }> => card.kind === 'deck');
const cardOf = (context: ToolContext) => {
  const id = wired(context.stage, context.roomId, decksOn(context.stage).map((card) => card.id))[0];
  if (!id) throw new Error(NO_CARD);
  return decksOn(context.stage).find((card) => card.id === id)!;
};

// A Metrics card's own block, when one is wired to the deck or to whoever asked. Its sidecar is read loosely: the
// card is built beside this one, and a deck must never fail because a card it only reads from changed its shape.
export async function metricsOf(workspace: string, stage: Stage, cardId: string, roomId?: string): Promise<Material['metrics']> {
  const near = [...wiredTo(stage, cardId), ...(roomId ? wiredTo(stage, roomId) : [])].filter((card) => (card.kind as string) === 'metrics');
  for (const card of near) {
    const raw = await readFile(join(workspace, 'metrics', `${card.id}.json`), 'utf8').catch(() => '');
    if (!raw) continue;
    let text = '';
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      text = typeof value.block === 'string' ? value.block : JSON.stringify(value).slice(0, 1400);
    } catch { text = raw.slice(0, 1400); }
    if (text.trim()) return { name: 'Metrics card', text: text.trim() };
  }
  return undefined;
}

// Everything a deck may draw on: the wired documents, notes and link titles, a wired project's words, colours,
// typeface and logo, and a Metrics card. Read fresh for every make, the way a film reads its material.
export async function gatherDeck(deps: Pick<Deps, 'workspace' | 'root' | 'store'>, cardId: string, roomId?: string): Promise<Gathered> {
  const stage = await deps.store.loadStage();
  const card = decksOn(stage).find((one) => one.id === cardId);
  const sources: Material['sources'] = [];
  const using: string[] = [];
  const dress: Gathered['dress'] = {};
  for (const one of sourcesFor(stage, cardId, roomId)) {
    try {
      if (one.kind === 'note' && one.text.trim()) { sources.push({ name: 'a note', text: one.text.slice(0, 1600) }); using.push('a note'); }
      else if (one.kind === 'project' && one.path) {
        const product = await readProject(projectDir(one.path, [deps.workspace, deps.root]));
        if (product.words) sources.push({ name: `the ${product.name ?? 'project'} README`, text: product.words.slice(0, 3000) });
        if (product.brand.colours.length || product.brand.font) dress.brand = product.brand;
        if (product.logo && /\.(png|jpe?g|webp|svg)$/i.test(product.logo.name)) dress.logo = product.logo;
        if (product.font && /\.(woff2?|ttf|otf)$/i.test(product.font.name)) dress.font = product.font;
        if (product.name) dress.footer = product.name;
        using.push(`${product.name ?? 'the'} project`);
      }
    } catch { /* a folder that cannot be read is left out, and the deck is made from the rest */ }
  }
  for (const id of docsFor(stage, cardId, roomId)) {
    const doc = stage.docs.find((one) => one.id === id)!;
    const words = await deps.store.readDoc(id).catch(() => '');
    if (words.trim()) { sources.push({ name: doc.title, text: words.slice(0, 2400) }); using.push(doc.title); }
  }
  const metrics = await metricsOf(deps.workspace, stage, cardId, roomId);
  if (metrics) using.push('the Metrics card');
  return { material: { brief: card?.brief ?? '', sources, ...(metrics ? { metrics } : {}) }, dress, using };
}

export function deckTools(decks: Decks): Tool[] {
  const wait = (context: ToolContext) => context.signal?.addEventListener('abort', () => decks.stop(cardOf(context).id), { once: true });
  return [
    {
      name: 'make_deck', perTurn: 1,
      description: 'Make a new version of the deck on the Deck card wired to you, from a brief and what is wired to the card. Takes under a minute.',
      parameters: { type: 'object', properties: {
        brief: { type: 'string', description: 'What the deck is for and what it must say. Left out, the card\'s own brief' },
        purpose: { type: 'string', enum: ['pitch', 'update', 'sales', 'demo-day'] },
        look: { type: 'string', enum: ['clean', 'editorial', 'brand'] },
      } },
      ready: () => (chromePath() ? null : NO_CHROME),
      async run(args, context) {
        const card = cardOf(context);
        const brief = typeof args.brief === 'string' && args.brief.trim() ? args.brief.trim().slice(0, 4000) : card.brief?.trim() ?? '';
        wait(context);
        const made = await decks.make(card.id, { brief, purpose: purposeOf(args.purpose, card.purpose), look: lookOf(args.look, card.look), roomId: context.roomId });
        return { text: `Deck version ${made.version}, ${made.slides.length} slides, PDF at ${made.pdf}.\n${outlineOf(made.slides).join('\n')}${made.said?.length ? `\nThe critic: ${made.said.join('; ')}.` : ''}` };
      },
    },
    {
      name: 'edit_deck', perTurn: 2,
      description: 'Notes on the deck: only the slides they touch are made again, as the next version. "merge 2 and 3", "drop 5", "move 6 to 2", "slide 4 headline: …", "slide 3: say it for a buyer".',
      parameters: { type: 'object', properties: { notes: { type: 'string' }, version: { type: 'number', description: 'Which version the slide numbers are on. Left out, the newest' } }, required: ['notes'] },
      ready: () => (chromePath() ? null : NO_CHROME),
      async run(args, context) {
        const card = cardOf(context);
        wait(context);
        const made = await decks.edit(card.id, text(args, 'notes', 2000), { ...(Number(args.version) ? { version: Number(args.version) } : {}), roomId: context.roomId });
        return { text: `Version ${made.version}: ${made.said?.join('; ')}.\n${outlineOf(made.slides).join('\n')}` };
      },
    },
    {
      name: 'read_deck', perTurn: 3,
      description: 'Read the deck on the Deck card wired to you, slide by slide, with the speaker notes and where each number came from.',
      parameters: { type: 'object', properties: { version: { type: 'number', description: 'Left out, the newest' } } },
      async run(args, context) {
        const deck = await decks.read(cardOf(context).id);
        const one = Number(args.version) ? deck.versions.find((candidate) => candidate.version === Number(args.version)) : deck.versions.at(-1);
        if (!one) return { text: 'The Deck card has no deck yet. make_deck makes one.' };
        const lines = one.slides.map((slide, index) => `${outlineOf([slide])[0].replace(/^1\./, `${index + 1}.`)}${slide.notes ? `\n   Notes: ${slide.notes.replace(/\s+/g, ' ')}` : ''}`);
        return { text: `"${one.title}", version ${one.version} of ${deck.versions.length}, made ${shortDay(one.at)}${one.notes ? ` from the notes "${one.notes}"` : ''}. PDF: ${one.pdf}\n${lines.join('\n')}` };
      },
    },
  ];
}
const purposeOf = (asked: unknown, card?: DeckPurpose): DeckPurpose => (isPurpose(asked) ? asked : card ?? 'pitch');
const lookOf = (asked: unknown, card?: DeckLook): DeckLook => (isLook(asked) ? asked : card ?? 'clean');

export default {
  name: 'deck',
  install(deps) {
    const say = (cardId: string, event: DeckEvent) => hub.say(deckChannel(cardId), { ...event, hint: chromePath() || deps.fake ? null : NO_CHROME });
    // The one storyboard call: the roomiest model that is ready, counted like everything else. Fake mode has none.
    const think: Think | undefined = deps.fake ? undefined : async (prompt, signal) => {
      const messages = [{ role: 'user' as const, content: prompt }];
      const { order } = routeModels(deps.clients, deps.usage, { promptChars: promptSize(messages), tools: false });
      const reply = await complete(messages, { onToken: () => {}, signal }, order);
      deps.usage.record(reply.client.name, reply.usage, reply.quota);
      return reply.text;
    };
    const gather = (cardId: string, roomId?: string) => gatherDeck(deps, cardId, roomId);
    const decks = createDecks({
      dir: deps.workspace, gather, think, tell: say,
      save: (name, bytes) => deps.store.saveFileBytes(name, bytes),
      // Fake mode prints for real when Chrome is here, and writes a stand-in PDF when it is not.
      print: (html, signal) => (deps.fake && !chromePath() ? Promise.resolve(stubPdf((html.match(/<section /g) ?? []).length)) : printPdf(html, signal)),
    });
    const onStage = async () => decksOn(await deps.store.loadStage()).map((card) => card.id);

    const opening = async () => Promise.all((await onStage()).map(async (id) => ({ channel: deckChannel(id), data: { ...(await decks.event(id)), hint: chromePath() || deps.fake ? null : NO_CHROME } })));
    hub.opening.push(opening);

    // A person wired to a Deck card reads one line on what it is for, and the newest version in a few lines, dated.
    const before: Handler<'turn:before'> = async (payload, next) => {
      const [system, ...rest] = payload.messages;
      if (system?.role !== 'system') return next(payload);
      const stage = await deps.store.loadStage().catch(() => null);
      const mine = stage ? wired(stage, payload.roomId, decksOn(stage).map((card) => card.id)) : [];
      if (!mine.length) return next(payload);
      const deck = await decks.read(mine[0]).catch(() => null);
      const newest = deck?.versions.at(-1);
      const block = newest
        ? `\n  The deck now: "${newest.title}", version ${newest.version}, ${newest.slides.length} slides, made ${shortDay(newest.at)}. ${outlineOf(newest.slides).map((line) => line.replace(/ · .*$/, '')).join(' | ')}`.slice(0, 900)
        : '\n  No deck made yet.';
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${HINT}${block}` }, ...rest] });
    };
    const off = deps.seams ? [deps.seams.on('turn:before', before)] : [];

    return {
      tools: deckTools(decks),
      offer(tools, stage, roomId) {
        if (wired(stage, roomId, decksOn(stage).map((card) => card.id)).length) return tools;
        return tools.filter((tool) => !DECK_TOOLS.includes(tool.name));
      },
      async route(req, res, path) {
        const asked = /^\/api\/decks\/([a-z0-9][a-z0-9-]{0,63})(?:\/(make|edit|stop)|\/v\/(\d{1,4})\/slides\/(\d{1,3}))?$/.exec(path);
        if (!asked) return false;
        const [, cardId, action, version, slide] = asked;
        const method = req.method ?? 'GET';
        if (!(await onStage()).includes(cardId)) { deps.json(res, 404, { error: 'there is no Deck card by that name' }); return true; }
        try {
          if (!action && !version && method === 'GET') { deps.json(res, 200, { ...(await decks.event(cardId)), hint: chromePath() || deps.fake ? null : NO_CHROME }); return true; }
          // One slide as its own page, for a thumbnail. It is the app's own markup with no script in it, and it may
          // load nothing but what is written into it.
          if (version && method === 'GET') {
            const page = await decks.slidePage(cardId, Number(version), Number(slide));
            if (!page) { deps.json(res, 404, { error: 'no such slide' }); return true; }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; sandbox", 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' });
            res.end(page);
            return true;
          }
          if (action === 'stop' && method === 'POST') { decks.stop(cardId); deps.json(res, 200, { ok: true }); return true; }
          if (action && method === 'POST') {
            if (!chromePath() && !deps.fake) { deps.json(res, 400, { error: NO_CHROME }); return true; }
            if (decks.busy(cardId)) { deps.json(res, 409, { error: 'this deck is already being made' }); return true; }
            const sent = await deps.body(req);
            const stage = await deps.store.loadStage();
            const card = decksOn(stage).find((one) => one.id === cardId)!;
            // The job runs on; its lines and its end arrive on the feed. A failure is written on the card.
            const job = action === 'make'
              ? decks.make(cardId, { brief: String(sent?.brief ?? card.brief ?? '').trim().slice(0, 4000), purpose: purposeOf(sent?.purpose, card.purpose), look: lookOf(sent?.look, card.look) })
              : decks.edit(cardId, String(sent?.notes ?? '').slice(0, 2000), Number(sent?.version) ? { version: Number(sent.version) } : {});
            job.catch(() => {});
            deps.json(res, 202, { ok: true });
            return true;
          }
        } catch (error) { deps.json(res, 400, { error: (error as Error).message }); return true; }
        return false;
      },
      async close() {
        for (const stop of off) stop();
        const at = hub.opening.indexOf(opening);
        if (at >= 0) hub.opening.splice(at, 1);
        await decks.settled();
      },
    };
  },
} satisfies Slice;
