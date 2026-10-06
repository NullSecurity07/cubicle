import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localDay, type CompetitorView } from '../../shared/competitor.ts';
import type { Stage } from '../../shared/model.ts';
import { createAttention } from '../attention.ts';
import { buildView, changesOf, lastCrawl, guardedNote, noteChange, twoLines, type CompetitorCard } from '../competitor/view.ts';
import { hub } from '../events.ts';
import type { Deps } from '../install.ts';
import { createSeams } from '../seams.ts';
import { createStore } from '../store.ts';
import competitor, { FAKE_NOTE, noteAsk } from './competitor.ts';
import { watchAttention, watchesAt, type Watch } from './crawl.ts';

const NOW = new Date('2026-09-25T12:00:00').getTime();
const HOUR = 3600_000;
const card: CompetitorCard = { id: 'competitor-1', kind: 'competitor', name: 'Acme', url: 'https://acme.test/', pages: ['https://acme.test/pricing', 'https://acme.test/changelog'], x: 0, y: 0, w: 1, h: 1 };
const watch = (over: Partial<Watch>): Watch => ({ id: 'w1', url: 'https://acme.test/pricing', what: '', roomId: 'marketing', title: 'Pricing', hash: 'x', text: '', addedAt: NOW - 30 * 86_400_000, checkedAt: NOW, ...over });
const stage = (wired = true): Stage => ({
  rooms: [{ id: 'marketing', name: 'Maya', role: 'Marketing', accent: '#fff', brief: '', x: 0, y: 0, w: 1, h: 1 }], docs: [], cards: [card],
  wires: wired ? [{ id: 'w', from: 'marketing', fromHandle: 'r', to: card.id, toHandle: 'l' }] : [],
});

describe('what the card shows', () => {
  it('joins watches to the card by address, preferring its own, and lists the changes newest first', () => {
    const all = [
      watch({ id: 'someone', url: 'acme.test/pricing/', roomId: 'build', readAt: NOW - 2 * HOUR }),
      watch({ id: 'mine', cardId: card.id, readAt: NOW - HOUR, history: [{ at: NOW - 5 * 86_400_000, diff: '+ Pro $39\n− Pro $29', note: { by: 'Maya', text: 'Pro went up.\nRoom for us below.' } }] }),
      watch({ id: 'old', url: 'https://acme.test/changelog', roomId: 'build', readAt: NOW - 3 * HOUR, changedAt: NOW - 86_400_000, diff: '+ v2 is out' }),
      watch({ id: 'left', cardId: card.id, url: 'https://acme.test/careers', readAt: NOW - 4 * HOUR }),
      watch({ id: 'other', url: 'https://else.test/pricing' }),
    ];
    const view = buildView(card, all, stage(), NOW);
    expect(view.pages.map((page) => [page.label, page.watch?.id, page.watch?.owner])).toEqual([['Pricing', 'mine', 'Maya'], ['Changelog', 'old', 'you'], ['Careers', 'left', 'Maya']]);
    expect(view.changes.map((one) => [one.label, one.phrase, one.note?.by])).toEqual([['Changelog', 'v2 is out', undefined], ['Pricing', 'Pro $29 → $39', 'Maya']]);
    expect(view.changes[1].lines).toEqual(['+ Pro $39', '− Pro $29']);
    expect(view).toMatchObject({ lastRead: NOW - HOUR, overdue: false, person: 'Maya' });
    expect(buildView(card, all.map((one) => ({ ...one, readAt: NOW - 8 * HOUR })), stage(false), NOW)).toMatchObject({ overdue: true, person: null });
  });

  it('keeps a change from before the history began, and writes a note beside it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rival-note-'));
    const watches = watchesAt(dir);
    const legacy = watch({ changedAt: NOW - HOUR, diff: '+ Pro $39' });
    await watches.change('marketing', (list) => { list.push(legacy); });
    expect(changesOf(legacy)).toEqual([{ at: NOW - HOUR, diff: '+ Pro $39' }]);
    expect(await noteChange(watches, legacy, NOW - HOUR, { by: 'Maya', text: 'Up ten.' })).toBe(true);
    expect(await noteChange(watches, legacy, NOW, { by: 'Maya', text: 'No such change.' })).toBe(false);
    expect((await watches.read('marketing'))[0].history).toEqual([{ at: NOW - HOUR, diff: '+ Pro $39', note: { by: 'Maya', text: 'Up ten.' } }]);
  });

  it('finds the newest whole-site read of the host and counts its pages', async () => {
    const files = await mkdtemp(join(tmpdir(), 'rival-crawl-'));
    await mkdir(join(files, 'crawls'));
    await writeFile(join(files, 'crawls', 'www.acme.test-2026-09-20.md'), '# www.acme.test\nRead 2026-09-20 from https://acme.test. 4 pages. This is what the site said.');
    await writeFile(join(files, 'crawls', 'acme.test-2026-09-24.md'), '# acme.test\nRead 2026-09-24 from https://acme.test. 12 pages. This is what the site said.');
    await writeFile(join(files, 'crawls', 'notacme.test-2026-09-25.md'), '# x\n1 pages.');
    expect(await lastCrawl(files, 'acme.test')).toEqual({ file: 'crawls/acme.test-2026-09-24.md', day: '2026-09-24', pages: 12 });
    expect(await lastCrawl(files, 'nobody.test')).toBeNull();
  });

  it('keeps two lines of what a person said, without bullets', () => {
    expect(twoLines('- Pro went up by ten.\n\n- There is room below them.\n- A third.')).toBe('Pro went up by ten.\nThere is room below them.');
    expect(noteAsk('Acme', 'Pricing', 'https://acme.test/pricing', NOW, '+ Pro $39')).toContain('changed on 2026-09-25');
  });
});

