import type { CubicleEvent, Snapshot } from './state.js';

export interface NetHandlers {
  onSnapshot(s: Snapshot): void;
  onEvent(e: CubicleEvent): void;
  onFrame(f: { streamId: string; seq: number; jpegBase64: string }): void;
  onReplay(r: { events: CubicleEvent[]; cursor: number; total: number; done: boolean; from: string; to?: string }): void;
  onStatus(connected: boolean, detail: string): void;
  onChatAck?(id: string): void;
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
  constructor(private url: string, private token: string | null, private h: NetHandlers) {}

  connect(): void {
    if (this.closed) return;
    const full = `${this.url}${this.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token ?? '')}`;
    let ws: WebSocket;
    try { ws = new WebSocket(full); } catch (err) { this.h.onStatus(false, String(err)); this.retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.backoff = 1000; this.h.onStatus(true, 'connected'); ws.send(JSON.stringify({ op: 'snapshot' })); };
    ws.onmessage = (m) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.op === 'snapshot') this.h.onSnapshot(msg as unknown as Snapshot);
      else if (msg.op === 'event') this.h.onEvent(msg as unknown as CubicleEvent);
      else if (msg.op === 'frame') this.h.onFrame(msg as unknown as { streamId: string; seq: number; jpegBase64: string });
      else if (msg.op === 'replay') this.h.onReplay(msg as unknown as { events: CubicleEvent[]; cursor: number; total: number; done: boolean; from: string; to?: string });
      else if (msg.op === 'chat.ack') this.h.onChatAck?.(String(msg.id));
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
  replay(from: string, to?: string, cursor = 0): boolean { return this.send({ op: 'replay', from, to, cursor }); }
  snapshot(): boolean { return this.send({ op: 'snapshot' }); }
  close(): void { this.closed = true; this.ws?.close(); }
}
