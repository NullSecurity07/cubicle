import { describe, it, expect, afterEach } from 'vitest';
import { Net, type NetHandlers } from './net.js';
import { Edits } from './world/editing.js';
import { emptyLayout, type CampusLayout, type LayoutNode } from './world/layout.js';

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

/**
 * W6-15: the owner puts five things down in a second, and the daemon's answers arrive late.
 *
 * Every `layout.set` is the whole floor, and the daemon echoes each one back to the sender as `layout.changed`.
 * So the echo of the first drop is a floor with only the first thing on it, and it lands *after* the owner has
 * drawn four more. Applied, it rewinds those four — and the sixth gesture, a line between two things, is then
 * built on that rewound floor and sent, which takes the four off the office for real. The office-shot's wired
 * campus lost exactly the middle three that way: the first drop and the last survived and nothing else did.
 *
 * The office here is the real `Edits` stack — the same one `view.ts` holds — so what is under test is the thing
 * that actually breaks: what the *next* edit is built on.
 */
describe('the office floor with several writes in flight (W6-15)', () => {
  const RESOURCES: [string, LayoutNode][] = [
    ['browser_1', { kind: 'browser', x: 18, y: 15 }],
    ['doc_1', { kind: 'doc', x: 21.5, y: 13.5, path: 'Plans/plan.md', label: 'Plan' }],
    ['note_1', { kind: 'note', x: 24, y: 13.5, body: 'Ask the CFO about runway' }],
    ['site_1', { kind: 'site', x: 19, y: 16.5 }],
    ['station_deploy', { kind: 'station', x: 23, y: 16.5, tool: 'deploy' }],
  ];

  /** One `layout.set` off the wire, as the daemon would echo it back: this floor, stamped as it was sent. */
  const echoOf = (raw: string): string => {
    const m = JSON.parse(raw) as { nodes: Record<string, LayoutNode>; connections: unknown[]; origin: string; seq: number };
    return JSON.stringify({ op: 'layout.changed', layout: { version: 1, nodes: m.nodes, connections: m.connections }, origin: m.origin, seq: m.seq });
  };

  /** An office wired to a fake socket: the floor it holds, the sets it sent, and the socket to feed echoes to. */
  function office(): { edits: Edits; net: Net; ws: FakeWs; put: (id: string, node: LayoutNode) => void } {
    withFakeWs();
    const edits = new Edits(emptyLayout());
    const net = new Net('ws://127.0.0.1:7521', 'tok', {
      ...handlers(),
      onLayoutChanged(layout) { edits.accept(layout as CampusLayout); },
    });
    net.connect();
    const ws = FakeWs.instances[0];
    ws.open();
    const put = (id: string, node: LayoutNode): void => {
      const send = edits.apply({ layout: { ...edits.layout, nodes: { ...edits.layout.nodes, [id]: node } }, said: '' });
      net.layout(send.nodes as Record<string, unknown>, send.connections);
    };
    return { edits, net, ws, put };
  }

  it('stamps every layout.set with this window and a number that only goes up', () => {
    const { net, ws, put } = office();
    for (const [id, node] of RESOURCES) put(id, node);
    const sets = ws.sent.slice(1).map((s) => JSON.parse(s) as { op: string; origin: string; seq: number });
    expect(sets.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(sets.map((s) => s.origin))).toEqual(new Set([net.origin]));
    net.close();
  });

  it('keeps all five when the echoes land late, and builds the next edit on the whole floor', () => {
    const { edits, net, ws, put } = office();
    for (const [id, node] of RESOURCES) put(id, node);
    const echoes = ws.sent.slice(1).map(echoOf);

    // The first answer comes back now — a floor with one thing on it, four gestures out of date.
    ws.onmessage!({ data: echoes[0] });
    expect(Object.keys(edits.layout.nodes)).toEqual(RESOURCES.map(([id]) => id));

    // The sixth gesture: the owner draws a line. What it sends is the floor the office is holding, and that is
    // the write that used to delete the middle three.
    const send = edits.apply({ layout: { ...edits.layout, connections: [{ from: 'dev_manager', to: 'doc_1', kind: 'access' }] }, said: '' });
    net.layout(send.nodes as Record<string, unknown>, send.connections);
    const line = JSON.parse(ws.sent.at(-1)!) as { nodes: Record<string, LayoutNode>; seq: number };
    expect(Object.keys(line.nodes)).toEqual(RESOURCES.map(([id]) => id));
    expect(line.seq).toBe(6);

    // The rest of the backlog drains. None of it is news, so none of it rewinds anything.
    for (const e of echoes.slice(1)) ws.onmessage!({ data: e });
    expect(Object.keys(edits.layout.nodes)).toEqual(RESOURCES.map(([id]) => id));
    expect(edits.layout.connections).toEqual([{ from: 'dev_manager', to: 'doc_1', kind: 'access' }]);
    net.close();
  });

  it('applies the newest of its own echoes, so a refused drop still springs back', () => {
    const seen: CampusLayout[] = [];
    const dropped: { line: string; reason: string }[][] = [];
    withFakeWs();
    const net = new Net('ws://127.0.0.1:7521', 'tok', {
      ...handlers(),
      onLayoutChanged(layout) { seen.push(layout as CampusLayout); },
      onLayoutAck(d) { dropped.push(d); },
    });
    net.connect();
    const ws = FakeWs.instances[0];
    ws.open();
    net.layout({ cto: { x: 44, y: 8 } }, []);
    net.layout({ cto: { x: 0, y: 0 } }, []);                   // a drag into a wall, sent before the first is answered
    // The stale answer says nothing; the latest one carries the refusal and the floor to spring back to.
    ws.onmessage!({ data: JSON.stringify({ op: 'layout.ack', dropped: [], origin: net.origin, seq: 1 }) });
    ws.onmessage!({ data: JSON.stringify({ op: 'layout.changed', layout: { version: 1, nodes: { cto: { x: 44, y: 8 } }, connections: [] }, origin: net.origin, seq: 1 }) });
    expect(seen).toEqual([]);
    expect(dropped).toEqual([]);
    ws.onmessage!({ data: JSON.stringify({ op: 'layout.ack', dropped: [{ line: 'nodes.cto', reason: 'that spot is taken' }], origin: net.origin, seq: 2 }) });
    ws.onmessage!({ data: JSON.stringify({ op: 'layout.changed', layout: { version: 1, nodes: { cto: { x: 44, y: 8 } }, connections: [] }, origin: net.origin, seq: 2 }) });
    expect(dropped).toEqual([[{ line: 'nodes.cto', reason: 'that spot is taken' }]]);
    expect(seen).toEqual([{ version: 1, nodes: { cto: { x: 44, y: 8 } }, connections: [] }]);
    net.close();
  });

  it('always applies a floor that is somebody else\'s — another window, or a save in Obsidian', () => {
    const seen: CampusLayout[] = [];
    withFakeWs();
    const net = new Net('ws://127.0.0.1:7521', 'tok', { ...handlers(), onLayoutChanged(layout) { seen.push(layout as CampusLayout); } });
    net.connect();
    const ws = FakeWs.instances[0];
    ws.open();
    net.layout({ cto: { x: 44, y: 8 } }, []);
    net.layout({ cto: { x: 9, y: 6 } }, []);
    const other = { version: 1, nodes: { cto: { x: 1, y: 1 } }, connections: [] };
    ws.onmessage!({ data: JSON.stringify({ op: 'layout.changed', layout: other, origin: 'office-somebody', seq: 1 }) });
    ws.onmessage!({ data: JSON.stringify({ op: 'layout.changed', layout: other }) });   // pushLayout: nobody's write
    expect(seen).toEqual([other, other]);
    net.close();
  });

  it('follows a daemon that has never heard of the stamp, exactly as before', () => {
    const seen: CampusLayout[] = [];
    withFakeWs();
    const net = new Net('ws://127.0.0.1:7521', 'tok', { ...handlers(), onLayoutChanged(layout) { seen.push(layout as CampusLayout); } });
    net.connect();
    const ws = FakeWs.instances[0];
    ws.open();
    net.layout({ cto: { x: 44, y: 8 } }, []);
    net.layout({ cto: { x: 9, y: 6 } }, []);
    const old = { version: 1, nodes: { cto: { x: 44, y: 8 } }, connections: [] };
    ws.onmessage!({ data: JSON.stringify({ op: 'layout.changed', layout: old }) });
    expect(seen).toEqual([old]);
    net.close();
  });

  it('does not count a set the socket swallowed, so the next one is still heard', () => {
    withFakeWs();
    const seen: CampusLayout[] = [];
    const net = new Net('ws://127.0.0.1:7521', 'tok', { ...handlers(), onLayoutChanged(layout) { seen.push(layout as CampusLayout); } });
    net.connect();
    const ws = FakeWs.instances[0];
    expect(net.layout({ cto: { x: 44, y: 8 } }, [])).toBe(false);   // still connecting
    ws.open();
    expect(net.layout({ cto: { x: 9, y: 6 } }, [])).toBe(true);
    expect((JSON.parse(ws.sent.at(-1)!) as { seq: number }).seq).toBe(1);
    const floor = { version: 1, nodes: { cto: { x: 9, y: 6 } }, connections: [] };
    ws.onmessage!({ data: JSON.stringify({ op: 'layout.changed', layout: floor, origin: net.origin, seq: 1 }) });
    expect(seen).toEqual([floor]);
    net.close();
  });
});
