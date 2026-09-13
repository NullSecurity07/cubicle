/**
 * SP8 §1 and §2 on the wire: what the Decisions sheet and the Messages view are handed, and the two ops they
 * send back. The viewer builds against these field names, so a rename here is a broken office.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  scaffoldVault, Vault, createProposal, findInboxById, stringifyNote, ownerDecide, nowIso,
  FOUNDER_BRIEF, DM_THREAD_ID, type Turn,
} from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler } from '@cubicle/harness';
import { buildSnapshot, WsServer, INBOX_BODY_MAX, DECIDED_ROWS, type Snapshot } from '../src/ws.js';
import { dispatchProposals } from '../src/index.js';
import { ADOPTED_BRIEF } from './helpers/brief.js';

const root = path.resolve(__dirname, '../../..');

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-snap-dec-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const deps = () => ({
  vault,
  registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })),
  toolsConfig: parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8')),
  scheduler: vaultScheduler(vault, 'daemon'),
  env: {} as NodeJS.ProcessEnv,
});

const row = (snap: Snapshot, id: string) => snap.inbox.find((r) => r.id === id)!;

const THREE = '1. Northwind — kits for nursery kitchens.\n2. Tuckbox — a weekly box.\n3. Provender — per child per week.\n\nSet `chosen: 1|2|3` and `approved: true`.';

describe('Snapshot.inbox carries the whole decision', () => {
  it('a brand_change is a choice, with its numbered options', () => {
    const { id, path: rel } = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', job: 'job_x', title: 'Three company ideas — pick one', body: THREE }, 'ceo');
    const r = row(buildSnapshot(vault), id);
    expect(r).toMatchObject({ kind: 'brand_change', title: 'Three company ideas — pick one', path: rel, from: 'ceo', job: 'job_x', target: 'Brand/name.md', decidable: 'choose' });
    expect(r.options).toEqual([
      { n: 1, label: 'Northwind — kits for nursery kitchens.' },
      { n: 2, label: 'Tuckbox — a weekly box.' },
      { n: 3, label: 'Provender — per child per week.' },
    ]);
    expect(r.body).toContain('2. Tuckbox');
    expect(r.pressure).toBe('');
    expect(r.band).toBe('');
  });

  it('an idea_verdict carries the band it was shown with, its reason and the board\'s verdict', () => {
    const { id, path: rel } = createProposal(vault, { kind: 'idea_verdict', from: 'ceo', target: 'Ideas/meal-kits.md', title: 'Keep, park or scrap', body: 'Recommendation: **park**.\n\n## Pressure test\n\n**Brutal Verdict:** WEAK.\n\n## What the board said\n\n- Nothing.' }, 'ceo');
    vault.updateNote(rel, (n) => ({ data: { ...n.data, board_verdict: 'return', band: 'park', band_reason: '42/60 would keep, but the board returned it.' }, body: n.body }), 'daemon');
    const r = row(buildSnapshot(vault), id);
    expect(r).toMatchObject({ band: 'park', band_reason: '42/60 would keep, but the board returned it.', board_verdict: 'return', decidable: 'choose' });
    expect(r.options.map((o) => o.label)).toEqual(['keep', 'park', 'scrap']);
    expect(r.pressure).toBe('**Brutal Verdict:** WEAK.');
  });

  it('a founder brief is an adoption, and its pressure test comes out of the fenced block', () => {
    const { id } = createProposal(vault, {
      kind: 'founder_brief', from: 'ceo', target: FOUNDER_BRIEF, title: 'The founder brief',
      body: `## Proposed content\n\n\`\`\`md\n${ADOPTED_BRIEF}\`\`\`\n\nSet \`approved: true\` to adopt it.`,
    }, 'ceo');
    const r = row(buildSnapshot(vault), id);
    expect(r.decidable).toBe('adopt');
    expect(r.options).toEqual([]);
    expect(r.pressure).toContain('Core Assumption: nurseries will pay per child');
    expect(r.pressure).not.toContain('```');
    expect(r.pressure).not.toContain('Set `approved: true`');
  });

  it('everything else is an approval', () => {
    const { id } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'The plan', body: '1. bet one\n2. bet two' }, 'ceo');
    expect(row(buildSnapshot(vault), id)).toMatchObject({ decidable: 'approve', options: [], target: '', job: '' });
  });

  it('caps the body, so one note that quoted a report cannot cost every reconnect', () => {
    const { id } = createProposal(vault, { kind: 'file_change', from: 'cto', target: 'Docs/x.md', title: 'A long one', body: 'x'.repeat(INBOX_BODY_MAX + 5_000) }, 'cto');
    const r = row(buildSnapshot(vault), id);
    expect(r.body.length).toBeLessThan(INBOX_BODY_MAX + 200);
    expect(r.body).toContain('truncated');
  });
});

describe('a decided note keeps its row until the dispatcher is done with it (ruling P8-8)', () => {
  it('the row stays, marked pending, carrying what the owner decided', () => {
    const { id } = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Pick one', body: THREE }, 'ceo');
    expect(row(buildSnapshot(vault), id)).toMatchObject({ pending: false, approved: null, chosen: null, refused: null });
    expect(buildSnapshot(vault).pendingProposals).toBe(1);

    ownerDecide(vault, id, { approved: true, chosen: 2 });

    const snap = buildSnapshot(vault);
    // Before this ruling the note was in neither list here, and the reader showed nothing at all.
    expect(row(snap, id)).toMatchObject({ pending: true, approved: true, chosen: 2, refused: null });
    expect(snap.decided.some((d) => d.id === id)).toBe(false);
    // The pill is "N to approve": a decided note is off the owner's plate whatever the sheet still shows.
    expect(snap.pendingProposals).toBe(0);
  });

  it('a note the dispatcher refuses keeps its row for good, with the refusal on it', async () => {
    // `chosen: 4` names no option, so the dispatcher refuses it — and never resolves it. The hole this ruling
    // is about was permanent for exactly this note.
    const { id, path: rel } = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Pick one', body: THREE }, 'ceo');
    vault.updateNote(rel, (n) => ({ data: { ...n.data, approved: true, chosen: 4 }, body: n.body }), 'owner');

    expect(await dispatchProposals(deps())).toBe(0);

    // `refuseNote` stamps no `resolved_at` and emits no `proposal.resolved`, and `retryDue` re-refuses every
    // ten minutes without saying so again. The row is the only place the owner ever learns any of this.
    const note = findInboxById(vault, id)!;
    expect(note.data.resolved_at ?? null).toBeNull();
    expect(vault.events.query({ types: ['proposal.resolved'] })).toHaveLength(0);

    const snap = buildSnapshot(vault);
    const r = row(snap, id);
    expect(r.pending).toBe(true);
    expect(r.approved).toBe(true);
    expect(r.chosen).toBe(4);
    expect(r.refused).toContain('chosen: 4 matches no option');
    expect(r.body).toContain('_Not applied:');
    expect(snap.decided.some((d) => d.id === id)).toBe(false);
    expect(snap.pendingProposals).toBe(0);

    // And it stays: a second pass changes nothing about what the owner is shown.
    await dispatchProposals(deps());
    expect(row(buildSnapshot(vault), id).refused).toContain('chosen: 4 matches no option');
  });

  it('and moves to decided once it is resolved', async () => {
    const { id } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'The plan', body: 'b' }, 'ceo');
    ownerDecide(vault, id, { approved: true });
    expect(buildSnapshot(vault).inbox.map((r) => r.id)).toContain(id);

    await dispatchProposals(deps());

    const snap = buildSnapshot(vault);
    expect(snap.inbox).toHaveLength(0);
    expect(snap.decided.map((d) => d.id)).toEqual([id]);
    expect(snap.pendingProposals).toBe(0);
  });
});

describe('Snapshot.decided is the owner\'s receipt', () => {
  it('carries the dispatcher\'s own footer as the outcome, newest first', async () => {
    const a = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'Plan A', body: 'a' }, 'ceo');
    ownerDecide(vault, a.id, { approved: true });
    await dispatchProposals(deps());
    const b = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Pick one', body: THREE }, 'ceo');
    ownerDecide(vault, b.id, { approved: true, chosen: 2 });
    await dispatchProposals(deps());

    const snap = buildSnapshot(vault);
    expect(snap.inbox).toHaveLength(0);
    expect(snap.decided.map((d) => d.id)).toEqual([b.id, a.id]);
    expect(snap.decided[0]).toMatchObject({ kind: 'brand_change', title: 'Pick one', approved: true, chosen: 2 });
    expect(snap.decided[0].outcome).toContain('applied to Brand/name.md');
    expect(snap.decided[0].resolved_at).toBeTruthy();
    expect(snap.decided[1].outcome).toBe('plan approved: the divisions plan against it');
  });

  it('is capped, and never carries a plain message', async () => {
    for (let i = 0; i < DECIDED_ROWS + 3; i++) {
      const p = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: `Plan ${i}`, body: 'b' }, 'ceo');
      ownerDecide(vault, p.id, { approved: true });
      await dispatchProposals(deps());
    }
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'hi', body: 'hi' }, 'owner');
    const snap = buildSnapshot(vault);
    expect(snap.decided).toHaveLength(DECIDED_ROWS);
    expect(snap.decided.every((d) => d.kind !== 'message')).toBe(true);
  });
});

describe('Snapshot.conversations', () => {
  it('is the vault\'s threads, newest first', () => {
    vault.writeText('Meetings/2026-09-13-0900-board-x.md', stringifyNote(
      { id: 'meet_b1', room: 'board', opened: nowIso(), facilitator: 'advisor_skeptic', participants: ['advisor_skeptic', 'advisor_operator'], status: 'in_progress' },
      '# Board: Meal kits\n\n## Agenda\n\nMeal kits\n\n## Transcript\n\n**Round 1 — advisor_skeptic:** What is the core assumption?\n',
    ), 'daemon');
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'hello', body: 'What are we doing today?' }, 'owner');

    const snap = buildSnapshot(vault);
    expect(snap.conversations.map((t) => t.id).sort()).toEqual(['board:meet_b1', DM_THREAD_ID].sort());
    expect(snap.conversations.find((t) => t.id === 'board:meet_b1')).toMatchObject({ kind: 'board', open: true, turns: 1 });
  });
});

// ---------- the ops ----------

/** One connected client, with a queue of everything the server has said. */
async function client(ws: WsServer, port: number): Promise<{ sock: WebSocket; next: (op: string, ms?: number) => Promise<Record<string, unknown>>; close: () => void }> {
  const seen: Record<string, unknown>[] = [];
  const sock = new WebSocket(`ws://127.0.0.1:${port}?token=${ws.token}`);
  sock.on('message', (raw) => seen.push(JSON.parse(String(raw))));
  await new Promise<void>((res, rej) => { sock.once('open', () => res()); sock.once('error', rej); });
  const next = async (op: string, ms = 5_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = seen.findIndex((m) => m.op === op);
      if (i >= 0) return seen.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error(`no ${op} (saw ${seen.map((m) => m.op).join(', ') || 'nothing'})`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { sock, next, close: () => sock.close() };
}

describe('the decide and conversation.get ops', () => {
  let ws: WsServer; let port: number; let ticks: string[];
  beforeEach(async () => {
    ticks = [];
    ws = new WsServer({ vault, port: 0, onDecide: (id) => ticks.push(id) });
    port = await ws.start();
  });
  afterEach(async () => { await ws.stop(); });

  it('decides the note, acks it, and asks for a tick', async () => {
    const { id } = createProposal(vault, { kind: 'brand_change', from: 'ceo', target: 'Brand/name.md', title: 'Pick one', body: THREE }, 'ceo');
    const c = await client(ws, port);
    await c.next('snapshot');

    c.sock.send(JSON.stringify({ op: 'decide', id, approved: true, chosen: 2, comment: 'This one.' }));
    expect(await c.next('decide.ack')).toMatchObject({ id });

    const note = findInboxById(vault, id)!;
    expect(note.data.approved).toBe(true);
    expect(note.data.chosen).toBe(2);
    expect(note.body.trimEnd().endsWith('This one.')).toBe(true);
    expect(ticks).toEqual([id]);   // the dispatcher is asked to run now, not on the next interval
    c.close();
  });

  it('answers a malformed decide, and a decide the vault refuses, without writing anything', async () => {
    const { id } = createProposal(vault, { kind: 'plan_verdict', from: 'ceo', title: 'The plan', body: 'b' }, 'ceo');
    const c = await client(ws, port);
    await c.next('snapshot');

    // Every error names the note it is about (review I4): the viewer routes it to the reader that sent it, and
    // with no id it would fall back to the first pending decision — the wrong reader, with two in flight.
    for (const bad of [{ op: 'decide', id }, { op: 'decide', id, approved: 'yes' }, { op: 'decide', id, approved: true, chosen: 'two' }, { op: 'decide', id, approved: true, comment: 7 }]) {
      c.sock.send(JSON.stringify(bad));
      const e = await c.next('error');
      expect(String(e.message)).toMatch(/decide/);
      expect(e.id).toBe(id);
    }
    c.sock.send(JSON.stringify({ op: 'decide', id: 'prop_nope', approved: true }));
    expect(await c.next('error')).toMatchObject({ id: 'prop_nope', message: expect.stringContaining('no proposal') });
    c.sock.send(JSON.stringify({ op: 'decide', id, approved: true, chosen: 1 }));
    expect(await c.next('error')).toMatchObject({ id, message: expect.stringContaining('nothing to choose') });
    // Only a message that carried no usable id has none to give back.
    c.sock.send(JSON.stringify({ op: 'decide' }));
    expect(await c.next('error')).toMatchObject({ id: null, message: expect.stringContaining('decide needs id') });

    expect(findInboxById(vault, id)!.data.approved).toBeNull();
    expect(ticks).toEqual([]);
    c.close();
  });

  it('refuses a brief the board is still sitting on, naming the note (ruling R-T3-3)', async () => {
    const { id, path: rel } = createProposal(vault, { kind: 'founder_brief', from: 'ceo', target: FOUNDER_BRIEF, title: 'The founder brief', body: `## Proposed content\n\n\`\`\`md\n${ADOPTED_BRIEF}\`\`\`\n` }, 'ceo');
    vault.updateNote(rel, (n) => ({ data: { ...n.data, board_pending: true }, body: n.body }), 'daemon');
    const c = await client(ws, port);
    await c.next('snapshot');

    c.sock.send(JSON.stringify({ op: 'decide', id, approved: true }));
    expect(await c.next('error')).toMatchObject({ id, message: 'the board is still sitting on this brief; decide once its pressure test is in' });
    expect(findInboxById(vault, id)!.data.approved).toBeNull();
    expect(ticks).toEqual([]);
    c.close();
  });

  it('an unknown op is still ignored, and never answered', async () => {
    const c = await client(ws, port);
    await c.next('snapshot');
    c.sock.send(JSON.stringify({ op: 'nonsense', id: 'x' }));
    c.sock.send(JSON.stringify({ op: 'snapshot' }));
    await c.next('snapshot');          // the next op is answered, so the socket is alive and said nothing about the first
    await expect(c.next('error', 250)).rejects.toThrow(/no error/);
    c.close();
  });

  it('conversation.get returns the whole thread, and [] for one nobody wrote', async () => {
    const { path: rel } = createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'hello', body: 'What are we doing today?' }, 'owner');
    vault.updateNote(rel, (n) => ({ data: n.data, body: `${n.body.trimEnd()}\n\n## CEO\n\nDiscovery, then the brief.\n` }), 'daemon');
    const c = await client(ws, port);
    await c.next('snapshot');

    c.sock.send(JSON.stringify({ op: 'conversation.get', id: DM_THREAD_ID }));
    const got = await c.next('conversation');
    expect(got.id).toBe(DM_THREAD_ID);
    expect((got.turns as Turn[]).map((t) => [t.who, t.text])).toEqual([
      ['owner', 'What are we doing today?'],
      ['ceo', 'Discovery, then the brief.'],
    ]);

    c.sock.send(JSON.stringify({ op: 'conversation.get', id: 'meeting:nope' }));
    expect((await c.next('conversation')).turns).toEqual([]);

    c.sock.send(JSON.stringify({ op: 'conversation.get' }));
    expect(String((await c.next('error')).message)).toMatch(/conversation.get needs id/);
    c.close();
  });
});
