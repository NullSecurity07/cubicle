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
    const sessions: (string | undefined)[] = [];
    const browser = {
      search: async (queries: string[], _recent?: string, session?: string) => { ran.push(queries); sessions.push(session); return answer(queries); },
      read: async (_urls: string[], session?: string) => { sessions.push(session); return home; },
    };
    return { ran, sessions, search: sourceTools(browser, fakeSources).find((tool) => tool.name === 'search_source')! };
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
  it('runs in the source card\'s own session and tells its card to show it', async () => {
    const { sessions, search } = searching(() => '## q\nNo results: every search engine refused or came back empty.', '## Home\nhttps://startups.rip/');
    const { effect } = await search.run({ source: 'startups.rip', queries: ['quibi'] }, ctx(stageWith([source('s1', 'https://startups.rip/', 'case studies')])));
    expect(sessions).toEqual(['card-s1', 'card-s1']);
    expect(effect).toEqual({ kind: 'browser-moved', id: 's1' });
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

describe('propose_source', () => {
  it('refuses this machine, caps the description, and says where it went', async () => {
    const proposed: unknown[] = [];
    const sources = { ...fakeSources, propose: async (input: unknown) => { proposed.push(input); return { id: 'p1', at: 1, ...(input as object) } as never; } };
    const propose = sourceTools({ search: async () => '', read: async () => '' }, sources).find((tool) => tool.name === 'propose_source')!;
    await expect(propose.run({ url: 'http://localhost:7430/', about: 'x', why: 'y' }, ctx(stageWith([])))).rejects.toThrow('cannot be opened');
    await expect(propose.run({ url: 'https://startups.rip/', about: 'x'.repeat(161), why: 'y' }, ctx(stageWith([])))).rejects.toThrow('too long');
    const { text } = await propose.run({ url: 'startups.rip', about: 'case studies', why: 'it answered' }, ctx(stageWith([])));
    expect(proposed[0]).toMatchObject({ url: 'https://startups.rip/', about: 'case studies', why: 'it answered', by: 'Maya' });
    expect(text).toBe('Proposed startups.rip. It waits for the founder in Needs you.');
  });
});
