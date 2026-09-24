import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preset, type AppPreset } from '../../shared/apps.ts';
import { seedStage, type Card, type Stage } from '../../shared/model.ts';
import type { Browser, Launch } from '../browser.ts';
import type { Store } from '../store.ts';
import type { ToolEvent } from '../../shared/model.ts';
import type { Answer } from '../approvals.ts';
import { logStep, stepLogFile, webTools, yearless } from './web.ts';

// Sunday 20 September 2026, noon where the machine is.
const NOON = new Date(2026, 8, 20, 12).getTime();
// A browser that searches nothing and only writes down what it was asked for.
const asking = () => {
  const ran: { queries: string[]; recent?: string }[] = [];
  const browser = { search: async (queries: string[], recent?: string) => { ran.push({ queries, recent }); return queries.map((query) => `## ${query}\n1. A result`).join('\n\n'); } } as unknown as Browser;
  return { ran, search: webTools(browser, () => ({}), () => NOON).find((tool) => tool.name === 'web_search')! };
};
const context = (query: string) => ({ stage: seedStage, roomId: 'marketing', store: {} as Store, granted: new Map<string, string>(), query });

describe('web_search', () => {
  it('passes the window the person asked for through to the engine, and refuses a window that means nothing', async () => {
    const { ran, search } = asking();
    await search.run({ queries: ['sast market size'], recent: 'week' }, context('look up the SAST market'));
    expect(ran).toEqual([{ queries: ['sast market size'], recent: 'week' }]);
    await expect(search.run({ queries: ['x'], recent: 'fortnight' }, context(''))).rejects.toThrow(/day, week, month, year/);
  });

  it('ends every search with the line that says snippets are not pages', async () => {
    const { search } = asking();
    const said = 'These are snippets, not pages. Before you state a figure, a ranking or a quote from them, open the page with web_fetch.';
    // Last, because a small model does what the end of what it read told it to; a post claiming "60+ deals" came out
    // of snippets nobody opened, with the same warning sitting at the top where it had already been forgotten.
    const plain = await search.run({ queries: ['sast market size'] }, context('look up the SAST market'));
    expect(plain.text.startsWith('What follows came from the web.')).toBe(true);
    expect(plain.text.trimEnd().endsWith(said)).toBe(true);
    // And on the road where a second, cleaner set of results is added after the first.
    const again = await search.run({ queries: ['sast market size 2024'] }, context('look up the SAST market'));
    expect(again.text.trimEnd().endsWith(said)).toBe(true);
  });

  it('runs a remembered year again without it, because the founder never asked for that year', async () => {
    const { ran, search } = asking();
    const { text } = await search.run({ queries: ['global static application security testing market size 2024 AI'] }, context('look up SAST using AI market'));
    expect(ran).toEqual([
      { queries: ['global static application security testing market size 2024 AI'], recent: undefined },
      { queries: ['global static application security testing market size AI'], recent: 'year' },
    ]);
    // The founder reads nothing of this, but the person is told in one line what happened and which set to trust.
    expect(text.split('\n')[0]).toContain('names a year that is past');
    expect(text.split('\n')[0]).toContain('It is now 2026');
    expect(text.split('\n')[0]).toContain('work from that second set');
  });

  it('leaves the year alone when the founder was the one who named it', async () => {
    const { ran, search } = asking();
    const { text } = await search.run({ queries: ['what happened in 2024 to the SAST market'] }, context('what happened in 2024'));
    expect(ran).toEqual([{ queries: ['what happened in 2024 to the SAST market'], recent: undefined }]);
    expect(text).not.toContain('names a year that is past');
  });

  it('knows which queries need running again', () => {
    expect(yearless(['vc funding india 2024'], '', 2026)).toEqual(['vc funding india']);
    // This year and next are what a person is told to write, so neither is netted.
    expect(yearless(['vc funding 2026', 'roadmap 2027'], '', 2026)).toEqual([]);
    expect(yearless(['prices 2022', 'prices 2023'], '', 2026)).toEqual(['prices']);
    // A query that is nothing but a year has nothing left to search for.
    expect(yearless(['2019'], '', 2026)).toEqual([]);
  });
});

describe('web_fetch', () => {
  const source = (id: string, url: string): Card => ({ id, kind: 'source', url, about: 'case studies', x: 0, y: 0, w: 1, h: 1 });
  const reading = () => {
    const reads: { urls: string[]; session?: string }[] = [];
    const browser = { read: async (urls: string[], session?: string) => { reads.push({ urls, session }); return urls.map((url) => `## ${url}`).join('\n\n---\n\n'); } } as unknown as Browser;
    return { reads, fetch: webTools(browser).find((tool) => tool.name === 'web_fetch')! };
  };
  const ctx = (cards: Card[]) => ({ stage: { ...seedStage, cards }, roomId: 'marketing', store: {} as Store, granted: new Map<string, string>() });

  it('reads a page on a source website in that source\'s session and tells its card to show it', async () => {
    const { reads, fetch } = reading();
    const { text, effect } = await fetch.run({ urls: ['https://www.startups.rip/quibi', 'https://example.com/'] }, ctx([source('s1', 'https://startups.rip/')]));
    expect(reads).toEqual([{ urls: ['https://www.startups.rip/quibi'], session: 'card-s1' }, { urls: ['https://example.com/'], session: undefined }]);
    expect(effect).toEqual({ kind: 'browser-moved', id: 's1' });
    expect(text).toContain('## https://example.com/');
  });
  it('keeps a page off every source in a throwaway session', async () => {
    const { reads, fetch } = reading();
    const { effect } = await fetch.run({ urls: ['https://example.com/'] }, ctx([source('s1', 'https://startups.rip/')]));
    expect(reads).toEqual([{ urls: ['https://example.com/'], session: undefined }]);
    expect(effect).toBeUndefined();
  });
});

