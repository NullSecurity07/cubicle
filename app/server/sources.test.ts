import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSources, sourceAttention } from './sources.ts';

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sources-')); });

describe('proposed sources', () => {
  it('keeps one proposal per host, and drops it', async () => {
    const sources = createSources(dir, () => 5);
    const first = await sources.propose({ url: 'https://startups.rip/', about: 'case studies', why: 'it had the answer', by: 'Maya' }, []);
    const again = await sources.propose({ url: 'https://www.startups.rip/posts', about: 'x', why: 'y', by: 'Dev' }, []);
    expect(again.id).toBe(first.id);
    expect(await sources.list()).toHaveLength(1);
    await expect(sources.propose({ url: 'https://indiehackers.com/', about: 'a', why: 'b', by: 'Maya' }, ['indiehackers.com'])).rejects.toThrow('already a source');
    await sources.drop(first.id);
    expect(await sources.list()).toEqual([]);
    expect((await sourceAttention(createSources(dir))())).toEqual([]);
  });
  it('shows a proposal as something that needs the founder', async () => {
    const sources = createSources(dir, () => 7);
    const one = await sources.propose({ url: 'https://startups.rip/', about: 'case studies', why: 'it had the answer', by: 'Maya' }, []);
    expect(await sourceAttention(sources)()).toEqual([{ id: `proposed-source:${one.id}`, kind: 'proposed-source', title: 'startups.rip', detail: 'case studies. it had the answer', who: 'Maya', at: 7, sourceId: one.id, url: 'https://startups.rip/', about: 'case studies' }]);
  });
  it('tells whoever watches when the list changes', async () => {
    const sources = createSources(dir, () => 1);
    let told = 0;
    sources.onChange(() => { told += 1; });
    const one = await sources.propose({ url: 'https://startups.rip/', about: 'a', why: 'b', by: 'Maya' }, []);
    await sources.drop(one.id);
    expect(told).toBe(2);
  });
});
