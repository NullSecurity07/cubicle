import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SiteEvent } from '../../shared/site.ts';
import { createSites, WEIGHT, type Gathered } from './store.ts';

const nothing = (extra: Partial<Gathered> = {}): Gathered => ({ material: { brief: '', sources: [] }, dress: {}, using: [], given: [], draws: false, ...extra });
async function setup(gathered: Partial<Gathered> = {}, more: Partial<Parameters<typeof createSites>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sites-'));
  const heard: SiteEvent[] = [];
  const sites = createSites({ dir, gather: async () => nothing(gathered), tell: (_id, event) => heard.push(event), now: () => Date.UTC(2026, 8, 25), ...more });
  return { dir, sites, heard };
}

describe('the site store', () => {
  it('makes a version into its own folder and checks it against every rule', async () => {
    const { dir, sites, heard } = await setup();
    const made = await sites.make('site-1', { brief: 'Relay helps agencies bill on time', look: 'clean' });
    expect(made.version).toBe(1);
    expect(made.files).toEqual(['index.html', 'media/sans.woff2', 'style.css']);
    expect(made.checks.map((check) => [check.rule, check.ok])).toEqual([['one-h1', true], ['cta-fold', true], ['contrast', true], ['weight', true], ['claims', true]]);
    expect(made.checks[4].said).toMatch(/cut 1 claim/);
    expect(made.bytes).toBeLessThan(WEIGHT);
    expect(await readFile(join(dir, 'sites/site-1/v1/index.html'), 'utf8')).toContain('<h1>Relay helps agencies bill on time</h1>');
    await sites.settled();
    expect(JSON.parse(await readFile(join(dir, 'sites/site-1/site.json'), 'utf8')).versions).toHaveLength(1);
    expect(heard.at(-1)!.site.state).toBe('idle');
    expect(heard.some((event) => event.site.state === 'making')).toBe(true);
    expect(made.said).toContain('the buttons go to the closing section until the brief names a link or an email for them');
  });

  it('remakes only the sections the notes touch, as the next version', async () => {
    const { sites } = await setup();
    const first = await sites.make('site-1', { brief: 'Relay helps small agencies bill on time', look: 'editorial' });
    const second = await sites.edit('site-1', 'shorter hero');
    expect(second.version).toBe(2);
    expect(second.from).toBe(1);
    expect(second.sections[0].headline.length).toBeLessThan(first.sections[0].headline.length);
    expect(second.sections.slice(1)).toEqual(first.sections.slice(1));
    expect(second.said).toContain('kept 4 of 5 sections as they were');
    expect((await sites.read('site-1')).versions.map((one) => one.version)).toEqual([1, 2]);
    await expect(sites.edit('site-1', 'make it pop')).rejects.toThrow('none of the notes named a section');
  });

  it('serves only its own files, and zips the folder', async () => {
    const { sites } = await setup();
    await sites.make('site-1', { brief: 'Relay. hello@relay.app', look: 'clean' });
    expect((await sites.file('site-1', 1, 'index.html'))!.type).toMatch(/text\/html/);
    expect((await sites.file('site-1', 1, 'index.html'))!.bytes.toString()).toContain('mailto:hello@relay.app');
    expect(await sites.file('site-1', 1, '../site.json')).toBeNull();
    expect(await sites.file('site-1', 1, 'media/../../site.json')).toBeNull();
    expect(await sites.file('site-1', 2, 'index.html')).toBeNull();
    const packed = (await sites.zipOf('site-1', 1))!;
    expect(packed.name).toBe('relay-v1.zip');
    expect(packed.bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(packed.bytes.includes(Buffer.from('relay-v1/media/sans.woff2'))).toBe(true);
  });

  it('draws the pictures an image studio is wired for, and keeps the page under its weight', async () => {
    const drawn: string[] = [];
    const big = Buffer.alloc(420 * 1024, 7);
    const { dir, sites } = await setup({ draws: true }, {
      draw: async (words) => { drawn.push(words); return big; },
      // A stand-in for sharp: the first fit is still heavy, the squeeze makes it light.
      fit: async (_bytes, width) => ({ bytes: Buffer.alloc(width > 1000 ? 480 * 1024 : 40 * 1024, 1), ext: 'webp', width, height: Math.round(width * 0.6) }),
    });
    const made = await sites.make('site-1', { brief: 'Relay', look: 'clean' });
    expect(drawn).toEqual(['a tidy desk by a window in morning light']);
    expect(made.sections[0].image).toBe('hero-x1.webp');
    expect(made.said).toContain('the pictures were made smaller to keep the page under 500 KB');
    expect(made.checks.find((check) => check.rule === 'weight')!.ok).toBe(true);
    expect((await stat(join(dir, 'sites/site-1/v1/media/hero-x1.webp'))).size).toBe(40 * 1024);
    expect(await readFile(join(dir, 'sites/site-1/v1/index.html'), 'utf8')).toContain('src="media/hero-x1.webp"');
    // Notes that do not touch the hero keep its picture without drawing it again.
    await sites.edit('site-1', 'drop faq');
    expect(drawn).toHaveLength(1);
    expect((await sites.read('site-1')).versions[1].sections[0].image).toBe('hero-x1.webp');
  });

  it('writes a failure down in words', async () => {
    const { sites } = await setup();
    await expect(sites.edit('site-1', 'shorter hero')).rejects.toThrow('there is no site to edit yet');
    expect((await sites.read('site-1')).state).toBe('failed');
  });
});