describe('browse', () => {
  const card = (id: string, app?: AppPreset): Card => ({ id, kind: 'browser', x: 0, y: 0, w: 1, h: 1, ...(app ? { app } : {}) });
  const wire = (from: string, to: string) => ({ id: `${from}-${to}`, from, fromHandle: 'r', to, toHandle: 'l' });
  const acting = () => {
    const acted: { session: string; launch?: Launch }[] = [];
    const browser = {
      act: async (session: string, _a: string, _i: unknown, launch?: Launch) => { acted.push({ session, launch }); return 'Now at https://example.com/\n- link "x" [ref=e1]'; },
      outward: async (_s: string, _a: string, _i: unknown, _l?: Launch, appName?: string) => `on ${appName}`,
    } as unknown as Browser;
    const browse = webTools(browser, (id, one) => ({ profile: `p-${id}`, ...(one?.kind === 'browser' && one.app ? { pace: [0, 0] as [number, number] } : {}) })).find((tool) => tool.name === 'browse')!;
    return { acted, browse };
  };
  const stageWith = (cards: Card[], wires = cards.map((one) => wire('marketing', one.id))): Stage => ({ ...seedStage, cards, wires: [...seedStage.wires, ...wires] });
  const ctx = (stage: Stage) => ({ stage, roomId: 'marketing', store: {} as Store, granted: new Map<string, string>() });

  it('drives the one wired card whatever "app" says, and paces only an app card', async () => {
    const { acted, browse } = acting();
    await browse.run({ action: 'look', app: 'Nonsense' }, ctx(stageWith([card('b1')])));
    expect(acted).toEqual([{ session: 'card-b1', launch: { profile: 'p-b1' } }]);
    await browse.run({ action: 'look' }, ctx(stageWith([card('b2', preset('linkedin'))])));
    expect(acted[1]).toEqual({ session: 'card-b2', launch: { profile: 'p-b2', pace: [0, 0] } });
  });
  it('asks for a name when two cards are wired, and takes the named one', async () => {
    const { acted, browse } = acting();
    const stage = stageWith([card('b1', preset('linkedin')), card('b2', preset('x')), card('b3')]);
    await expect(browse.run({ action: 'look' }, ctx(stage))).rejects.toThrow('Name the card in "app": LinkedIn, X, Browser');
    await browse.run({ action: 'look', app: 'x' }, ctx(stage));
    expect(acted.at(-1)?.session).toBe('card-b2');
    await browse.run({ action: 'look', app: 'Browser' }, ctx(stage));
    expect(acted.at(-1)?.session).toBe('card-b3');
  });
  it('says which card to wire when none is', async () => {
    const { browse } = acting();
    await expect(browse.run({ action: 'look' }, ctx(stageWith([card('b1')], [])))).rejects.toThrow('no browser card is connected to your room');
  });
  it('passes the app name to the approval question', async () => {
    const { browse } = acting();
    expect(await (browse.approval as Function)({ action: 'click', ref: 'e1' }, ctx(stageWith([card('b1', preset('linkedin'))])))).toBe('on LinkedIn');
    expect(await (browse.approval as Function)({ action: 'click', ref: 'e1' }, ctx(stageWith([card('b1')])))).toBe('on undefined');
  });
});

