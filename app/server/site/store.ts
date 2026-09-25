import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { EMPTY_SITE, SECTION_NAMES, type Section, type Site, type SiteCheck, type SiteEvent, type SiteLook, type SiteVersion } from '../../shared/site.ts';
import { brightest, holdFor, ratio, sampleOf, washed, WANTS } from '../media/contrast.ts';
import { rgbOf } from '../media/templates/packs.ts';
import { linkOf } from './gather.ts';
import { applyEdits, readNotes } from './notes.ts';
import { mend, rewriteSection, writePlan, type Material, type Think } from './plan.ts';
import { FOLD, foldHero, paletteOf, renderSite, type Dress } from './render.ts';
import { zip } from './zip.ts';

export type Sites = ReturnType<typeof createSites>;
// A picture the founder already has: a picture card's file, or the newest ones a wired image studio drew.
export type Given = { bytes: Buffer; words: string };
// What a site is made from, gathered fresh for every make: the words and numbers, what the page wears, which cards
// were read, the pictures already on the stage, and whether an image studio is wired (which is the founder saying
// "draw what the page needs").
export type Gathered = { material: Material; dress: Omit<Dress, 'look' | 'pictures'>; using: string[]; given: Given[]; draws: boolean };
// A picture made to fit a page: re-encoded small, with its size. Without `sharp` the bytes come back as they were.
export type Fitted = { bytes: Buffer; ext: string; width: number; height: number };
export type SiteDeps = {
  dir: string;
  gather: (cardId: string, roomId?: string) => Promise<Gathered>;
  think?: Think;
  // Draws one picture from a few words, when an image studio is wired and this is not fake mode.
  draw?: (words: string, signal?: AbortSignal) => Promise<Buffer>;
  fit?: (bytes: Buffer, width: number, quality: number) => Promise<Fitted>;
  tell?: (cardId: string, event: SiteEvent) => void;
  now?: () => number;
};
export type MakeAsk = { brief: string; look: SiteLook; roomId?: string; order?: Section['kind'][] };

export const WEIGHT = 500 * 1024;
const KEEP = 12;
const MOST_PICTURES = 3;
const safe = (id: string) => { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`bad id: ${id}`); return id; };
export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'site';
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
export const typeOf = (name: string) => TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

