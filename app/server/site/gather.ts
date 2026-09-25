import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { metricsBlock, type Metric } from '../../shared/metrics.ts';
import type { Card, Stage } from '../../shared/model.ts';
import { localDay } from '../clock.ts';
import { projectDir } from '../folder.ts';
import { docsFor, sourcesFor, wiredTo } from '../media/gather.ts';
import { readProject } from '../media/sources.ts';
import type { Material } from './plan.ts';
import type { Gathered, Given } from './store.ts';

// Everything a site may draw on, read fresh for every make the way a film reads its material: the documents, notes and
// project wired to the card or to whoever asked, a Metrics card's block (the only source for a "used by" line), the
// pictures already on the stage, and whether an image studio is wired. Only what the founder wired is read.
export type GatherDeps = {
  workspace: string; root: string;
  loadStage: () => Promise<Stage>;
  readDoc: (id: string) => Promise<string>;
  readFileBytes: (name: string) => Promise<Buffer | null>;
  now?: () => number;
};

// A Metrics card's own block, when one is wired to the site or to whoever asked, read loosely from its sidecar: the
// card is somebody else's, and a site must never fail because a card it only reads from changed its shape.
export async function metricsOf(workspace: string, stage: Stage, cardId: string, roomId: string | undefined, today: string): Promise<Material['metrics']> {
  const near = [...wiredTo(stage, cardId), ...(roomId ? wiredTo(stage, roomId) : [])].filter((card): card is Extract<Card, { kind: 'metrics' }> => card.kind === 'metrics');
  for (const card of near) {
    const raw = await readFile(join(workspace, 'metrics', `${card.id}.json`), 'utf8').catch(() => '');
    if (!raw) continue;
    try {
      const value = JSON.parse(raw) as { metrics?: Metric[] };
      if (Array.isArray(value.metrics) && value.metrics.some((metric) => metric.points?.length)) {
        return { name: 'the Metrics card', text: metricsBlock(card.title, value.metrics, card.period === 'month' ? 'month' : 'week', today) };
      }
    } catch { /* a sidecar that will not parse says nothing */ }
  }
  return undefined;
}

// Where the buttons go: the first web address or email the founder wrote in the brief.
export function linkOf(brief: string): string | undefined {
  const url = /\bhttps?:\/\/[^\s<>"')]+/i.exec(brief)?.[0]?.replace(/[.,;:]+$/, '');
  if (url) return url;
  return /\b[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}\b/i.exec(brief)?.[0];
}

export async function gatherSite(deps: GatherDeps, cardId: string, roomId?: string): Promise<Gathered> {
  const stage = await deps.loadStage();
  const card = (stage.cards ?? []).find((one) => one.id === cardId) as Extract<Card, { kind: 'site' }> | undefined;
  const sources: Material['sources'] = [];
  const using: string[] = [];
  const given: Given[] = [];
  const dress: Gathered['dress'] = {};
  let draws = false;
  for (const one of sourcesFor(stage, cardId, roomId)) {
    try {
      if (one.kind === 'note' && one.text.trim()) { sources.push({ name: 'a note', text: one.text.slice(0, 1600) }); using.push('a note'); }
      else if (one.kind === 'project' && one.path) {
        const product = await readProject(projectDir(one.path, [deps.workspace, deps.root]));
        if (product.words) sources.push({ name: `the ${product.name ?? 'project'} README`, text: product.words.slice(0, 3000) });
        if (product.brand.colours.length || product.brand.font) dress.brand = product.brand;
        if (product.logo && /\.(png|jpe?g|webp|svg)$/i.test(product.logo.name)) dress.logo = product.logo;
        if (product.font && /\.(woff2?|ttf|otf)$/i.test(product.font.name)) dress.font = product.font;
        if (product.name) dress.name = product.name;
        using.push(`${product.name ?? 'the'} project`);
      } else if (one.kind === 'image' && one.path) {
        const bytes = await deps.readFileBytes(one.path);
        if (bytes?.length) { given.push({ bytes, words: 'a picture the founder chose' }); using.push('a picture'); }
      } else if (one.kind === 'imagegen') {
        draws = true;
        using.push('the Image studio');
        // What that studio already drew, newest first, stands in when a drawing cannot be made today.
        const raw = await readFile(join(deps.workspace, 'media', `${one.id}.json`), 'utf8').catch(() => '');
        const results = raw ? ((JSON.parse(raw) as { results?: { path?: string; prompt?: string }[] }).results ?? []) : [];
        for (const result of results.slice(0, 2)) {
          const bytes = result.path && /\.(png|jpe?g|webp)$/i.test(result.path) ? await deps.readFileBytes(result.path) : null;
          if (bytes?.length) given.push({ bytes, words: result.prompt ?? 'a picture from the image studio' });
        }
      }
    } catch { /* a card that cannot be read is left out, and the site is made from the rest */ }
  }
  for (const id of docsFor(stage, cardId, roomId)) {
    const doc = stage.docs.find((one) => one.id === id);
    const words = await deps.readDoc(id).catch(() => '');
    if (doc && words.trim()) { sources.push({ name: doc.title, text: words.slice(0, 2400) }); using.push(doc.title); }
  }
  const metrics = await metricsOf(deps.workspace, stage, cardId, roomId, localDay((deps.now ?? Date.now)()));
  if (metrics) using.push('the Metrics card');
  const brief = card?.brief ?? '';
  const link = linkOf(brief);
  if (link) dress.link = link;
  return { material: { brief, sources, ...(metrics ? { metrics } : {}) }, dress, using, given, draws };
}
