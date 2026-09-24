import { mkdtemp } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Deps } from '../install.ts';
import { createLeads } from '../leads/store.ts';
import { createMirror, createTwentyClient, GAP, personBody, PULL_EVERY, STAGE_FIELD } from '../leads/twenty.ts';
import { createStore } from '../store.ts';
import twenty from './twenty.ts';

// A Twenty that lives in memory and answers the way v2.42's REST API did on the live check.
function fakeTwenty(clock: () => number, options: { refuseField?: boolean } = {}) {
  let n = 0;
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const at = () => new Date(clock()).toISOString();
  const people = new Map<string, any>();
  const companies = new Map<string, any>();
  const notes = new Map<string, any>();
  const targets: any[] = [];
  const fields: any[] = [{ name: 'name' }];
  const calls: string[] = [];
  let down = false;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const http = (async (input: string | URL, init?: RequestInit) => {
    if (down) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/rest/metadata/objects') return reply(200, { data: [{ id: 'obj-person', nameSingular: 'person', fields }], pageInfo: {}, totalCount: 1 });
    if (url.pathname === '/rest/metadata/fields') {
      if (options.refuseField) return reply(403, { statusCode: 403, messages: ['Forbidden resource'] });
      fields.push(body);
      return reply(201, { id: id(), ...body });
    }
    if (url.pathname === '/rest/companies' && method === 'GET') {
      const name = /name\[eq\]:"(.*)"/.exec(url.searchParams.get('filter') ?? '')?.[1];
      return reply(200, { data: { companies: [...companies.values()].filter((one) => one.name === name) } });
    }
    if (url.pathname === '/rest/companies') { const one = { id: id(), updatedAt: at(), ...body }; companies.set(one.id, one); return reply(201, { data: { createCompany: one } }); }
    if (url.pathname === '/rest/people' && method === 'GET') {
      const since = /updatedAt\[gt\]:(.*)/.exec(url.searchParams.get('filter') ?? '')?.[1];
      const list = [...people.values()].filter((one) => !since || one.updatedAt > since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .map((one) => ({ ...one, company: one.companyId ? companies.get(one.companyId) ?? null : null }));
      return reply(200, { data: { people: list }, pageInfo: { hasNextPage: false }, totalCount: list.length });
    }
    if (url.pathname === '/rest/people') { const one = { id: id(), updatedAt: at(), deletedAt: null, ...body }; people.set(one.id, one); return reply(201, { data: { createPerson: one } }); }
    const person = /^\/rest\/people\/(.+)$/.exec(url.pathname)?.[1];
    if (person) {
      const one = people.get(person);
      if (!one) return reply(404, { statusCode: 404, error: 'NotFoundException', messages: ['Record not found'] });
      if (method === 'PATCH') { Object.assign(one, body, { updatedAt: at() }); return reply(200, { data: { updatePerson: one } }); }
      return reply(200, { data: { person: one } });
    }
    if (url.pathname === '/rest/notes') { const one = { id: id(), ...body }; notes.set(one.id, one); return reply(201, { data: { createNote: one } }); }
    if (url.pathname === '/rest/noteTargets') { targets.push(body); return reply(201, { data: { createNoteTarget: { id: id(), ...body } } }); }
    return reply(404, { messages: ['no such path'] });
  }) as typeof fetch;
  // What the founder does by hand in Twenty's own window.
  const edit = (personId: string, change: Record<string, unknown>) => Object.assign(people.get(personId), change, { updatedAt: at() });
  const add = (person: Record<string, unknown>) => { const one = { id: id(), updatedAt: at(), deletedAt: null, ...person }; people.set(one.id, one); return one; };
  return { http, people, companies, notes, targets, fields, calls, edit, add, set down(value: boolean) { down = value; } };
}

async function setup(options: { refuseField?: boolean } = {}) {
  let clock = Date.parse('2026-09-24T10:00:00Z');
  const now = () => clock;
  const tick = (ms: number) => { clock += ms; };
  const workspace = await mkdtemp(join(tmpdir(), 'twenty-'));
  const leads = createLeads(workspace, () => {}, now);
  const server = fakeTwenty(now, options);
  const lines: string[] = [];
  const client = createTwentyClient({ url: 'http://twenty.test', key: 'k' }, server.http, async (ms) => tick(ms), now);
  const mirror = createMirror({ client, leads, cards: async () => ['leads-1'], statePath: join(workspace, 'twenty', 'state.json'), now, log: (line) => lines.push(line) });
  return { leads, server, mirror, lines, tick, now };
}

describe('the Twenty mirror', () => {
  it('sends every lead once as a person at a company, with the stage field and each note, and then stays quiet', async () => {
    const { leads, server, mirror, lines, tick } = await setup();
    const { lead } = await leads.add('leads-1', { name: 'Ada King Lovelace', company: 'Engines Ltd', site: 'https://engines.example', email: 'ada@engines.example', source: 'founder', note: { by: 'Founder', text: 'Met at a meetup' } });
    await leads.add('leads-1', { name: 'Charles Babbage', company: 'Engines Ltd', source: 'person' });
    tick(10);
    await mirror.sync();
    expect(server.fields.find((one) => one.name === STAGE_FIELD)?.options.map((one: any) => one.value)).toEqual(['NEW', 'FIT', 'CONTACTED', 'REPLIED', 'MEETING', 'CUSTOMER', 'PASSED']);
    expect(server.companies.size).toBe(1);
    const ada = [...server.people.values()].find((one) => one.name.firstName === 'Ada')!;
    expect(ada).toMatchObject({ name: { firstName: 'Ada', lastName: 'King Lovelace' }, emails: { primaryEmail: 'ada@engines.example' }, [STAGE_FIELD]: 'NEW', companyId: [...server.companies.keys()][0] });
    expect([...server.companies.values()][0].domainName).toEqual({ primaryLinkUrl: 'https://engines.example' });
    expect([...server.notes.values()].map((one) => one.bodyV2.markdown)).toEqual(['Met at a meetup']);
    expect(server.targets).toEqual([{ noteId: [...server.notes.keys()][0], targetPersonId: ada.id }]);
    const linked = (await leads.list('leads-1')).find((one) => one.id === lead.id)!;
    expect(linked.twenty).toMatchObject({ personId: ada.id, noteIds: { [`0:${lead.notes[0].at}`]: [...server.notes.keys()][0] } });
    expect(mirror.status()).toMatchObject({ connected: true, pushed: 2, pulled: 0 });
    expect(lines).toContain('Twenty: sent 2, brought back 0.');

    const before = server.calls.length;
    tick(30_000);
    await mirror.sync();
    expect(server.calls.slice(before).filter((one) => !one.startsWith('GET /rest/people'))).toEqual([]);
    expect(server.people.size).toBe(2);

    // A new note on the card goes over once, and a stage change goes over as the field.
    tick(30_000);
    await leads.note('leads-1', lead.id, 'Maya', 'Replied on LinkedIn');
    await leads.move('leads-1', lead.id, 'replied');
    tick(30_000);
    await mirror.sync();
    expect(server.notes.size).toBe(2);
    expect(server.people.get(ada.id)[STAGE_FIELD]).toBe('REPLIED');
  });

  it('brings back a stage and an email set in Twenty, at most every two minutes, with a note on the lead', async () => {
    const { leads, server, mirror, lines, tick } = await setup();
    const { lead } = await leads.add('leads-1', { name: 'Grace Hopper', company: 'Cobol Co', source: 'founder' });
    tick(10);
    await mirror.sync();
    const personId = (await leads.list('leads-1'))[0].twenty!.personId;
    tick(5_000);
    server.edit(personId, { [STAGE_FIELD]: 'MEETING', emails: { primaryEmail: 'grace@cobol.example' }, jobTitle: 'Rear Admiral' });
    tick(30_000);
    await mirror.sync();
    expect((await leads.list('leads-1'))[0].stage).toBe('new');
    tick(PULL_EVERY);
    await mirror.sync();
    const back = (await leads.list('leads-1'))[0];
    expect(back).toMatchObject({ id: lead.id, stage: 'meeting', person: { email: 'grace@cobol.example', title: 'Rear Admiral' } });
    expect(back.notes.at(-1)).toMatchObject({ by: 'Twenty', text: 'Stage set in Twenty: Meeting.' });
    expect(lines).toContain('Twenty: Grace Hopper at Cobol Co: stage now Meeting, title changed, email changed, from Twenty.');
    expect(mirror.status().pulled).toBe(1);
    // What came back is not sent back, and its note stays here.
    const before = server.calls.length;
    tick(30_000);
    await mirror.sync();
    expect(server.calls.slice(before).filter((one) => one !== 'GET /rest/people')).toEqual([]);
    expect(server.notes.size).toBe(0);
  });

  it('adds a person made in Twenty with a Cubicle stage to the first card, and leaves the rest of Twenty alone', async () => {
    const { leads, server, mirror, lines, tick } = await setup();
    const company = { id: 'c-1', name: 'Orbit Labs', domainName: { primaryLinkUrl: 'orbit.example' } };
    server.companies.set(company.id, company);
    server.add({ name: { firstName: 'Katherine', lastName: 'Johnson' }, companyId: 'c-1', [STAGE_FIELD]: 'FIT', jobTitle: 'Mathematician' });
    server.add({ name: { firstName: 'Somebody', lastName: 'Else' }, [STAGE_FIELD]: null });
    tick(10);
    await mirror.sync();
    const [lead, ...rest] = await leads.list('leads-1');
    expect(rest).toEqual([]);
    expect(lead).toMatchObject({ source: 'twenty', stage: 'fit', person: { name: 'Katherine Johnson', title: 'Mathematician' }, company: { name: 'Orbit Labs', site: 'orbit.example' }, twenty: { companyId: 'c-1' } });
    expect(lines).toContain('Twenty: Katherine Johnson at Orbit Labs added in Twenty, now on the card, in Fit.');
    expect(server.people.size).toBe(2);
  });

  it('lets the later change win when both sides changed, and says which', async () => {
    const { leads, server, mirror, lines, tick } = await setup();
    const { lead } = await leads.add('leads-1', { name: 'Alan Turing', company: 'Bletchley', source: 'founder' });
    tick(10);
    await mirror.sync();
    const personId = (await leads.list('leads-1'))[0].twenty!.personId;
    // Twenty first, the card later: the card's stage goes over.
    tick(1_000);
    server.edit(personId, { [STAGE_FIELD]: 'PASSED' });
    tick(1_000);
    await leads.move('leads-1', lead.id, 'meeting');
    tick(1_000);
    await mirror.sync();
    expect(server.people.get(personId)[STAGE_FIELD]).toBe('MEETING');
    expect(lines).toContain('Twenty: Alan Turing at Bletchley changed in both; the card\'s change is later, so it goes to Twenty.');
    // The card first, Twenty later: Twenty's stage comes back, and nothing is sent over it.
    tick(1_000);
    await leads.move('leads-1', lead.id, 'customer');
    tick(1_000);
    server.edit(personId, { [STAGE_FIELD]: 'REPLIED' });
    tick(1_000);
    await mirror.sync();
    expect((await leads.list('leads-1'))[0].stage).toBe('replied');
    expect(server.people.get(personId)[STAGE_FIELD]).toBe('REPLIED');
    expect(lines.at(-2)).toBe('Twenty: Alan Turing at Bletchley: stage now Replied, from Twenty (changed in both; Twenty\'s is later).');
  });

  it('keeps a lead deleted in Twenty and puts it back there', async () => {
    const { leads, server, mirror, lines, tick } = await setup();
    const { lead } = await leads.add('leads-1', { name: 'Hedy Lamarr', company: 'Frequency', source: 'founder' });
    tick(10);
    await mirror.sync();
    const first = (await leads.list('leads-1'))[0].twenty!.personId;
    server.people.delete(first);
    tick(1_000);
    await leads.move('leads-1', lead.id, 'fit');
    tick(1_000);
    await mirror.sync();
    expect(await leads.list('leads-1')).toHaveLength(1);
    const again = (await leads.list('leads-1'))[0].twenty!.personId;
    expect(again).not.toBe(first);
    expect(server.people.get(again)[STAGE_FIELD]).toBe('FIT');
    expect(lines).toContain('Twenty: Hedy Lamarr at Frequency was deleted in Twenty. The card keeps its leads, so it is put back there.');
  });

  it('writes a stage as a note when the key may not add the field, and says so once', async () => {
    const { leads, server, mirror, lines, tick } = await setup({ refuseField: true });
    const { lead } = await leads.add('leads-1', { name: 'Mary Somerville', company: 'Physics', source: 'founder' });
    tick(10);
    await mirror.sync();
    expect(lines[0]).toMatch(/^Twenty: could not add the Cubicle stage field \(POST \/rest\/metadata\/fields answered 403: Forbidden resource\), so a stage change goes over as a note\.$/);
    const person = [...server.people.values()][0];
    expect(person[STAGE_FIELD]).toBeUndefined();
    expect([...server.notes.values()].map((one) => one.title)).toEqual(['Stage: New']);
    tick(1_000);
    await leads.move('leads-1', lead.id, 'fit');
    tick(1_000);
    await mirror.sync();
    tick(30_000);
    await mirror.sync();
    expect([...server.notes.values()].map((one) => one.title)).toEqual(['Stage: New', 'Stage: Fit']);
    expect(lines.filter((one) => one.includes('could not add'))).toHaveLength(1);
  });

  it('says once when Twenty is down, never throws, and says when it is back', async () => {
    const { leads, server, mirror, lines, tick, now } = await setup();
    await leads.add('leads-1', { name: 'Ada Lovelace', company: 'Engines', source: 'founder' });
    server.down = true;
    const since = now();
    await mirror.sync();
    tick(30_000);
    await mirror.sync();
    expect(mirror.status()).toMatchObject({ connected: true, problem: 'not reachable', since });
    expect(lines).toEqual(['Twenty: not reachable (GET /rest/metadata/objects did not answer: fetch failed).']);
    server.down = false;
    tick(30_000);
    await mirror.sync();
    expect(mirror.status().problem).toBeUndefined();
    expect(lines).toContain('Twenty: reachable again at http://twenty.test.');
    expect(server.people.size).toBe(1);
  });

  it('asks at most five times a second', async () => {
    let clock = 0;
    const times: number[] = [];
    const http = (async () => { times.push(clock); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const client = createTwentyClient({ url: 'http://twenty.test', key: 'k' }, http, async (ms) => { clock += ms; }, () => clock);
    await Promise.all(Array.from({ length: 6 }, () => client.call('GET', '/rest/people')));
    expect(times).toEqual([0, GAP, 2 * GAP, 3 * GAP, 4 * GAP, 5 * GAP]);
  });

  it('splits a name into first and last, and leaves the stage out without the field', () => {
    const lead = { person: { name: 'Plato' }, company: { name: 'Academy' }, stage: 'fit' } as never;
    expect(personBody(lead, undefined, false)).toEqual({ name: { firstName: 'Plato', lastName: '' }, jobTitle: '', emails: { primaryEmail: '' }, linkedinLink: { primaryLinkUrl: '' } });
  });
});

describe('the Twenty slice', () => {
  it('stays off without both settings, or in fake mode, and says so on its status route', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'twenty-slice-'));
    const answered: { status: number; body: any }[] = [];
    const deps = { workspace, root: workspace, fake: true, store: createStore(workspace), json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); } } as unknown as Deps;
    const saved = { url: process.env.TWENTY_URL, key: process.env.TWENTY_API_KEY };
    try {
      delete process.env.TWENTY_URL;
      const part = await twenty.install(deps);
      expect(part.tick).toBeUndefined();
      expect(await part.route!({ method: 'GET' } as IncomingMessage, {} as ServerResponse, '/api/twenty/status')).toBe(true);
      expect(answered.at(-1)).toEqual({ status: 200, body: { connected: false, url: '', lastSync: null, pushed: 0, pulled: 0 } });
      expect(await part.route!({ method: 'GET' } as IncomingMessage, {} as ServerResponse, '/api/twenty/other')).toBe(false);
      process.env.TWENTY_URL = 'http://twenty.test';
      process.env.TWENTY_API_KEY = 'k';
      expect((await twenty.install(deps)).tick).toBeUndefined();
    } finally {
      for (const [name, value] of [['TWENTY_URL', saved.url], ['TWENTY_API_KEY', saved.key]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
});
