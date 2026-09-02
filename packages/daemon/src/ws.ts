import { WebSocketServer, WebSocket } from 'ws';
import { type Vault, listJobs, RoleFrontmatter, createProposal, nowIso, type CubicleEvent } from '@cubicle/core';
import type { Router } from '@cubicle/router';

export interface WsDeps {
  vault: Vault;
  router?: Router;
  port: number;
  host?: string;
  onChat?: (text: string) => void;
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
  const activeSessions = new Set(vault.events.query({ types: ['browser.session_started'] }).map((e) => String(e.payload.session)).filter((s) => !vault.events.query({ types: ['browser.session_ended'] }).some((e) => e.payload.session === s)));
  const pending = vault.list('00 Inbox', { ext: '.md' }).filter((r) => !r.endsWith('README.md')).filter((r) => { const n = vault.readNoteOrNull(r); return n && n.data.kind !== 'message' && n.data.approved === null; }).length;
  return {
    op: 'snapshot', at: nowIso(), roles, jobs: listJobs(vault),
    surfaces: sessions.map((s) => ({ streamKind: 'browser', streamId: s.session_id, lastFrame: s.path, active: activeSessions.has(s.session_id) })),
    quota: router?.quotaSnapshot() ?? [],
    latestRun: latest ? { path: latest, body: vault.readText(latest) } : null,
    plan: vault.readTextOrNull('Plans/plan.md') ?? '',
    pendingProposals: pending,
  };
}

/** WebSocket server: snapshot on connect, live event broadcast, replay ranges, cabin chat. */
export class WsServer {
  private wss: WebSocketServer | null = null;
  private off: (() => void) | null = null;

  constructor(private deps: WsDeps) {}

  async start(): Promise<number> {
    const wss = new WebSocketServer({ port: this.deps.port, host: this.deps.host ?? '127.0.0.1' });
    this.wss = wss;
    await new Promise<void>((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        let msg: { op?: string; from?: string; to?: string; text?: string } = {};
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.op === 'snapshot') ws.send(JSON.stringify(buildSnapshot(this.deps.vault, this.deps.router)));
        else if (msg.op === 'replay' && msg.from) {
          const events = this.deps.vault.events.query({ from: msg.from, to: msg.to });
          ws.send(JSON.stringify({ op: 'replay', from: msg.from, to: msg.to, events }));
        } else if (msg.op === 'chat' && msg.text) {
          const { id } = createProposal(this.deps.vault, { kind: 'message', from: 'owner', to: 'ceo', title: msg.text.slice(0, 60), body: msg.text }, 'owner');
          this.deps.onChat?.(msg.text);
          ws.send(JSON.stringify({ op: 'chat.ack', id }));
        }
      });
      ws.send(JSON.stringify(buildSnapshot(this.deps.vault, this.deps.router)));
    });
    this.off = this.deps.vault.events.on('*', (e) => this.broadcast({ op: 'event', ...e }));
    const addr = wss.address();
    return typeof addr === 'object' && addr ? addr.port : this.deps.port;
  }

  broadcast(payload: unknown): void {
    if (!this.wss) return;
    const data = JSON.stringify(payload);
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
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
