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
import { leadAddresses, leadContacts, openInGmailCard, outwardTools } from './tools/outward.ts';
import { leadsFor } from './leads/store.ts';

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
  return { attention, run: (args: object, allowed = false) => runTool(tools, 'draft_email', JSON.stringify(args), { ...context, allowed }), tools, dir };
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

  // Journey 18: a reply to a lead said yes to Android and VAT with nothing on record.
  it('refuses a claim about the product nothing on record states, and drafts the honest line', async () => {
    const { run } = await setup({});
    const said = await run({ ...draft, body: 'Hi Tom,\n\nYes, it works with photos from any Android phone, VAT charged separately.\n\nBest,' });
    expect(said.ok).toBe(false);
    expect(said.text).toContain('the email says something about Android, VAT that nothing on record states');
    const honest = await run({ ...draft, body: 'Hi Tom,\n\nI will check whether it works with photos from your old Android phone and come back to you by Friday.\n\nBest,' });
    expect(honest.ok).toBe(true);
  });

  // Journey 19: the founder pressed Allow on a draft and the guard refused the same body again.
  it('drafts what the founder read and allowed', async () => {
    const { run } = await setup({});
    const body = 'Hi Tom,\n\nThe quote shows VAT on its own line.\n\nBest,';
    expect((await run({ ...draft, body })).ok).toBe(false);
    expect((await run({ ...draft, body }, true)).ok).toBe(true);
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

// Journey 14: Rosa was wired to a Leads card holding Dr. Anna Weber's address, drafted to a guessed one, and the
// refusal said "no Leads card". The real lookup, on a real workspace.
describe('an address on the Leads card the person reaches', () => {
  async function stageWith(cards: { wired: boolean; email?: string }[]) {
    const dir = await mkdtemp(join(tmpdir(), 'draft-leads-'));
    const store = createStore(dir);
    const attention = createAttention(dir, () => 1000);
    const stage = await store.loadStage();
    const roomId = stage.rooms[0].id;
    stage.cards = [];
    for (const [index, card] of cards.entries()) {
      const id = `leads-${index + 1}`;
      stage.cards.push({ id, kind: 'leads', x: 0, y: 0, w: 1, h: 1 } as Card);
      if (card.wired) stage.wires.push({ id: `w${index}`, from: roomId, fromHandle: 'r', to: id, toHandle: 'l' } as Stage['wires'][number]);
      await leadsFor(dir).add(id, { name: 'Dr. Anna Weber', company: 'Weber Dental', source: 'founder', ...(card.email ? { email: card.email } : {}) });
    }
    await store.saveStage(stage);
    const tools = outwardTools(createMail({}, (async () => new Response('{}')) as typeof fetch), store.filesDir, { raise: attention.raise, onRecord: leadAddresses(dir), contacts: leadContacts(dir) }, () => 1000);
    const context = { stage: await store.loadStage(), roomId, store, granted: new Map(), sources: () => [] as string[] };
    return (to: string, body = 'Hi Dr. Weber,') => runTool(tools, 'draft_email', JSON.stringify({ to, subject: 'A free two-week pilot', body }), context);
  }

  it('drafts to the address the wired card gives', async () => {
    const run = await stageWith([{ wired: true, email: 'anna.weber@example-dental.de' }]);
    expect((await run('anna.weber@example-dental.de')).ok).toBe(true);
  });

  it('refuses a guess and names the address the card gives, wired or the only card on the stage', async () => {
    for (const wired of [true, false]) {
      const out = await (await stageWith([{ wired, email: 'anna.weber@example-dental.de' }]))('dr.anna.weber@example.com');
      expect(out.ok).toBe(false);
      expect(out.text).toContain('no address on record for dr.anna.weber@example.com: it is not on the Leads card you reach. The card gives Dr. Anna Weber at Weber Dental: anna.weber@example-dental.de.');
      expect(out.text).not.toContain('no Leads card');
    }
  });

  // Journey 19: Lea drafted to tom@becker-sanitaer.email when the card said tom@becker-sanitaer.example.
  it('takes only the very address on record, in any case, and names it when one is near', async () => {
    const run = await stageWith([{ wired: true, email: 'tom@becker-sanitaer.example' }]);
    expect((await run('Tom@Becker-Sanitaer.EXAMPLE')).ok).toBe(true);
    for (const typo of ['tom@becker-sanitaer.email', 'tom@becker-sanitar.example', 'tomm@becker-sanitaer.example']) {
      const out = await run(typo);
      expect(out.ok).toBe(false);
      expect(out.text).toContain(`no address on record for ${typo}: the record has tom@becker-sanitaer.example, which is not the same address. Draft again to exactly tom@becker-sanitaer.example`);
    }
    // The address is held before anything the body says.
    const both = await run('tom@becker-sanitaer.email', 'Hi Tom,\n\nYes, the quote shows VAT separately.');
    expect(both.text).toContain('the record has tom@becker-sanitaer.example');
    expect(both.text).not.toContain('says something about');
  });

  it('says the card holds no address when it has none, and "no Leads card" only when there is none', async () => {
    expect((await (await stageWith([{ wired: true }]))('dr.anna.weber@example.com')).text).toContain('the Leads card you reach holds no address for anyone');
    expect((await (await stageWith([]))('dr.anna.weber@example.com')).text).toMatch(/^Failed: no address on record for dr\.anna\.weber@example\.com: nothing read this turn, no Leads card, /);
    // Two cards, neither wired: none is the person's.
    expect((await (await stageWith([{ wired: false, email: 'a@x.de' }, { wired: false, email: 'b@y.de' }]))('dr.anna.weber@example.com')).text).toContain('no Leads card');
  });
});

// Journey 18: "Draft first message" on Tom Becker opened "I saw your comment on Reddit ..." with nothing read.
describe('draft_email: what the email says about the person', () => {
  async function tom(note?: string, lead: { name: string; company: string; email: string } = { name: 'Tom Becker', company: 'Becker Sanitär', email: 'tom@becker.example' }, wired = true) {
    const dir = await mkdtemp(join(tmpdir(), 'draft-about-'));
    const store = createStore(dir);
    const attention = createAttention(dir, () => 1000);
    const stage = await store.loadStage();
    const roomId = stage.rooms[0].id;
    stage.cards = [{ id: 'leads-1', kind: 'leads', x: 0, y: 0, w: 1, h: 1 } as Card];
    if (wired) stage.wires.push({ id: 'w1', from: roomId, fromHandle: 'r', to: 'leads-1', toHandle: 'l' } as Stage['wires'][number]);
    const added = await leadsFor(dir).add('leads-1', { ...lead, source: 'founder' });
    if (note) await leadsFor(dir).note('leads-1', added.lead.id, 'founder', note);
    await store.saveStage(stage);
    const tools = outwardTools(createMail({}, (async () => new Response('{}')) as typeof fetch), store.filesDir, { raise: attention.raise, onRecord: leadAddresses(dir), contacts: leadContacts(dir) }, () => 1000);
    const context = { stage: await store.loadStage(), roomId: wired ? roomId : stage.rooms.at(-1)!.id, store, granted: new Map(), sources: () => [] as string[], query: `Draft a first message to ${lead.name} at ${lead.company} using the evidence-outreach skill.` };
    return { attention, colleague: stage.rooms[0].name, run: (body: string) => runTool(tools, 'draft_email', JSON.stringify({ to: lead.email, subject: 'Quotes from photos', body }), context) };
  }
  const REDDIT = 'Hi Tom,\n\nI saw your comment on Reddit about spending your evenings after jobs writing up quotes in the van.\n\nBest,';

  it('refuses a detail about them nothing on record gives, and says to open with what we do', async () => {
    const { run } = await tom();
    const out = await run(REDDIT);
    expect(out.ok).toBe(false);
    expect(out.text).toContain('the email says "I saw your comment on Reddit');
    expect(out.text).toContain('open with what we do');
  });

  it('takes it from their notes, and says what the draft rests on', async () => {
    const { run, attention } = await tom('Posted on Reddit (r/Plumbing) that he spends his evenings in the van writing up quotes.');
    const out = await run(REDDIT);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("(from: Tom Becker's row on the Leads card)");
    expect((await attention.list())[0].detail).toBe("Quotes from photos\n(from: Tom Becker's row on the Leads card)");
  });

  // Journey 20: "Regarding your questions:" was refused twice, and the third try was signed with the partner's name.
  it('drafts a header line that frames the answers, and signs with no colleague\'s name', async () => {
    const { run, attention, colleague } = await tom();
    const out = await run(`Hi Tom,\n\nThanks for getting back to us.\n\nRegarding your questions:\n- "Does it work on Android?" We will check and come back to you.\n\nBest,\n${colleague}`);
    expect(out.ok, out.text).toBe(true);
    const body = new URL((await attention.list())[0].url!).searchParams.get('body')!;
    expect(body).toContain('Regarding your questions:');
    expect(body).not.toContain(colleague);
    expect(body).toMatch(/Best,(?:\n[^\n]+)?$/);
    expect(out.text).toContain('The sign-off was put right');
  });

  // Journey 20: "I saw Repair Café Kreuzberg's work running community repair evenings" with nothing read: their café's
  // name on the row backed a whole made-up detail.
  it('refuses a detail dressed in their own name, on the Leads path and from a room the card is not wired to', async () => {
    const ines = { name: 'Ines Vogel', company: 'Repair Café Kreuzberg', email: 'ines@repaircafe.example' };
    const body = "Hi Ines,\n\nI saw Repair Café Kreuzberg's work running community repair evenings.\n\nBest,";
    for (const wired of [true, false]) {
      const { run } = await tom(undefined, ines, wired);
      const out = await run(body);
      expect(out.ok, `wired: ${wired}`).toBe(false);
      expect(out.text).toContain('the email says "I saw Repair Café Kreuzberg');
      expect((await run('Hi Ines,\n\nI noticed you run Repair Café Kreuzberg.\n\nBest,')).ok).toBe(true);
    }
    const { run } = await tom('Runs community repair evenings every Thursday.', ines);
    expect((await run(body)).ok).toBe(true);
  });

  it('takes what their row gives, and a plain opener about us needs nothing about them', async () => {
    const { run } = await tom();
    expect((await run('Hi Tom,\n\nI noticed you run Becker Sanitär.\n\nBest,')).ok).toBe(true);
    expect((await run('Hi Tom,\n\nWe help plumbers turn photos into written quotes.\n\nBest,')).ok).toBe(true);
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
