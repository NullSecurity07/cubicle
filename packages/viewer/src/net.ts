import type { CubicleEvent, Snapshot, ThreadTurn } from './state.js';

export interface NetHandlers {
  onSnapshot(s: Snapshot): void;
  onEvent(e: CubicleEvent): void;
  onFrame(f: { streamId: string; seq: number; jpegBase64: string }): void;
  onReplay(r: { events: CubicleEvent[]; cursor: number; total: number; done: boolean; from: string; to?: string }): void;
  onStatus(connected: boolean, detail: string): void;
  onChatAck?(id: string): void;
  /** the daemon has written the owner's decision and is applying it (SP8 §1) */
  onDecideAck?(id: string): void;
  /** one thread's turns, in full (SP8 §2) */
  onConversation?(id: string, turns: ThreadTurn[]): void;
  /** an `error` reply: `id` is the decision it refused, where the daemon named one */
  onError?(message: string, id: string | null): void;
  /**
   * The daemon's reply to a `layout.set` (SP9b): the lines it would not take, each with the reason. An empty
   * list is a clean write. A daemon that has never heard of `layout.set` simply never sends this, which is why
   * the viewer keeps what it drew rather than waiting for an acknowledgement that is not coming.
   *
   * `sentence` and `kept` are ruling W6-2: what the line was left at, and the one sentence that says so — the
   * same one the note's "Couldn't apply" section carries. The floor that came back is in `layout.changed`.
   */
  onLayoutAck?(dropped: { line: string; reason: string; sentence?: string; kept?: string }[]): void;
  /**
   * The daemon filed the dock's hire (SP9b): `id` is the proposal the owner now decides in Decisions. The desk
   * stays a ghost until they do — a hire is the owner's, not the office's.
   */
  onHireAck?(id: string): void;
  /**
   * The office moved, and the daemon is telling every open one (SP9b, ruling W6-13). It follows a `layout.set`
   * from any window and a save of `Office/campus.md` in Obsidian, and it is the daemon's *validated* floor — so
   * it is also what springs a refused drag back. It is an op of its own, not an `event`: the floor is one note
   * as it stands, with no history to replay, so it never goes near the event stream.
   */
  onLayoutChanged?(layout: unknown): void;
}

/** Resolve the daemon WS URL + token: ?ws= & ?token= in the page URL, else defaults (daemon port 7411 next to the viewer's 7412). */
export function resolveWs(): { url: string; token: string | null } {
  const q = new URLSearchParams(location.search);
  const port = q.get('port') ?? String(Number(location.port || 7412) - 1);
  const token = q.get('token') ?? (() => { try { return localStorage.getItem('cubicle.token'); } catch { return null; } })();
  if (q.get('token')) { try { localStorage.setItem('cubicle.token', q.get('token')!); } catch { /* ignore */ } }
  return { url: q.get('ws') ?? `ws://127.0.0.1:${port}`, token };
}

/** Thin reconnecting client. The viewer is stateless: every (re)connect re-requests the snapshot. */
export class Net {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoff = 1000;
  /** A replay asked for before the socket was open (the `?replay=` deep link, a reconnect); sent once it opens. */
  private pendingReplay: Record<string, unknown> | null = null;
  constructor(private url: string, private token: string | null, private h: NetHandlers) {}