describe('browse, asking the founder for a hand', () => {
  const card: Card = { id: 'b1', kind: 'browser', x: 0, y: 0, w: 1, h: 1, app: preset('linkedin') };
  const stage: Stage = { ...seedStage, cards: [card], wires: [...seedStage.wires, { id: 'w', from: 'marketing', fromHandle: 'r', to: 'b1', toHandle: 'l' }] };
  const setup = async (answer?: Answer) => {
    const home = await mkdtemp(join(tmpdir(), 'browse-'));
    const acted: string[] = [];
    const browser = {
      act: async (_s: string, action: string) => { acted.push(action); if (action === 'click') throw new Error('that element is gone'); return 'Now at https://www.linkedin.com/feed/\n- button "Post" [ref=e4]'; },
      outward: async (_s: string, action: string) => (action === 'click' ? 'Click "Post" on LinkedIn?' : null),
    } as unknown as Browser;
    const browse = webTools(browser, (id) => ({ profile: join(home, 'browsers', id) }), () => NOON).find((tool) => tool.name === 'browse')!;
    const asked: ToolEvent[] = [];
    const context = { stage, roomId: 'marketing', store: {} as Store, granted: new Map<string, string>(), ...(answer ? { approve: async (event: ToolEvent) => { asked.push(event); return answer; } } : {}) };
    const log = async () => (await readFile(join(home, 'browsers', 'b1', 'log.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    return { browse, asked, acted, context, log };
  };

  it('puts the one step to the founder, waits, and says it was done', async () => {
    const { browse, asked, acted, context, log } = await setup({ ok: true });
    const done = await browse.run({ action: 'help', text: 'Sign in to LinkedIn, then tell me.' }, context);
    expect(done.text).toMatch(/^The founder did it\./);
    expect(done.effect).toEqual({ kind: 'browser-moved', id: 'b1' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ name: 'browse_help', waiting: true, question: 'Do this by hand in the LinkedIn card: Sign in to LinkedIn, then tell me.', args: { card: 'LinkedIn', text: 'Sign in to LinkedIn, then tell me.', answer: '' } });
    // Nothing was done in the browser for it: the founder's hands are the step.
    expect(acted).toEqual([]);
    expect(await log()).toEqual([{ at: NOON, roomId: 'marketing', action: 'help', outward: false, ok: true }]);
  });

  it('carries the founder\'s words back when they say no', async () => {
    const no = await setup({ ok: false, args: { answer: 'Not now, I am on my phone.' } });
    expect((await no.browse.run({ action: 'help', text: 'Solve the check' }, no.context)).text).toBe('The founder declined: Not now, I am on my phone.');
    expect((await no.log())[0]).toMatchObject({ action: 'help', ok: false });
    const { browse, context } = await setup({ ok: false });
    expect((await browse.run({ action: 'help', text: 'Choose the file' }, context)).text).toMatch(/^The founder declined\./);
    await expect(browse.run({ action: 'help' }, context)).rejects.toThrow('"text" is missing');
  });

  it('says so when there is no way to ask from where it runs', async () => {
    const { browse, context } = await setup();
    expect((await browse.run({ action: 'help', text: 'Sign in' }, context)).text).toContain('cannot be asked from here');
  });

  it('never asks the model to type a password or pass a check itself', () => {
    const description = webTools({} as Browser).find((tool) => tool.name === 'browse')!.description;
    expect(description).toContain('Never create an account, type a password or pass a human check yourself');
    expect(description).toContain('use action help');
  });
});

describe('browse, the step log', () => {
  it('writes one line for every step: where it went, whether the founder had to allow it, and whether it worked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'browse-'));
    const card: Card = { id: 'b1', kind: 'browser', x: 0, y: 0, w: 1, h: 1 };
    const stage: Stage = { ...seedStage, cards: [card], wires: [...seedStage.wires, { id: 'w', from: 'marketing', fromHandle: 'r', to: 'b1', toHandle: 'l' }] };
    const browser = {
      act: async (_s: string, action: string) => { if (action === 'click') throw new Error('that element is gone'); return 'Now at https://example.com/after\n- link "x" [ref=e1]'; },
      outward: async (_s: string, action: string) => (action === 'click' ? 'Click "Send"?' : null),
    } as unknown as Browser;
    let clock = NOON;
    const browse = webTools(browser, (id) => ({ profile: join(home, 'browsers', id) }), () => clock).find((tool) => tool.name === 'browse')!;
    const ctx = { stage, roomId: 'marketing', store: {} as Store, granted: new Map<string, string>() };
    await browse.run({ action: 'open', url: 'example.com' }, ctx);
    clock += 1000;
    expect(await (browse.approval as Function)({ action: 'click', ref: 'e1' }, ctx)).toBe('Click "Send"?');
    await expect(browse.run({ action: 'click', ref: 'e1' }, ctx)).rejects.toThrow('that element is gone');
    clock += 1000;
    await (browse.approval as Function)({ action: 'look' }, ctx);
    await browse.run({ action: 'look' }, ctx);
    const lines = (await readFile(join(home, 'browsers', 'b1', 'log.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { at: NOON, roomId: 'marketing', action: 'open', url: 'https://example.com/after', outward: false, ok: true },
      { at: NOON + 1000, roomId: 'marketing', action: 'click', ref: 'e1', outward: true, ok: false },
      { at: NOON + 2000, roomId: 'marketing', action: 'look', url: 'https://example.com/after', outward: false, ok: true },
    ]);
  });

  it('keeps only the newest lines, and writes none for a card with no folder of its own', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'browse-')), 'b1', 'log.jsonl');
    await Promise.all(Array.from({ length: 30 }, (_, index) => logStep(file, { at: index, roomId: 'r', action: 'look', outward: false, ok: true }, 20)));
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).at);
    expect(lines).toEqual(Array.from({ length: 20 }, (_, index) => index + 10));
    expect(stepLogFile('b1', { profile: 'relative/folder' })).toBeNull();
    expect(stepLogFile('b1', {})).toBeNull();
    expect(stepLogFile('b1', { profile: '/w/browsers/b1' })).toBe('/w/browsers/b1/log.jsonl');
  });
});
