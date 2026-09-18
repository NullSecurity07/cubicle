/**
 * The office floor on the wire: `layout.set` → `layout.ack` → `layout.changed`, and the same path an owner's
 * save in Obsidian takes (`pushLayout`).
 *
 * A live `WsServer` on an ephemeral port, because the contract being tested is the socket's: what the sender is
 * told about its own write, and what every other open office is told at the same moment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  scaffoldVault, Vault, loadOrg, loadCampusMap, readLayout, writeLayout, stringifyNote, connected,
  OFFICE_LAYOUT_PATH, type CampusLayout,
} from '@cubicle/core';
import { WsServer, buildSnapshot } from '../src/ws.js';

let dir: string, vault: Vault, server: WsServer, port: number;
const TOKEN = 'layout-test-token';

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-layout-ws-'));
  vault = (await scaffoldVault(dir)).vault;
  server = new WsServer({ vault, port: 0, token: TOKEN });
  port = await server.start();
});
afterEach(async () => { await server.stop(); vault.close(); rmSync(dir, { recursive: true, force: true }); });

interface Client { ws: WebSocket; msgs: Record<string, unknown>[] }

async function open(): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${TOKEN}`);
  const msgs: Record<string, unknown>[] = [];
  ws.on('message', (m) => msgs.push(JSON.parse(String(m))));
  await new Promise((r) => ws.once('open', r));
  await waitFor(() => msgs.some((m) => m.op === 'snapshot'));
  return { ws, msgs };
}

async function waitFor(pred: () => boolean, what = 'condition', ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${what}`);
}

const layoutNow = (): CampusLayout => readLayout(vault, loadCampusMap(), loadOrg(vault))!.layout;

describe('the layout on the wire', () => {
  it('the snapshot carries the office the vault was scaffolded with', async () => {
    const snap = buildSnapshot(vault);
    expect(snap.layout.connections.length).toBeGreaterThan(10);
    expect(connected(snap.layout, 'ceo', 'cto')).toBe(true);
    const { msgs, ws } = await open();
    expect((msgs.find((m) => m.op === 'snapshot') as { layout: CampusLayout }).layout).toEqual(snap.layout);
    ws.close();
  });

  it('layout.set writes the note, acks the dropped line and tells every other office', async () => {
    const a = await open(), b = await open();
    const was = layoutNow();
    a.ws.send(JSON.stringify({
      op: 'layout.set',
      nodes: { ...was.nodes, cto: { x: 9, y: 6 }, plant_nowhere: { x: 1, y: 1 } },
      connections: was.connections,
    }));
    await waitFor(() => a.msgs.some((m) => m.op === 'layout.ack'), 'layout.ack');
    const ack = a.msgs.find((m) => m.op === 'layout.ack') as { dropped: { line: string; reason: string }[] };
    expect(ack.dropped).toEqual([{ line: 'nodes.plant_nowhere', reason: 'no desk, zone or prop called plant_nowhere' }]);

    await waitFor(() => b.msgs.some((m) => m.op === 'layout.changed'), 'layout.changed on the other office');
    const changed = b.msgs.find((m) => m.op === 'layout.changed') as { layout: CampusLayout };
    expect(changed.layout.nodes.cto).toEqual({ x: 9, y: 6 });
    expect(changed.layout.nodes.plant_nowhere).toBeUndefined();

    // and it is on disk, in the note the owner reads
    expect(layoutNow().nodes.cto).toEqual({ x: 9, y: 6 });
    expect(vault.readText(OFFICE_LAYOUT_PATH)).toContain('## Who can message whom');
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.line === 'nodes.plant_nowhere')).toBe(true);
    a.ws.close(); b.ws.close();
  });

  it('cutting a line and drawing one is the whole of the write', async () => {
    const a = await open();
    const was = layoutNow();
    const connections = was.connections.filter((c) => !(c.from === 'ceo' && c.to === 'cto') && !(c.from === 'cto' && c.to === 'ceo'));
    connections.push({ from: 'cto', to: 'station_browser', kind: 'access' });
    a.ws.send(JSON.stringify({ op: 'layout.set', nodes: was.nodes, connections }));
    await waitFor(() => a.msgs.some((m) => m.op === 'layout.ack'));
    const now = layoutNow();
    expect(connected(now, 'ceo', 'cto')).toBe(false);
    expect(connected(now, 'cto', 'station_browser')).toBe(true);
    a.ws.close();
  });

  it('refuses a layout.set that is not one, and leaves the office standing', async () => {
    const a = await open();
    const was = layoutNow();
    a.ws.send(JSON.stringify({ op: 'layout.set' }));
    await waitFor(() => a.msgs.some((m) => m.op === 'error'), 'an error');
    expect((a.msgs.find((m) => m.op === 'error') as { message: string }).message).toContain('needs nodes');
    expect(layoutNow()).toEqual(was);
    a.ws.close();
  });

  it('an owner edit in Obsidian takes the same path, and a bad line is rewritten out of the note', async () => {
    const a = await open();
    const was = layoutNow();
    // what a save in Obsidian leaves behind: a hand-typed line for a desk that does not exist
    vault.writeText(OFFICE_LAYOUT_PATH, stringifyNote(
      { version: 1, nodes: { ...was.nodes, who_even: { x: 4, y: 4 } }, connections: was.connections },
      '# The office\n',
    ), 'owner');
    const layout = server.pushLayout();
    expect(layout.nodes.who_even).toBeUndefined();
    await waitFor(() => a.msgs.some((m) => m.op === 'layout.changed'), 'layout.changed');
    expect(vault.readText(OFFICE_LAYOUT_PATH)).not.toContain('who_even');
    expect(vault.readText(OFFICE_LAYOUT_PATH)).toContain('## Who can use what');
    a.ws.close();
  });

  it('does not answer a good edit with a write of its own', async () => {
    const org = loadOrg(vault);
    writeLayout(vault, layoutNow(), 'owner', org);
    const before = vault.writtenSha(OFFICE_LAYOUT_PATH);
    server.pushLayout();
    expect(vault.writtenSha(OFFICE_LAYOUT_PATH)).toBe(before);
  });
});