// Every file under a folder, as paths relative to it with forward slashes, deepest last.
async function walk(root: string, at = root): Promise<string[]> {
  const found = await readdir(at, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of found.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(at, entry.name);
    if (entry.isDirectory()) out.push(...await walk(root, full));
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

// One sidecar per Site card and one folder per version, written through a queue and a tmp-rename like the decks, so a
// card read back mid-job tells the truth and a crash never leaves half a file. One job per card at a time.
export function createSites(deps: SiteDeps) {
  const now = deps.now ?? Date.now;
  const home = (cardId: string) => join(deps.dir, 'sites', safe(cardId));
  const sidecar = (cardId: string) => join(home(cardId), 'site.json');
  const folder = (cardId: string, version: number) => join(home(cardId), `v${version}`);
  const cache = new Map<string, Site>();
  const revs = new Map<string, number>();
  const running = new Map<string, AbortController>();
  let queue: Promise<unknown> = Promise.resolve();

  async function read(cardId: string): Promise<Site> {
    const known = cache.get(cardId);
    if (known) return known;
    let site: Site = EMPTY_SITE;
    try { site = { ...EMPTY_SITE, ...JSON.parse(await readFile(sidecar(cardId), 'utf8')) }; } catch { /* nothing made yet */ }
    if (site.state === 'making') site = { ...site, state: 'failed', problem: 'the app was closed', log: [...site.log, 'failed: the app was closed'] };
    cache.set(cardId, site);
    revs.set(cardId, Math.max(revs.get(cardId) ?? 0, now()));
    return site;
  }
  function write(cardId: string, site: Site) {
    cache.set(cardId, site);
    const text = JSON.stringify(site, null, 1);
    queue = queue.then(async () => {
      await mkdir(home(cardId), { recursive: true });
      await writeFile(`${sidecar(cardId)}.tmp`, text);
      await rename(`${sidecar(cardId)}.tmp`, sidecar(cardId));
    }).catch(() => {});
    revs.set(cardId, Math.max((revs.get(cardId) ?? 0) + 1, now()));
    deps.tell?.(cardId, { site, rev: revs.get(cardId)! });
  }

  async function job(cardId: string, work: (line: (text: string) => void, site: Site, signal: AbortSignal) => Promise<SiteVersion>): Promise<SiteVersion> {
    if (running.has(cardId)) throw new Error('this site is already being made');
    const stop = new AbortController();
    running.set(cardId, stop);
    const before = await read(cardId);
    const log: string[] = [];
    const line = (text: string) => { log.push(text); write(cardId, { ...before, state: 'making', problem: undefined, log: [...log] }); };
    try {
      line('starting…');
      const version = await work(line, before, stop.signal);
      if (stop.signal.aborted) throw new Error('stopped');
      const versions = [...before.versions, version].slice(-KEEP);
      // A version that fell off the end takes its folder with it.
      for (const gone of before.versions.filter((one) => !versions.includes(one))) await rm(folder(cardId, gone.version), { recursive: true, force: true }).catch(() => {});
      write(cardId, { state: 'idle', log: [...log, `done · version ${version.version}, ${version.sections.length} sections, ${kb(version.bytes)}`], versions });
      return version;
    } catch (error) {
      const problem = stop.signal.aborted ? 'stopped' : (error as Error).message;
      write(cardId, { ...(await read(cardId)), state: 'failed', problem, log: [...log, `failed: ${problem}`] });
      throw new Error(problem);
    } finally {
      running.delete(cardId);
    }
  }

  const nextNumber = (site: Site) => (site.versions.at(-1)?.version ?? 0) + 1;
  const idsFrom = (sections: Section[]) => {
    let next = sections.reduce((top, section) => Math.max(top, Number(/^x(\d+)$/.exec(section.id)?.[1] ?? 0)), 0);
    return () => `x${++next}`;
  };

  // The pictures of a new version: what the last version already had for a section whose picture ask is unchanged,
  // then a drawing for each section that asks for one (hero first) when an image studio is wired, then the pictures
  // already on the stage, hero first. Each is fitted small. `media` is file name to bytes.
  async function picturesFor(cardId: string, sections: Section[], gathered: Gathered, previous: SiteVersion | undefined, line: (text: string) => void, signal: AbortSignal) {
    const media = new Map<string, Fitted>();
    const wanted = [...sections].sort((a, b) => Number(b.kind === 'hero') - Number(a.kind === 'hero') || Number(b.kind === 'cta') - Number(a.kind === 'cta'));
    const given = [...gathered.given];
    let drew = 0;
    for (const section of wanted) {
      if (media.size >= MOST_PICTURES) break;
      if (!section.picture && !(section.kind === 'hero' && given.length)) continue;
      const before = previous?.sections.find((one) => one.id === section.id);
      if (before?.image && before.picture === section.picture && previous) {
        const bytes = await readFile(join(folder(cardId, previous.version), 'media', before.image)).catch(() => null);
        if (bytes) { media.set(before.image, { bytes, ext: before.image.split('.').pop()!, width: 0, height: 0 }); section.image = before.image; continue; }
      }
      let raw: Buffer | null = null;
      if (gathered.draws && deps.draw && section.picture) {
        line(`drawing the ${SECTION_NAMES[section.kind].toLowerCase()} picture: ${section.picture}…`);
        raw = await deps.draw(section.picture, signal).catch((error: Error) => { line(`the picture could not be drawn: ${error.message.split('\n')[0].slice(0, 140)}`); return null; });
        if (raw) drew += 1;
      }
      if (!raw && given.length && (section.kind === 'hero' || section.kind === 'cta')) {
        const one = given.shift()!;
        raw = one.bytes;
        if (!section.picture) section.picture = one.words;
      }
      if (!raw) { delete section.image; continue; }
      const fitted = deps.fit ? await deps.fit(raw, section.kind === 'hero' ? 1400 : 1600, 72).catch(() => null) : null;
      const picture = fitted ?? { bytes: raw, ext: raw[0] === 0x89 ? 'png' : 'jpg', width: 1200, height: 900 };
      const name = `${section.kind}-${section.id}.${picture.ext}`;
      media.set(name, picture);
      section.image = name;
    }
    if (drew) line(`drew ${drew} picture${drew === 1 ? '' : 's'}`);
    for (const section of sections) if (section.image && !media.has(section.image)) delete section.image;
    return media;
  }

  // One version written to its folder and checked. Over the weight, the pictures are made smaller once, then dropped
  // from the last section up, and the page written again, until it fits. Every rule is measured on what was written.
  async function publish(cardId: string, number: number, title: string, sections: Section[], look: SiteLook, gathered: Gathered, media: Map<string, Fitted>, cut: number, line: (text: string) => void) {
    const at = folder(cardId, number);
    const said: string[] = [];
    const { palette } = paletteOf(look, gathered.dress.brand);
    let squeezed = false;
    for (;;) {
      await rm(at, { recursive: true, force: true });
      await mkdir(join(at, 'media'), { recursive: true });
      const pictures: Dress['pictures'] = {};
      let over: { ratio: number; hold: number } | null = null;
      for (const section of sections) {
        const picture = section.image ? media.get(section.image) : undefined;
        if (!section.image || !picture) continue;
        const file = join(at, 'media', section.image);
        await writeFile(file, picture.bytes);
        let hold: number | undefined;
        // The closing band sets its words over its picture, with a wash of the page's own ground held just hard enough.
        if (section.kind === 'cta') {
          const pixels = await sampleOf(file, { x: 0.1, y: 0.2, w: 0.8, h: 0.6 });
          const under = pixels?.length ? brightest(pixels) : (rgbOf(palette.ink) ?? [255, 255, 255]);
          hold = Math.max(holdFor(under, palette.quiet, palette.ground), holdFor(under, palette.ink, palette.ground));
          const reads = ratio(rgbOf(palette.quiet)!, washed(under, rgbOf(palette.ground)!, hold));
          over = { ratio: Math.round(reads * 100) / 100, hold };
        }
        pictures[section.id] = { file: section.image, width: picture.width || 1200, height: picture.height || 900, ...(hold !== undefined ? { hold } : {}) };
      }
      const page = await renderSite(title, sections, { ...gathered.dress, look, pictures, year: new Date(now()).getFullYear() });
      await writeFile(join(at, 'index.html'), page.html);
      await writeFile(join(at, 'style.css'), page.css);
      for (const file of page.files) await writeFile(join(at, 'media', file.name), file.bytes);
      const files = await walk(at);
      let bytes = 0;
      for (const file of files) bytes += (await stat(join(at, file))).size;
      if (bytes > WEIGHT && media.size) {
        if (!squeezed && deps.fit) {
          squeezed = true;
          for (const [name, picture] of media) {
            const smaller = await deps.fit(picture.bytes, 960, 58).catch(() => null);
            if (smaller) media.set(name, { ...smaller, ext: picture.ext === smaller.ext ? picture.ext : smaller.ext });
          }
          said.push(`the pictures were made smaller to keep the page under ${kb(WEIGHT)}`);
          continue;
        }
        const last = [...sections].reverse().find((section) => section.image);
        if (last) {
          media.delete(last.image!);
          said.push(`left the ${SECTION_NAMES[last.kind].toLowerCase()} picture out to keep the page under ${kb(WEIGHT)}`);
          delete last.image;
          continue;
        }
      }
      said.push(...page.said);
      const h1 = (page.html.match(/<h1[\s>]/g) ?? []).length;
      const hero = sections.find((section) => section.kind === 'hero');
      const bottom = hero ? foldHero(hero, look).bottom : Infinity;
      const contrastOk = page.lowest >= WANTS && (!over || over.ratio >= WANTS);
      const checks: SiteCheck[] = [
        { rule: 'one-h1', ok: h1 === 1, said: h1 === 1 ? 'one H1, the hero headline' : `${h1} H1s on the page` },
        { rule: 'cta-fold', ok: bottom <= FOLD, said: bottom <= FOLD ? `the button ends at ${bottom} px of ${FOLD} on a 390 px phone` : `the button ends at ${bottom} px, below the ${FOLD} px fold` },
        { rule: 'contrast', ok: contrastOk, said: `the lowest text contrast is ${page.lowest.toFixed(2)}:1${over ? `; over the closing picture ${over.ratio.toFixed(2)}:1 with a ${Math.round(over.hold * 100)}% wash` : ''}` },
        { rule: 'weight', ok: bytes <= WEIGHT, said: `${kb(bytes)} in ${files.length} files` },
        { rule: 'claims', ok: true, said: cut ? `cut ${cut} claim${cut === 1 ? '' : 's'} no wired doc or Metrics card states` : 'every number and claim is traced to what is wired' },
      ];
      line(`checked: ${checks.filter((check) => check.ok).length} of ${checks.length} rules hold · ${kb(bytes)}`);
      return { checks, bytes, files, said };
    }
  }

  const linkSaid = (gathered: Gathered) => (gathered.dress.link ? [] : ['the buttons go to the closing section until the brief names a link or an email for them']);

  return {
    read,
    settled: () => queue,
    event: async (cardId: string): Promise<SiteEvent> => { const site = await read(cardId); return { site, rev: revs.get(cardId)! }; },
    busy: (cardId: string) => running.has(cardId),
    stop(cardId: string) { running.get(cardId)?.abort(); },

    make(cardId: string, ask: MakeAsk): Promise<SiteVersion> {
      return job(cardId, async (line, before, signal) => {
        line('reading what is wired to the site…');
        const gathered = await deps.gather(cardId, ask.roomId);
        gathered.material = { ...gathered.material, brief: ask.brief };
        const link = linkOf(ask.brief);
        if (link) gathered.dress = { ...gathered.dress, link };
        if (gathered.using.length) line(`using ${gathered.using.join(', ')}`);
        if (!gathered.material.metrics) line('no Metrics card is wired, so the page makes no usage claims');
        const ids = idsFrom([]);
        const planned = await writePlan({ brief: ask.brief, material: gathered.material, think: deps.think, ids, now: now(), order: ask.order, report: line, signal });
        const folded = foldHero(planned.sections[0], ask.look);
        const sections = [folded.hero, ...planned.sections.slice(1)];
        const said = [...planned.said, ...folded.said];
        for (const one of said) line(one);
        const media = await picturesFor(cardId, sections, gathered, undefined, line, signal);
        const number = nextNumber(before);
        line(`writing version ${number}…`);
        const done = await publish(cardId, number, planned.title, sections, ask.look, gathered, media, planned.cut, line);
        return {
          version: number, at: now(), title: planned.title, sections, look: ask.look, brief: ask.brief,
          said: [...said, ...done.said, ...linkSaid(gathered)], checks: done.checks, bytes: done.bytes, files: done.files,
        };
      });
    },

    // Notes on one version: only the sections they touch are made again, as the next version beside it.
    edit(cardId: string, notes: string, opts: { version?: number; roomId?: string } = {}): Promise<SiteVersion> {
      return job(cardId, async (line, before, signal) => {
        const base = opts.version ? before.versions.find((one) => one.version === opts.version) : before.versions.at(-1);
        if (!base) throw new Error(opts.version ? `there is no version ${opts.version} of this site` : 'there is no site to edit yet: make one first');
        const notesRead = readNotes(notes, base.sections);
        for (const one of notesRead.unread) line(`I could not read: ${one}`);
        if (!notesRead.edits.length) throw new Error(notesRead.unread.length ? 'none of the notes named a section to change' : 'the notes are empty');
        const gathered = await deps.gather(cardId, opts.roomId);
        gathered.material = { ...gathered.material, brief: base.brief ?? gathered.material.brief };
        const plain = applyEdits(base.sections, notesRead.edits);
        const said = [...plain.said];
        let sections = plain.sections;
        const touched = new Set(plain.touched);
        for (const edit of notesRead.edits) {
          if (edit.kind !== 'rewrite') continue;
          const at = sections.findIndex((section) => section.id === edit.id);
          if (at < 0) continue;
          const name = SECTION_NAMES[sections[at].kind].toLowerCase();
          line(`rewriting the ${name}…`);
          const rewritten = await rewriteSection(sections[at], edit.ask, { material: gathered.material, think: deps.think, now: now(), signal });
          if (!rewritten.done) { said.push(`the ${name} needs a model to rewrite it ("${edit.ask}"), so it is as it was`); continue; }
          sections[at] = rewritten.section;
          touched.add(edit.id);
          said.push(`rewrote the ${name}`);
        }
        // The rules again, over the sections the notes touched; a kept section is kept exactly as it was.
        const whole = mend(sections, gathered.material, idsFrom(sections));
        const kept = new Map(sections.map((section) => [section.id, section]));
        sections = whole.sections.map((section) => (touched.has(section.id) || !kept.has(section.id) ? section : kept.get(section.id)!));
        // What the rules changed, said only for the sections the notes touched and for the page as a whole.
        const touchedNames = [...touched].map((id) => kept.get(id)?.kind).filter(Boolean).map((kind) => `${SECTION_NAMES[kind!].toLowerCase()} (section`);
        const mended = whole.said.filter((one) => !/^[a-z ]+ \(section \d+\)/.test(one) || touchedNames.some((name) => one.startsWith(name)));
        const heroAt = sections.findIndex((section) => section.kind === 'hero');
        if (heroAt >= 0 && touched.has(sections[heroAt].id)) {
          const folded = foldHero(sections[heroAt], base.look);
          sections[heroAt] = folded.hero;
          mended.push(...folded.said);
        }
        const unchanged = sections.filter((section) => !touched.has(section.id)).length;
        said.push(`kept ${unchanged} of ${sections.length} sections as they were`);
        for (const one of [...said, ...mended]) line(one);
        const media = await picturesFor(cardId, sections, gathered, base, line, signal);
        const number = nextNumber(before);
        line(`writing version ${number}…`);
        const cut = mended.filter((one) => /: cut "|cut a figure|took a number/.test(one)).length;
        const done = await publish(cardId, number, base.title, sections, base.look, gathered, media, cut, line);
        return {
          version: number, at: now(), title: base.title, sections, look: base.look, notes, from: base.version, ...(base.brief ? { brief: base.brief } : {}),
          said: [...said, ...mended, ...done.said, ...notesRead.unread.map((one) => `I could not read: ${one}`)], checks: done.checks, bytes: done.bytes, files: done.files,
        };
      });
    },

    // One file of one version, for the previews and the browser card, or null. The path is checked hard.
    async file(cardId: string, version: number, path: string): Promise<{ bytes: Buffer; type: string } | null> {
      const site = await read(cardId);
      if (!site.versions.some((one) => one.version === version)) return null;
      const root = resolve(folder(cardId, version));
      if (!/^(index\.html|style\.css|media\/[A-Za-z0-9][A-Za-z0-9._-]{0,80})$/.test(path)) return null;
      const full = resolve(root, path);
      if (!full.startsWith(root + sep)) return null;
      const bytes = await readFile(full).catch(() => null);
      return bytes ? { bytes, type: typeOf(path) } : null;
    },

    // The version's folder as one zip, inside a folder named for the site, so it unpacks tidily.
    async zipOf(cardId: string, version: number): Promise<{ name: string; bytes: Buffer } | null> {
      const site = await read(cardId);
      const one = site.versions.find((candidate) => candidate.version === version);
      if (!one) return null;
      const root = folder(cardId, version);
      const stem = `${slug(one.title)}-v${version}`;
      const entries = await Promise.all((await walk(root)).map(async (path) => ({ name: `${stem}/${path}`, bytes: await readFile(join(root, path)), at: one.at })));
      return { name: `${stem}.zip`, bytes: zip(entries) };
    },
    folderOf: folder,
  };
}

export const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
