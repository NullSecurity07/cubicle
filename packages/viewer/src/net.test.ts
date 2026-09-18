import { describe, it, expect, afterEach } from 'vitest';
import { Net, type NetHandlers } from './net.js';

/** Minimal stand-in for the browser WebSocket: starts CONNECTING, opens only when the test says so. */
class FakeWs {
  static instances: FakeWs[] = [];
  static readonly OPEN = 1;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeWs.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { /* test double */ }
  /** The handshake finishes. */
  open(): void { this.readyState = FakeWs.OPEN; this.onopen?.(); }
  ops(): string[] { return this.sent.map((s) => String(JSON.parse(s).op)); }
}

const handlers = (): NetHandlers => ({ onSnapshot() {}, onEvent() {}, onFrame() {}, onReplay() {}, onStatus() {} });

const realWs = globalThis.WebSocket;
function withFakeWs(): void { (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWs; FakeWs.instances = []; }
afterEach(() => { (globalThis as unknown as { WebSocket: unknown }).WebSocket = realWs; });

describe('Net replay requests', () => {
  it('delivers a replay asked for while the socket is still connecting (the ?replay= deep link)', () => {
    withFakeWs();
    const net = new Net('ws://127.0.0.1:7521', 'tok', handlers());
    net.connect();
    const ws = FakeWs.instances[0];
    expect(ws.readyState).not.toBe(FakeWs.OPEN); // the deep link fires before the handshake finishes
    net.replay('2026-09-11T00:00:00.000Z', '2026-09-11T23:59:59.999Z', 0);
    expect(ws.ops()).not.toContain('replay'); // nothing can be sent yet…
    ws.open();
    expect(ws.ops()).toEqual(['snapshot', 'replay']); // …but it must not be lost: replay follows the snapshot
    const msg = JSON.parse(ws.sent[1]) as { from: string; to: string; cursor: number };
    expect(msg).toMatchObject({ from: '2026-09-11T00:00:00.000Z', to: '2026-09-11T23:59:59.999Z', cursor: 0 });
    net.close();
  });

  it('sends a replay straight away on an open socket and never re-sends it on a later open', () => {
    withFakeWs();
    const net = new Net('ws://127.0.0.1:7521', 'tok', handlers());
    net.connect();
    const ws = FakeWs.instances[0];
    ws.open();
    expect(net.replay('2026-09-11T00:00:00.000Z')).toBe(true);
    expect(ws.ops()).toEqual(['snapshot', 'replay']);
    ws.open(); // a reconnect must not replay the same range twice (the viewer concatenates pages)
    expect(ws.ops()).toEqual(['snapshot', 'replay', 'snapshot']);
    net.close();
  });
});

/** SP8: the two new ops the office speaks — the owner's decision, and one conversation. */
describe('Net decide and conversation.get', () => {
  it('encodes a decision with only the fields the daemon validates', () => {
    withFakeWs();
    const net = new Net('ws://127.0.0.1:7521', 'tok', handlers());
    net.connect();
    const ws = FakeWs.instances[0];
    ws.open();
    expect(net.decide('p1', { approved: true })).toBe(true);
    expect(net.decide('p2', { approved: false, chosen: 2, comment: 'not this cycle' })).toBe(true);
    const sent = ws.sent.slice(1).map((x) => JSON.parse(x) as Record<string, unknown>);
    expect(sent[0]).toEqual({ op: 'decide', id: 'p1', approved: true });   // no empty chosen/comment keys
    expect(sent[1]).toEqual({ op: 'decide', id: 'p2', approved: false, chosen: 2, comment: 'not this cycle' });
    net.close();
  });

  it('reports a decision that could not be sent rather than pretending it went', () => {
    withFakeWs();
    const net = new Net('ws://127.0.0.1:7521', 'tok', handlers());
    net.connect();                                            // still connecting: nothing may be sent
    expect(net.decide('p1', { approved: true })).toBe(false);
    expect(net.conversation('dm:owner-ceo')).toBe(false);
    net.close();
  });

  /**
   * W6-13. `layout.changed` is an op of its own, not an `event` — the daemon broadcasts it from `layout.set`
   * and from an owner's save in Obsidian. Nothing routed it, so the live office only ever followed a hand edit
   * after a reload, and a drag the daemon refused never sprang back.
   */
  it('routes the daemon\'s layout.changed to the office', () => {
    withFakeWs();
    const seen: unknown[] = [];
    const net = new Net('ws://127.0.0.1:7521', 'tok', { ...handlers(), onLayoutChanged(layout) { seen.push(layout); } });
    net.connect();
    const ws = FakeWs.instances[0];
    ws.open();
    ws.onmessage!({ data: JSON.stringify({ op: 'layout.changed', layout: { version: 1, nodes: { cto: { x: 44, y: 8 } }, connections: [] } }) });
    expect(seen).toEqual([{ version: 1, nodes: { cto: { x: 44, y: 8 } }, connections: [] }]);
    net.close();
  });

  it('asks for one thread and decodes the ack, the turns and an error', () => {
    withFakeWs();
    const seen: string[] = [];
    let turns: { who: string; at: string | null; text: string }[] = [];
    let err: [string, string | null] | null = null;
    const net = new Net('ws://127.0.0.1:7521', 'tok', {
      ...handlers(),
      onDecideAck(id) { seen.push(`ack:${id}`); },
      onConversation(id, t) { seen.push(`conv:${id}`); turns = t; },
      onError(message, id) { err = [message, id]; },
    });
    net.connect();
    const ws = FakeWs.instances[0];
    ws.open();
    expect(net.conversation('board:m1')).toBe(true);
    expect(JSON.parse(ws.sent[1])).toEqual({ op: 'conversation.get', id: 'board:m1' });
    ws.onmessage!({ data: JSON.stringify({ op: 'decide.ack', id: 'p1' }) });
    ws.onmessage!({ data: JSON.stringify({ op: 'conversation', id: 'board:m1', turns: [{ who: 'ceo', at: '2026-09-13T09:00:00.000Z', text: 'Let us start.' }] }) });
    ws.onmessage!({ data: JSON.stringify({ op: 'error', message: 'already resolved', id: 'p1' }) });
    expect(seen).toEqual(['ack:p1', 'conv:board:m1']);
    expect(turns).toEqual([{ who: 'ceo', at: '2026-09-13T09:00:00.000Z', text: 'Let us start.' }]);
    expect(err).toEqual(['already resolved', 'p1']);
    ws.onmessage!({ data: JSON.stringify({ op: 'error', message: 'bad frame' }) });
    expect(err).toEqual(['bad frame', null]);                 // an error the daemon ties to nothing
    ws.onmessage!({ data: JSON.stringify({ op: 'conversation', id: 'x' }) });
    expect(turns).toEqual([]);                                // a reply with no turns is an empty thread, not a crash
    net.close();
  });
});
