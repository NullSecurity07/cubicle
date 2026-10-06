import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCompanyDoc } from '../shared/partner.ts';
import { DRAFT_BODY_MOST, draftId, gmailLink, mailtoLink } from '../shared/maildraft.ts';
import type { Attention, Card, Stage } from '../shared/model.ts';
import { createAttention } from './attention.ts';
import { createMail } from './mail.ts';
import { runTool } from './tools/registry.ts';
import { createStore } from './store.ts';
import { openInGmailCard, outwardTools } from './tools/outward.ts';

const draft = { to: 'lead@example.com', subject: 'Hello & welcome?', body: 'Hi there,\nline two = 100% #1' };

describe('a Gmail draft link', () => {
  it('fills every field, encoded, and the mailto: link carries the same', () => {
    const link = new URL(gmailLink(draft));
    expect(link.origin + link.pathname).toBe('https://mail.google.com/mail/');
    expect(Object.fromEntries(link.searchParams)).toEqual({ view: 'cm', fs: '1', to: 'lead@example.com', su: 'Hello & welcome?', body: 'Hi there,\nline two = 100% #1' });
    expect(gmailLink(draft)).toContain('su=Hello%20%26%20welcome%3F');
    expect(gmailLink({ ...draft, to: 'a@x.com; b@y.com' })).toContain('to=a%40x.com%2Cb%40y.com');
    expect(mailtoLink(draft)).toBe('mailto:lead%40example.com?subject=Hello%20%26%20welcome%3F&body=Hi%20there%2C%0Aline%20two%20%3D%20100%25%20%231');
  });

  it('cuts a long body so the link still opens', () => {
    const long = { ...draft, body: 'x'.repeat(5000) };
    expect(new URL(gmailLink(long)).searchParams.get('body')).toHaveLength(DRAFT_BODY_MOST);
    expect(gmailLink(long).length).toBeLessThan(2100);
  });

  it('names one Needs you entry per draft', () => {
    expect(draftId(draft)).toBe(draftId({ ...draft }));
    expect(draftId(draft)).not.toBe(draftId({ ...draft, subject: 'Other' }));
    expect(draftId(draft)).toMatch(/^mail-draft:/);
  });
});

async function setup(env: NodeJS.ProcessEnv, open?: (stage: Stage, roomId: string, url: string) => Promise<string | null>) {
  const dir = await mkdtemp(join(tmpdir(), 'draft-'));
  const store = createStore(dir);
  const attention = createAttention(dir, () => 1000);
  const tools = outwardTools(createMail(env, (async () => new Response('{}')) as typeof fetch), store.filesDir, { raise: attention.raise, open }, () => 1000);
  const context = { stage: await store.loadStage(), roomId: 'marketing', store, granted: new Map() };
  return { attention, run: (args: object) => runTool(tools, 'draft_email', JSON.stringify(args), context), tools, dir };
}

