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