let closing: (() => Promise<void>) | undefined;
afterEach(async () => { await closing?.(); closing = undefined; });

async function setup(wiredToo = true) {
  const workspace = await mkdtemp(join(tmpdir(), 'rival-slice-'));
  const store = createStore(workspace);
  const saved = await store.loadStage();
  saved.cards = [{ ...card, pages: [] }];
  if (wiredToo) saved.wires.push({ id: 'w', from: 'marketing', fromHandle: 'r', to: card.id, toHandle: 'l' });
  await store.saveStage(saved);
  const seams = createSeams();
  const attention = createAttention(workspace);
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  const deps = {
    workspace, root: workspace, fake: true, store, seams, attention, notify: () => {},
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => sent,
  } as unknown as Deps;
  const heard: string[] = [];
  hub.say = (channel) => heard.push(channel);
  const part = await competitor.install(deps);
  closing = part.close;
  const call = async (path: string, method = 'GET', body: unknown = {}) => { sent = body; await part.route!({ method } as IncomingMessage, {} as ServerResponse, path); return answered.at(-1)!; };
  const watches = watchesAt(join(workspace, 'watch'));
  return { part, store, seams, attention, call, heard, watches, workspace };
}

describe('the Competitor card', () => {
  it('watches a page for the wired person, notes each change, and tells the person in one dated line', async () => {
    const { part, call, heard, watches, seams, attention, store } = await setup();
    expect((await call('/api/competitor/competitor-1/watch', 'POST', { url: 'acme.test/pricing' })).status).toBe(200);
    const [started] = await watches.read('marketing');
    expect(started).toMatchObject({ url: 'https://acme.test/pricing', cardId: card.id, roomId: 'marketing', title: 'Pricing — Example' });
    expect(heard).toContain('competitor:competitor-1');
    // The card's list is the client's to keep; a watch the card started shows even before it lands there.
    let view = (await call('/api/competitor/competitor-1')).body as CompetitorView;
    expect(view.pages.map((page) => page.watch?.id)).toEqual([started.id]);

    // A change, as the six-hourly check writes it.
    await watches.change('marketing', (list) => { list[0].changedAt = NOW; list[0].diff = '+ Team costs 14\n− Team costs 12'; list[0].history = [{ at: NOW, diff: list[0].diff }]; });
    await part.tick!();
    view = (await call('/api/competitor/competitor-1')).body as CompetitorView;
    expect(view.changes).toMatchObject([{ phrase: 'Team costs 12 → 14', note: { by: 'Maya', text: FAKE_NOTE } }]);

    const turn = async (roomId: string) => (await seams.run('turn:before', { roomId, source: 'chat', query: 'news?', messages: [{ role: 'system', content: 'You are Maya.' }, { role: 'user', content: 'hi' }] })).messages[0].content;
    const day = localDay(NOW);
    expect(await turn('marketing')).toContain(`- Competitor Acme (acme.test): ${localDay(Date.now()).slice(0, 7) === day.slice(0, 7) ? '1 change' : '0 changes'} this month`);
    expect(await turn('marketing')).toContain(`latest ${day} pricing page: Team costs 12 → 14.`);
    expect(await turn('build')).toBe('You are Maya.');

    // Needs you says which card the change belongs to.
    attention.source(watchAttention(watches, { store }, () => NOW + 1));
    expect((await attention.list()).find((one) => one.kind === 'page-changed')).toMatchObject({ cardId: card.id, roomId: 'marketing' });

    expect((await call('/api/competitor/competitor-1/stop', 'POST', { url: 'https://acme.test/pricing/' })).body).toEqual({ ok: true, stopped: 1 });
    expect(await watches.read('marketing')).toEqual([]);
  });

  it('with nobody wired, a watch is the founder\'s; a bad address and an unknown card are refused', async () => {
    const { call, watches } = await setup(false);
    expect((await call('/api/competitor/competitor-1/watch', 'POST', { url: 'https://acme.test/changelog' })).status).toBe(200);
    expect((await watches.read('founder'))[0]).toMatchObject({ cardId: card.id, roomId: 'founder' });
    expect(((await call('/api/competitor/competitor-1')).body as CompetitorView).pages[0].watch?.owner).toBe('you');
    expect((await call('/api/competitor/competitor-1/watch', 'POST', { url: 'not a page' })).status).toBe(400);
    expect((await call('/api/competitor/nobody')).status).toBe(404);
  });

  it('crawls the whole site into the shared files and shows it', async () => {
    const { call } = await setup();
    const done = (await call('/api/competitor/competitor-1/crawl', 'POST')).body as { text: string; crawl: CompetitorView['crawl'] };
    expect(done.text).toMatch(/3 pages read/);
    expect(done.crawl).toMatchObject({ file: expect.stringMatching(/^crawls\/acme\.test-\d{4}-\d{2}-\d{2}\.md$/), pages: 3 });
    expect(((await call('/api/competitor/competitor-1')).body as CompetitorView).crawl?.pages).toBe(3);
  });
});

describe('a note on a change', () => {
  it('marks a count and a claim the change does not give', () => {
    const diff = '- Pro plan €29 a month\n+ Pro plan €19 a month\n+ Now with 3 printers per account';
    expect(guardedNote('They cut Pro to €19 and allow 3 printers per account.\nCustomers love it, 12 hosts already switched.', diff))
      .toBe('They cut Pro to €19 and allow 3 printers per account.\nCustomers love it, 12 (unsourced) hosts already switched (assumption).');
  });
});
