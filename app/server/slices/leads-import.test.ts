import { mkdtemp } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Imported } from '../../shared/leads-import.ts';
import type { Deps } from '../install.ts';
import { createLeads } from '../leads/store.ts';
import { createStore } from '../store.ts';
import leadsImport, { importInto } from './leads-import.ts';

const SHEET = 'Full Name,Organisation,E-mail,LinkedIn URL,Notes\n'
  + 'Ada Lovelace,Analytical,ada@analytical.io,https://www.linkedin.com/in/ada,Met at the meetup\n'
  + 'Grace Hopper,Navy,,,\n'
  + 'ada lovelace,ANALYTICAL,,,\n'
  + ',Nobody Inc,,,\n';

describe('importing a spreadsheet into a Leads card', () => {
  it('adds each row through the same door as the form, once, and says what it skipped', async () => {
    const leads = createLeads(await mkdtemp(join(tmpdir(), 'leads-import-')));
    await leads.add('leads-1', { name: 'Grace Hopper', company: 'Navy', source: 'person' });
    expect(await importInto(leads, 'leads-1', SHEET)).toEqual({ added: 1, already: 2, skipped: [{ row: 5, why: 'no name' }] });
    const [grace, ada] = await leads.list('leads-1');
    expect(grace.source).toBe('person');
    expect(ada).toMatchObject({ person: { name: 'Ada Lovelace', email: 'ada@analytical.io', linkedin: 'https://www.linkedin.com/in/ada' }, company: { name: 'Analytical' }, source: 'founder', stage: 'new' });
    expect(ada.notes.map((note) => [note.by, note.text])).toEqual([['Founder', 'Met at the meetup']]);
  });

  it('refuses a paste it cannot read, in words', async () => {
    const leads = createLeads(await mkdtemp(join(tmpdir(), 'leads-import-')));
    await expect(importInto(leads, 'leads-1', 'Company\nAcme\n')).rejects.toThrow(/No column for names/);
    await expect(importInto(leads, 'leads-1', '')).rejects.toThrow('Paste a few rows first.');
  });

  it('answers only for a Leads card on the stage', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'leads-import-'));
    const store = createStore(workspace);
    const stage = await store.loadStage();
    stage.cards = [{ id: 'leads-1', kind: 'leads', x: 0, y: 0, w: 1, h: 1 }];
    await store.saveStage(stage);
    const answered: { status: number; body: unknown }[] = [];
    const part = await leadsImport.install({ workspace, store, json: (_res: ServerResponse, status: number, body: unknown) => answered.push({ status, body }), body: async () => ({ text: 'Name,Company\nJo,Acme\n' }) } as unknown as Deps);
    const post = (path: string, method = 'POST') => part.route!({ method } as IncomingMessage, {} as ServerResponse, path);
    expect(await post('/api/leads/leads-1/import', 'GET')).toBe(false);
    expect(await post('/api/leads/leads-1')).toBe(false);
    expect(await post('/api/leads/nope/import')).toBe(true);
    expect(answered.at(-1)!.status).toBe(404);
    expect(await post('/api/leads/leads-1/import')).toBe(true);
    expect(answered.at(-1)).toEqual({ status: 200, body: { added: 1, already: 0, skipped: [] } satisfies Imported });
  });
});
