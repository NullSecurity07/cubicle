import { isHeaded, type Card, type Stage } from '../../shared/model.ts';
import { CHECK_NAMES, isSectionKind, isSiteLook, SITE_LOOK_NAMES, siteChannel, type SiteEvent, type SiteLook } from '../../shared/site.ts';
import { fakeRunner, realRunner, type Runner } from '../browser.ts';
import { shortDay } from '../clock.ts';
import { hub } from '../events.ts';
import type { Deps, Slice } from '../install.ts';
import { firstOf, imageMakers } from '../media/image.ts';
import { lettered } from '../media/lettering.ts';
import { wired } from '../prompt.ts';
import { complete, promptSize } from '../providers.ts';
import { route as routeModels } from '../router.ts';
import type { Handler } from '../seams.ts';
import { gatherSite } from '../site/gather.ts';
import { outlineOf, type Think } from '../site/plan.ts';
import { createSites, kb, type Fitted, type Sites } from '../site/store.ts';
import { text, type Tool, type ToolContext } from '../tools/registry.ts';
import { browserSession } from '../tools/web.ts';

// The Site studio card: a brief and what is wired to it become a one-page website in our own HTML and CSS, looked at
// side by side at a laptop's width and a phone's, and handed over as a folder (or a zip of it). Nothing is hosted.
// Notes remake only the sections they touch, as the next version beside the last. Nothing leaves the machine but the
// one plan call to the founder's own models and, when an image studio is wired, the pictures it draws.

export const SITE_TOOLS = ['make_site', 'edit_site', 'read_site'];
export const NO_CARD = 'no Site card is connected to your room. The founder adds one from the dock and draws a wire to it.';
const HINT = '- A Site card: a one-page website made from a brief and what is wired to it, as a folder of HTML and CSS. make_site makes a new version, '
  + 'edit_site({ notes }) remakes only the sections the notes touch ("shorter hero", "drop pricing", "move proof after hero", "button: Book a demo"), read_site reads it section by section with what the critic checked.';

type SiteCard = Extract<Card, { kind: 'site' }>;
const sitesOn = (stage: Stage) => (stage.cards ?? []).filter((card): card is SiteCard => card.kind === 'site');
const cardOf = (context: ToolContext) => {
  const id = wired(context.stage, context.roomId, sitesOn(context.stage).map((card) => card.id))[0];
  if (!id) throw new Error(NO_CARD);
  return sitesOn(context.stage).find((card) => card.id === id)!;
};
const lookOf = (asked: unknown, card?: SiteLook): SiteLook => (isSiteLook(asked) ? asked : card ?? 'clean');
const orderOf = (card: SiteCard) => (card.sections ?? []).filter(isSectionKind);

export function siteTools(sites: Sites): Tool[] {
  const wait = (context: ToolContext) => context.signal?.addEventListener('abort', () => sites.stop(cardOf(context).id), { once: true });
  const checked = (version: { checks: { rule: keyof typeof CHECK_NAMES; ok: boolean; said: string }[] }) => version.checks.map((check) => `${check.ok ? 'ok' : 'NOT MET'} · ${CHECK_NAMES[check.rule]}: ${check.said}`).join('\n');
  return [
    {
      name: 'make_site', perTurn: 1,
      description: 'Make a new version of the one-page website on the Site card wired to you, from a brief and what is wired to the card. Takes under a minute.',
      parameters: { type: 'object', properties: {
        brief: { type: 'string', description: 'What the site is for, for whom, and where its button goes (a link or an email). Left out, the card\'s own brief' },
        look: { type: 'string', enum: ['clean', 'editorial', 'brand'] },
      } },
      async run(args, context) {
        const card = cardOf(context);
        const brief = typeof args.brief === 'string' && args.brief.trim() ? args.brief.trim().slice(0, 4000) : card.brief?.trim() ?? '';
        wait(context);
        const made = await sites.make(card.id, { brief, look: lookOf(args.look, card.look), roomId: context.roomId, order: orderOf(card) });
        return { text: `Site version ${made.version}, ${made.sections.length} sections, ${kb(made.bytes)}.\n${outlineOf(made.sections).join('\n')}\nThe critic:\n${checked(made)}${made.said?.length ? `\nChanged: ${made.said.join('; ')}.` : ''}` };
      },
    },
    {
      name: 'edit_site', perTurn: 2,
      description: 'Notes on the site: only the sections they touch are made again, as the next version. "shorter hero", "drop pricing", "move proof after hero", "hero headline: …", "button: Book a demo", "faq: add one on data".',
      parameters: { type: 'object', properties: { notes: { type: 'string' }, version: { type: 'number', description: 'Which version the notes are on. Left out, the newest' } }, required: ['notes'] },
      async run(args, context) {
        const card = cardOf(context);
        wait(context);
        const made = await sites.edit(card.id, text(args, 'notes', 2000), { ...(Number(args.version) ? { version: Number(args.version) } : {}), roomId: context.roomId });
        return { text: `Version ${made.version}: ${made.said?.join('; ')}.\n${outlineOf(made.sections).join('\n')}\nThe critic:\n${checked(made)}` };
      },
    },
    {
      name: 'read_site', perTurn: 3,
      description: 'Read the website on the Site card wired to you, section by section, with where each number came from and what the critic checked.',
      parameters: { type: 'object', properties: { version: { type: 'number', description: 'Left out, the newest' } } },
      async run(args, context) {
        const site = await sites.read(cardOf(context).id);
        const one = Number(args.version) ? site.versions.find((candidate) => candidate.version === Number(args.version)) : site.versions.at(-1);
        if (!one) return { text: 'The Site card has no site yet. make_site makes one.' };
        return { text: `"${one.title}", version ${one.version} of ${site.versions.length}, ${SITE_LOOK_NAMES[one.look]} look, made ${shortDay(one.at)}${one.notes ? ` from the notes "${one.notes}"` : ''}, ${kb(one.bytes)}.\n${outlineOf(one.sections).join('\n')}\nThe critic:\n${checked(one)}` };
      },
    },
  ];
}

