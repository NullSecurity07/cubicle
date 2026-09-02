import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { type Vault, listJobs, RoleFrontmatter, createProposal, nowIso, type CubicleEvent } from '@cubicle/core';
import type { Router } from '@cubicle/router';

export interface WsDeps {
  vault: Vault;
  router?: Router;
  port: number;
  host?: string;
  onChat?: (text: string) => void;
  /** Shared secret; clients pass it as `?token=`. Generated when omitted and exposed via `token`. */
  token?: string;
  /** Extra allowed Origins (the viewer dev server, the Tauri app). Requests with no Origin (CLI/tests) are allowed. */
  allowedOrigins?: string[];
}

export interface Snapshot {
  op: 'snapshot';
  at: string;
  roles: (RoleFrontmatter & { path: string })[];
  jobs: ReturnType<typeof listJobs>;
  surfaces: { streamKind: string; streamId: string; lastFrame?: string; active: boolean }[];
  quota: unknown[];
  latestRun: { path: string; body: string } | null;
  plan: string;
  pendingProposals: number;
}

export function buildSnapshot(vault: Vault, router?: Router): Snapshot {
  const roles = vault.list('Roles', { ext: '.md' }).filter((r) => !r.includes('/archive/')).flatMap((rel) => {
    const n = vault.readNoteOrNull(rel); const p = n && RoleFrontmatter.safeParse(n.data);
    return p && p.success ? [{ ...p.data, path: rel }] : [];
  });
  const runs = vault.list('Runs', { ext: '.md' }).sort();
  const latest = runs.length ? runs[runs.length - 1] : null;
  const sessions = vault.db.prepare('SELECT session_id, MAX(seq) seq, MAX(path) path FROM screens GROUP BY session_id ORDER BY MAX(ts) DESC LIMIT 5').all() as { session_id: string; seq: number; path: string }[];
  const ended = new Set(vault.events.query({ types: ['browser.session_ended'], limit: 500 }).map((e) => String(e.payload.session)));
  const activeSessions = new Set(vault.events.query({ types: ['browser.session_started'], limit: 500 }).map((e) => String(e.payload.session)).filter((s) => !ended.has(s)));
  const pending = vault.list('00 Inbox', { ext: '.md' }).filter((r) => !r.endsWith('README.md')).filter((r) => { const n = vault.readNoteOrNull(r); return n && n.data.kind !== 'message' && n.data.approved === null; }).length;
  return {
    op: 'snapshot', at: nowIso(), roles, jobs: listJobs(vault),
    surfaces: sessions.map((s) => ({ streamKind: 'browser', streamId: s.session_id, lastFrame: s.path, active: activeSessions.has(s.session_id) })),
    quota: router?.quotaSnapshot() ?? [],
    latestRun: latest ? { path: latest, body: vault.readTextOrNull(latest) ?? '' } : null,
    plan: vault.readTextOrNull('Plans/plan.md') ?? '',
    pendingProposals: pending,
  };
}

/** WebSocket server: snapshot on connect, live event broadcast, replay ranges, cabin chat. */
export class WsServer {
  private wss: WebSocketServer | null = null;
  private off: (() => void) | null = null;
  readonly token: string;
  readonly rejected: string[] = [];

  constructor(private deps: WsDeps) {
    this.token = deps.token ?? randomBytes(16).toString('hex');
  }

  /** Browser pages of any origin can open localhost WebSockets; refuse them unless the origin is ours and the token matches. */
  private acceptClient(info: { origin?: string; req: { url?: string; headers: Record<string, string | string[] | undefined> } }): boolean {
    const url = new URL(info.req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? (typeof info.req.headers['x-cubicle-token'] === 'string' ? info.req.headers['x-cubicle-token'] : '');
    if (token !== this.token) { this.rejected.push(`bad token from ${info.origin ?? 'no-origin'}`); return false; }
    const origin = info.origin ?? (typeof info.req.headers.origin === 'string' ? info.req.headers.origin : undefined);
    if (!origin || origin === 'null') return true; // non-browser client (CLI, tests, Tauri without origin)
    const allowed = [...(this.deps.allowedOrigins ?? []), `http://127.0.0.1:${this.deps.port + 1}`, `http://localhost:${this.deps.port + 1}`, 'tauri://localhost', 'http://tauri.localhost'];
    if (allowed.includes(origin) || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
    this.rejected.push(`origin ${origin}`);
    return false;
  }

  async start(): Promise<number> {
    const wss = new WebSocketServer({ port: this.deps.port, host: this.deps.host ?? '127.0.0.1', verifyClient: (info: { origin?: string; req: { url?: string; headers: Record<string, string | string[] | undefined> } }) => this.acceptClient(info) });
    this.wss = wss;
    await new Promise<void>((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
    const REPLAY_MAX = 5000;
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        try {
          let msg: { op?: string; from?: string; to?: string; text?: string; cursor?: number } = {};
          try { msg = JSON.parse(String(raw).slice(0, 20_000)); } catch { return; }
          if (msg.op === 'snapshot') ws.send(JSON.stringify(buildSnapshot(this.deps.vault, this.deps.router)));
          else if (msg.op === 'replay' && msg.from) {
            const all = this.deps.vault.events.query({ from: msg.from, to: msg.to });
            const start = Math.max(0, Number(msg.cursor ?? 0));
            const events = all.slice(start, start + REPLAY_MAX);
            ws.send(JSON.stringify({ op: 'replay', from: msg.from, to: msg.to, events, cursor: start + events.length, total: all.length, done: start + events.length >= all.length }));
          } else if (msg.op === 'chat' && msg.text) {
            const text = String(msg.text).slice(0, 8000);
            const { id } = createProposal(this.deps.vault, { kind: 'message', from: 'owner', to: 'ceo', title: text.slice(0, 60), body: text }, 'owner');
            this.deps.onChat?.(text);
            ws.send(JSON.stringify({ op: 'chat.ack', id }));
          }
        } catch (err) {
          try { ws.send(JSON.stringify({ op: 'error', message: String((err as Error).message).slice(0, 200) })); } catch { /* closed */ }
        }
      });
      try { ws.send(JSON.stringify(buildSnapshot(this.deps.vault, this.deps.router))); } catch (err) { try { ws.send(JSON.stringify({ op: 'error', message: String((err as Error).message) })); } catch { /* ignore */ } }
    });
    this.off = this.deps.vault.events.on('*', (e) => this.broadcast({ op: 'event', ...e }));
    const addr = wss.address();
    return typeof addr === 'object' && addr ? addr.port : this.deps.port;
  }

  broadcast(payload: unknown): void {
    if (!this.wss) return;
    const data = JSON.stringify(payload);
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN && c.bufferedAmount < 1_000_000) c.send(data); // slow clients drop, never block
  }

  /** Push a binary-ish frame (base64 JPEG) for a browser surface. */
  frame(streamId: string, seq: number, jpegBase64: string): void {
    this.broadcast({ op: 'frame', streamId, seq, jpegBase64 });
  }

  async stop(): Promise<void> {
    this.off?.(); this.off = null;
    const wss = this.wss; this.wss = null;
    if (!wss) return;
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
}
export type { CubicleEvent };