  connect(): void {
    if (this.closed) return;
    const full = `${this.url}${this.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token ?? '')}`;
    let ws: WebSocket;
    try { ws = new WebSocket(full); } catch (err) { this.h.onStatus(false, String(err)); this.retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.backoff = 1000; this.h.onStatus(true, 'connected'); ws.send(JSON.stringify({ op: 'snapshot' })); const q = this.pendingReplay; this.pendingReplay = null; if (q) this.send(q); };
    ws.onmessage = (m) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.op === 'snapshot') this.h.onSnapshot(msg as unknown as Snapshot);
      else if (msg.op === 'event') this.h.onEvent(msg as unknown as CubicleEvent);
      else if (msg.op === 'frame') this.h.onFrame(msg as unknown as { streamId: string; seq: number; jpegBase64: string });
      else if (msg.op === 'replay') this.h.onReplay(msg as unknown as { events: CubicleEvent[]; cursor: number; total: number; done: boolean; from: string; to?: string });
      else if (msg.op === 'chat.ack') this.h.onChatAck?.(String(msg.id));
      else if (msg.op === 'decide.ack') this.h.onDecideAck?.(String(msg.id));
      else if (msg.op === 'conversation') this.h.onConversation?.(String(msg.id), Array.isArray(msg.turns) ? (msg.turns as ThreadTurn[]) : []);
      else if (msg.op === 'layout.ack') this.h.onLayoutAck?.(Array.isArray(msg.dropped) ? (msg.dropped as { line: string; reason: string; sentence?: string }[]) : []);
      else if (msg.op === 'layout.changed') this.h.onLayoutChanged?.(msg.layout);
      else if (msg.op === 'hire.ack') this.h.onHireAck?.(String(msg.id));
      else if (msg.op === 'error') this.h.onError?.(String(msg.message ?? 'the daemon refused that'), msg.id === undefined ? null : String(msg.id));
    };
    ws.onclose = (ev) => { this.h.onStatus(false, ev.code === 1006 && !this.token ? 'daemon offline or token missing (open the URL printed by cubicle start)' : `disconnected (${ev.code})`); this.retry(); };
    ws.onerror = () => { /* onclose follows */ };
  }

  private retry(): void {
    if (this.closed) return;
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 1.5, 5000);
  }

  send(msg: Record<string, unknown>): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(msg)); return true; }
    return false;
  }

  chat(text: string): boolean { return this.send({ op: 'chat', text }); }
  /**
   * The owner's yes or no on one inbox note (SP8 §1). `chosen` is a 1-based option; `comment` is filed as theirs;
   * `confirm` is "yes, over the board's verdict" and is required to adopt a brief the board would not stand behind
   * (SP9 ruling W3-3) — sent only when the row says so, so a client that never sets it cannot adopt one by accident.
   */
  decide(id: string, o: { approved: boolean; chosen?: number; comment?: string; confirm?: boolean }): boolean {
    const msg: Record<string, unknown> = { op: 'decide', id, approved: o.approved };
    if (o.chosen !== undefined) msg.chosen = o.chosen;
    if (o.comment) msg.comment = o.comment;
    if (o.confirm) msg.confirm = true;
    return this.send(msg);
  }
  /** Ask for one thread's turns in full; the reply drops whatever arrived live before it (state.ts). */
  conversation(id: string): boolean { return this.send({ op: 'conversation.get', id }); }
  /** Ask for a day's events. Queued (never dropped) when the socket is still connecting, else the deep link is lost. */
  replay(from: string, to?: string, cursor = 0): boolean {
    const msg = { op: 'replay', from, to, cursor };
    if (this.send(msg)) return true;
    this.pendingReplay = msg;
    return false;
  }
  /**
   * The office as the owner has arranged it, whole (SP9b). Idempotent by contract: the viewer never sends a diff,
   * because a diff would need the two ends to agree about what had already arrived.
   */
  layout(nodes: Record<string, unknown>, connections: unknown[]): boolean { return this.send({ op: 'layout.set', nodes, connections }); }
  /** The dock's Agent flow: a desk on the floor and who should sit at it. What comes back is a proposal id. */
  hire(role: string, display: string, team: string, at?: { x: number; y: number }): boolean {
    return this.send({ op: 'hire.propose', role, display, team, ...(at ? { at } : {}) });
  }
  snapshot(): boolean { return this.send({ op: 'snapshot' }); }
  close(): void { this.closed = true; this.pendingReplay = null; this.ws?.close(); }
}