describe('draft_email', () => {
  it('without a key: drafts behind a button, says nothing was sent, and waits in Needs you', async () => {
    const { attention, run, tools } = await setup({});
    expect(tools.find((tool) => tool.name === 'draft_email')!.approval).toBeFalsy();
    const done = await run(draft);
    expect(done.ok).toBe(true);
    expect(done.text).toMatch(/^Draft ready: an "Open in Gmail" button/);
    expect(done.text).toContain('Nothing was sent');
    expect(done.text).toContain('never that it was sent');
    expect(done.text).not.toContain('send_email');
    const [entry] = await attention.list();
    expect(entry).toMatchObject({ id: draftId(draft), kind: 'mail-draft', title: 'Email to lead@example.com ready to send', detail: draft.subject, url: gmailLink(draft), roomId: 'marketing' });
    // Opened (or waved away) by the founder, it is gone.
    await attention.dismiss(entry.id);
    expect(await attention.list()).toEqual([]);
  });

  it('with a key: still only drafts, and points at send_email', async () => {
    const { run } = await setup({ AGENTMAIL_API_KEY: 'k' });
    expect((await run(draft)).text).toContain('send_email can also send it for you');
  });

  it('says when the body was cut, and refuses a bad address', async () => {
    const { run } = await setup({});
    expect((await run({ ...draft, body: 'y'.repeat(DRAFT_BODY_MOST + 1) })).text).toContain(`only the first ${DRAFT_BODY_MOST}`);
    const bad = await run({ ...draft, to: 'not-an-address' });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('not an email address');
  });

  it("opens in the founder's Gmail card when one is wired to the person", async () => {
    const { attention, run } = await setup({}, async () => 'gmail-card');
    const done = await run(draft);
    expect(done.text).toMatch(/^Draft opened in the founder's Gmail card\. Nothing was sent/);
    expect(done.effect).toEqual({ kind: 'browser-moved', id: 'gmail-card' });
    expect((await attention.list())[0]).toMatchObject({ cardId: 'gmail-card' });
  });

  it('keeps a draft in Needs you across a restart, not as a lapsed question', async () => {
    const { attention, run, dir } = await setup({});
    await run(draft);
    await attention.settled();
    const [entry] = await createAttention(dir, () => 2000).list();
    expect(entry.kind).toBe('mail-draft');
    expect((entry as Attention & { lapsed?: boolean }).lapsed).toBeFalsy();
  });
});

// Journey 13: Tom drafted to office@example.com, an address nothing had ever given.
describe('an address in a draft', () => {
  const ask = { to: 'office@example.com', subject: 'A free trial box', body: 'Hi,' };
  async function turn(read: string[], options: { leads?: string[]; brief?: string; founder?: string } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'draft-'));
    const store = createStore(dir);
    const attention = createAttention(dir, () => 1000);
    const tools = outwardTools(createMail({}, (async () => new Response('{}')) as typeof fetch), store.filesDir, { raise: attention.raise, onRecord: async () => options.leads ?? [] }, () => 1000);
    const stage = await store.loadStage();
    if (options.brief) {
      const company = findCompanyDoc(stage.docs) ?? (stage.docs.push({ id: 'company', title: 'Company brief', pinned: true, x: 0, y: 0, w: 1, h: 1 } as Stage['docs'][number]), stage.docs.at(-1)!);
      await store.replaceDoc(company.id, options.brief);
    }
    if (options.founder) await store.appendChat(stage.rooms[0].id, { role: 'user', text: options.founder } as never);
    const context = { stage, roomId: stage.rooms[0].id, store, granted: new Map(), sources: () => read };
    return { attention, run: (args: object) => runTool(tools, 'draft_email', JSON.stringify(args), context) };
  }

  it('is refused when nothing on record gives it, and a role address before their domain is called a guess', async () => {
    const { run, attention } = await turn(['Exampleco: 30 staff, hiring an office manager. https://www.example.com/jobs']);
    const out = await run(ask);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/^Failed: no address on record for office@example\.com: .*"office@" put before their domain is a guess\. Ask the founder for it, or find it on their site/);
    expect(await attention.list()).toEqual([]);
  });

  it('stands when a page read, a Leads card row, the founder or the Company brief gives it', async () => {
    expect((await (await turn(['Contact us: office@example.com'])).run(ask)).ok).toBe(true);
    expect((await (await turn([], { leads: ['Office@Example.com'] })).run(ask)).ok).toBe(true);
    expect((await (await turn([], { founder: 'Their office manager is office@example.com' })).run(ask)).ok).toBe(true);
    expect((await (await turn([], { brief: '# Company brief\n\nFirst lead: office@example.com' })).run(ask)).ok).toBe(true);
    // One of two unknown is still refused, naming only that one.
    const two = await (await turn(['Contact us: office@example.com'])).run({ ...ask, to: 'office@example.com, anna@samplely.example' });
    expect(two.text).toMatch(/^Failed: no address on record for anna@samplely\.example: /);
  });
});

describe('openInGmailCard', () => {
  const gmail: Card = { id: 'g1', kind: 'browser', app: { key: 'gmail', name: 'Gmail', home: 'https://mail.google.com/mail/u/0/' }, x: 0, y: 0, w: 1, h: 1 } as Card;
  const stage = (cards: Card[], wired: boolean) => ({ rooms: [{ id: 'r1', name: 'Maya' }], docs: [], cards, wires: wired ? cards.map((card) => ({ id: `w-${card.id}`, from: 'r1', to: card.id })) : [] }) as unknown as Stage;

  it('opens the compose page in the wired Gmail card, and nothing without one', async () => {
    const steps: unknown[][] = [];
    const open = openInGmailCard({ act: async (...args: unknown[]) => { steps.push(args); return 'Now at x'; } } as never);
    expect(await open(stage([gmail], true), 'r1', 'https://mail.google.com/mail/?view=cm')).toBe('g1');
    expect(steps[0].slice(0, 3)).toEqual(['card-g1', 'open', { url: 'https://mail.google.com/mail/?view=cm' }]);
    expect(await open(stage([gmail], false), 'r1', 'u')).toBeNull();
    expect(await open(stage([{ ...gmail, app: { key: 'x', name: 'X', home: 'https://x.com' } } as Card], true), 'r1', 'u')).toBeNull();
    expect(steps).toHaveLength(1);
  });
});
