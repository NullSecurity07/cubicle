import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Lead } from '../../shared/leads.ts';
import { DAY } from '../../shared/leads-nudge.ts';
import type { Attention } from '../../shared/model.ts';
import { createAttention } from '../attention.ts';
import type { Deps } from '../install.ts';
import { createStore } from '../store.ts';
import nudge from './leads-nudge.ts';

// The slice on a throwaway workspace: a Leads card wired to Maya, with one lead who replied four days ago.
async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'nudge-slice-'));
  const store = createStore(workspace);
  const stage = await store.loadStage();
  stage.cards = [{ id: 'leads-n', kind: 'leads', x: 0, y: 0, w: 1, h: 1 }];
  stage.wires.push({ id: 'w', from: 'marketing', fromHandle: 'r', to: 'leads-n', toHandle: 'l' });
  await store.saveStage(stage);
  const now = Date.now();
  const leads: Lead[] = [
    { id: 'lead-ana', person: { name: 'Ana' }, company: { name: 'Acme' }, stage: 'replied', notes: [], source: 'founder', addedAt: now - 9 * DAY, updatedAt: now - 4 * DAY },
    { id: 'lead-bo', person: { name: 'Bo' }, company: { name: 'Beta' }, stage: 'fit', notes: [], source: 'founder', addedAt: now - 30 * DAY, updatedAt: now - 30 * DAY },
  ];
  await mkdir(join(workspace, 'leads'), { recursive: true });
  await writeFile(join(workspace, 'leads', 'leads-n.json'), JSON.stringify(leads));
  const attention = createAttention(workspace);
  const answered: { status: number; body: any }[] = [];
  let sent: unknown = {};
  const deps = {
    workspace, root: workspace, fake: true, store, attention,
    json: (_res: ServerResponse, status: number, body: unknown) => { answered.push({ status, body }); },
    body: async () => sent,
  } as unknown as Deps;
  const part = await nudge.install(deps);
  const call = async (path: string, body: unknown) => { sent = body; await part.route!({ method: 'POST' } as IncomingMessage, {} as ServerResponse, path); return answered.at(-1)!; };
  return { part, attention, call };
}

describe('the follow-up nudges slice', () => {
  it('puts one line in Needs you for a quiet lead, with the wired person to draft it, and none for a Fit lead', async () => {
    const { attention } = await setup();
    const list = (await attention.list()).filter((one: Attention) => one.kind === 'lead-stale');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'lead-stale:leads-n:lead-ana:replied', title: 'Ana at Acme replied 4 days ago. Draft a reply?', roomId: 'marketing', cardId: 'leads-n' });
  });

  it('hands back the ask for the wired person, and a dismissed nudge stays gone', async () => {
    const { attention, call } = await setup();
    const id = 'lead-stale:leads-n:lead-ana:replied';
    const asked = await call('/api/nudges/ask', { id });
    expect(asked.body).toMatchObject({ roomId: 'marketing', name: 'Maya', lead: 'Ana at Acme' });
    expect(asked.body.text).toMatch(/replied 4 days ago.*evidence-outreach/);
    expect((await call('/api/nudges/dismiss', { id })).status).toBe(200);
    expect((await attention.list()).some((one: Attention) => one.id === id)).toBe(false);
    expect((await call('/api/nudges/dismiss', { id: 'nope' })).status).toBe(400);
  });
});