// A picture fitted to a page: no wider than it needs, as WebP. `sharp` is asked for when needed, so a machine without
// it keeps the page and loses only the squeeze.
async function fit(bytes: Buffer, width: number, quality: number): Promise<Fitted> {
  const { default: sharp } = await import('sharp');
  const { data, info } = await sharp(bytes).rotate().resize({ width, withoutEnlargement: true }).webp({ quality }).toBuffer({ resolveWithObject: true });
  return { bytes: data, ext: 'webp', width: info.width, height: info.height };
}

// What a version's files are served with: our own markup and nothing else. No script may run, nothing may be fetched
// from anywhere but the folder itself, and only the app's own page may frame it.
const FILE_POLICY = "default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export default {
  name: 'site',
  install(deps) {
    const say = (cardId: string, event: SiteEvent) => hub.say(siteChannel(cardId), event);
    // The one plan call: the roomiest model that is ready, counted like everything else. Fake mode has none.
    const think: Think | undefined = deps.fake ? undefined : async (prompt, signal) => {
      const messages = [{ role: 'user' as const, content: prompt }];
      const { order } = routeModels(deps.clients, deps.usage, { promptChars: promptSize(messages), tools: false });
      const reply = await complete(messages, { onToken: () => {}, signal }, order);
      deps.usage.record(reply.client.name, reply.usage, reply.quota);
      return reply.text;
    };
    // The Image studio's own makers, wordless, tried in order, built the first time a site asks. Never in fake mode.
    let pictures: ReturnType<typeof firstOf> | null = null;
    const draw = deps.fake ? undefined : async (words: string, signal?: AbortSignal) => {
      pictures ??= firstOf(imageMakers().map(lettered));
      const why = pictures.ready();
      if (why) throw new Error(why);
      return (await pictures.make({ prompt: `${words}, editorial photograph, natural light`, shape: 'wide' }, { report: () => {}, signal })).bytes;
    };
    const sites = createSites({
      dir: deps.workspace, think, draw, fit, tell: say,
      gather: (cardId, roomId) => gatherSite({ workspace: deps.workspace, root: deps.root, loadStage: () => deps.store.loadStage(), readDoc: (id) => deps.store.readDoc(id), readFileBytes: (name) => deps.store.readFileBytes(name) }, cardId, roomId),
    });
    // The browser a Site card opens its page in is the browser card's own session, driven the way a person's step is.
    let runner: Runner | null = null;
    const run: Runner = (session, args, launch) => (runner ??= deps.fake ? fakeRunner : realRunner())(session, args, launch);
    const onStage = async () => sitesOn(await deps.store.loadStage()).map((card) => card.id);

    const opening = async () => Promise.all((await onStage()).map(async (id) => ({ channel: siteChannel(id), data: await sites.event(id) })));
    hub.opening.push(opening);

    // A person wired to a Site card reads one line on what it is for, and the newest version in a few lines, dated.
    const before: Handler<'turn:before'> = async (payload, next) => {
      const [system, ...rest] = payload.messages;
      if (system?.role !== 'system') return next(payload);
      const stage = await deps.store.loadStage().catch(() => null);
      const mine = stage ? wired(stage, payload.roomId, sitesOn(stage).map((card) => card.id)) : [];
      if (!mine.length) return next(payload);
      const site = await sites.read(mine[0]).catch(() => null);
      const newest = site?.versions.at(-1);
      const block = newest
        ? `\n  The site now: "${newest.title}", version ${newest.version}, ${newest.sections.length} sections, ${newest.checks.filter((check) => check.ok).length} of ${newest.checks.length} critic rules hold, made ${shortDay(newest.at)}. ${outlineOf(newest.sections).map((line) => line.replace(/ · .*$/, '')).join(' | ')}`.slice(0, 900)
        : '\n  No site made yet.';
      return next({ ...payload, messages: [{ ...system, content: `${system.content}\n\n${HINT}${block}` }, ...rest] });
    };
    const off = deps.seams ? [deps.seams.on('turn:before', before)] : [];

    return {
      tools: siteTools(sites),
      offer(tools, stage, roomId) {
        if (wired(stage, roomId, sitesOn(stage).map((card) => card.id)).length) return tools;
        return tools.filter((tool) => !SITE_TOOLS.includes(tool.name));
      },
      async route(req, res, path) {
        const asked = /^\/api\/sites\/([a-z0-9][a-z0-9-]{0,63})(?:\/(make|edit|stop|serve)|\/v\/(\d{1,4})\/(zip|index\.html|style\.css|media\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}))?$/.exec(path);
        if (!asked) return false;
        const [, cardId, action, version, file] = asked;
        const method = req.method ?? 'GET';
        if (!(await onStage()).includes(cardId)) { deps.json(res, 404, { error: 'there is no Site card by that name' }); return true; }
        try {
          if (!action && !version && method === 'GET') { deps.json(res, 200, await sites.event(cardId)); return true; }
          if (file === 'zip' && method === 'GET') {
            const packed = await sites.zipOf(cardId, Number(version));
            if (!packed) { deps.json(res, 404, { error: 'no such version' }); return true; }
            res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${packed.name}"`, 'content-length': packed.bytes.length, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
            res.end(packed.bytes);
            return true;
          }
          if (file && method === 'GET') {
            const found = await sites.file(cardId, Number(version), file);
            if (!found) { deps.json(res, 404, { error: 'no such file' }); return true; }
            res.writeHead(200, { 'content-type': found.type, 'content-security-policy': FILE_POLICY, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' });
            res.end(found.bytes);
            return true;
          }
          if (action === 'stop' && method === 'POST') { sites.stop(cardId); deps.json(res, 200, { ok: true }); return true; }
          // "Serve locally": the version's own page, opened in a browser card on the stage. The address is this app's,
          // on this machine, and only ever a Site card's folder; it is never a path a person can steer.
          if (action === 'serve' && method === 'POST') {
            const sent = await deps.body(req);
            const stage = await deps.store.loadStage();
            const browser = (stage.cards ?? []).find((one) => one.id === String(sent?.browserId ?? '') && one.kind === 'browser');
            if (!browser || browser.kind !== 'browser' || browser.app) { deps.json(res, 400, { error: 'open it in a plain browser card' }); return true; }
            const site = await sites.read(cardId);
            const one = Number(sent?.version) ? site.versions.find((candidate) => candidate.version === Number(sent.version)) : site.versions.at(-1);
            if (!one) { deps.json(res, 400, { error: 'there is no site to open yet' }); return true; }
            const host = /^(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(String(req.headers.host ?? '')) ? String(req.headers.host) : `127.0.0.1:${deps.own.ports[0]}`;
            const url = `http://${host}/api/sites/${cardId}/v/${one.version}/index.html`;
            await run(browserSession(browser.id), ['open', url], { profile: deps.store.browserProfile(browser.id), headed: isHeaded(browser) });
            deps.json(res, 200, { url });
            return true;
          }
          if (action && method === 'POST') {
            if (sites.busy(cardId)) { deps.json(res, 409, { error: 'this site is already being made' }); return true; }
            const sent = await deps.body(req);
            const stage = await deps.store.loadStage();
            const card = sitesOn(stage).find((one) => one.id === cardId)!;
            // The job runs on; its lines and its end arrive on the feed. A failure is written on the card.
            const job = action === 'make'
              ? sites.make(cardId, { brief: String(sent?.brief ?? card.brief ?? '').trim().slice(0, 4000), look: lookOf(sent?.look, card.look), order: orderOf(card) })
              : sites.edit(cardId, String(sent?.notes ?? '').slice(0, 2000), Number(sent?.version) ? { version: Number(sent.version) } : {});
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
        await sites.settled();
      },
    };
  },
} satisfies Slice;
