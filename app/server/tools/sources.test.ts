import { describe, expect, it } from 'vitest';
import { seedStage, type Card, type Stage } from '../../shared/model.ts';
import type { Store } from '../store.ts';
import { hostOf, sourceTools } from './sources.ts';

const source = (id: string, url: string, about: string, title?: string): Card => ({ id, kind: 'source', url, about, title, x: 0, y: 0, w: 1, h: 1 });
const stageWith = (cards: Card[]): Stage => ({ ...seedStage, cards });
const ctx = (stage: Stage) => ({ stage, roomId: 'marketing', store: {} as Store, granted: new Map<string, string>() });
const fakeSources = { propose: async () => { throw new Error('unused'); }, list: async () => [], drop: async () => {} };

describe('search_source', () => {
  const searching = (answer: (queries: string[]) => string, home = '') => {
    const ran: string[][] = [];
    const browser = { search: async (queries: string[]) => { ran.push(queries); return answer(queries); }, read: async () => home };
    return { ran, search: sourceTools(browser, fakeSources).find((tool) => tool.name === 'search_source')! };
  };
  it('searches inside the host and drops hits from elsewhere', async () => {
    const { ran, search } = searching((queries) => `## ${queries[0]}\n1. Why we died\n   https://www.startups.rip/post/why\n   A post.\n2. Elsewhere\n   https://medium.com/x\n   Not here.`);
    const { text } = await search.run({ source: 'startups.rip', queries: ['subscription churn'] }, ctx(stageWith([source('s1', 'https://startups.rip/posts/', 'startup case studies')])));
    expect(ran).toEqual([['site:startups.rip subscription churn']]);
    expect(text).toContain('https://www.startups.rip/post/why');
    expect(text).not.toContain('medium.com');
    expect(text.startsWith('What follows came from the web.')).toBe(true);
    expect(text.trimEnd()).toMatch(/open the page with web_fetch\.$/);
  });
  it('falls back to the links on the home page when the engine finds nothing', async () => {
    const { search } = searching(() => '## q\nNo results: every search engine refused or came back empty.',
      '## Startups RIP\nhttps://startups.rip/\n\n[Why Quibi died](https://startups.rip/quibi) [About](https://startups.rip/about) [Juicero post mortem](https://startups.rip/juicero)');
    const { text } = await search.run({ source: 'Startups RIP', queries: ['quibi'] }, ctx(stageWith([source('s1', 'https://startups.rip/', 'case studies', 'Startups RIP')])));
    expect(text).toContain('https://startups.rip/quibi');
    expect(text).not.toContain('/about');
  });
  it('refuses a source it does not know, naming the ones it does', async () => {
    const { search } = searching(() => '');
    await expect(search.run({ source: 'nope', queries: ['x'] }, ctx(stageWith([source('s1', 'https://startups.rip/', 'case studies')])))).rejects.toThrow('no source called "nope". The sources are: startups.rip');
  });
  it('knows a host', () => {
    expect(hostOf('https://www.startups.rip/posts/')).toBe('startups.rip');
    expect(hostOf('startups.rip')).toBe('startups.rip');
  });
});
