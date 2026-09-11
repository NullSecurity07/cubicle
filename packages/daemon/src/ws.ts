import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { type Vault, listJobs, listInbox, parseNote, RoleFrontmatter, createProposal, nowIso, loadOrg, loadGates, gatesForRisk, wipLoad, type WipLimits, type WipStage, type JobFrontmatter, type CubicleEvent } from '@cubicle/core';
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
  /** Brand/name.md frontmatter — the office top bar. */
  brand: { name: string; tagline: string; url: string };
  /** Proposals awaiting the owner (never plain messages) — the post office list. */
  inbox: { id: string; kind: string; title: string; path: string; created: string }[];
  /** Owner ↔ CEO conversation from 00 Inbox/ message notes (oldest first) — the cabin thread. */
  chat: { ts: string; from: 'you' | 'ceo'; text: string }[];
  /**
   * `Teams/*.md` — the org chart in the Org drawer. `wip` is what the office room sign and the queue sheet read:
   * a lane whose `load` has reached its `limit` is a red tab on the sign, and the sheet groups jobs by the lane
   * `stageOf` puts them in. `limits` is `null` for a team whose note never sets `wip:` — it is not on Kanban
   * limits at all, so the sign shows its lanes but never turns one red.
   */
  teams: { id: string; name: string; lead: string; members: string[]; mission: string; room?: string; floor?: number; parent?: string; wip: { limits: WipLimits | null; load: Record<WipStage, number> } }[];
}

export function buildSnapshot(vault: Vault, router?: Router): Snapshot {
  const roles = vault.list('Roles', { ext: '.md' }).filter((r) => !r.includes('/archive/')).flatMap((rel) => {
    const n = vault.readNoteOrNull(rel); const p = n && RoleFrontmatter.safeParse(n.data);
    return p && p.success ? [{ ...p.data, path: rel }] : [];
  });
  const runs = vault.list('Runs', { ext: '.md' }).sort();
  const latest = runs.length ? runs[runs.length - 1] : null;
  const sessions = vault.db.prepare('SELECT session_id, MAX(seq) seq, MAX(path) path FROM screens GROUP BY session_id ORDER BY MAX(ts) DESC LIMIT 5').all() as { session_id: string; seq: number; path: string }[];
  // Newest window, not oldest: an ascending `limit` would freeze on the first 500 session events ever written
  // and every later browser session would read as still open.
  const ended = new Set(vault.events.query({ types: ['browser.session_ended'], limit: 500, order: 'desc' }).map((e) => String(e.payload.session)));
  const activeSessions = new Set(vault.events.query({ types: ['browser.session_started'], limit: 500, order: 'desc' }).map((e) => String(e.payload.session)).filter((s) => !ended.has(s)));
  const inbox = listInbox(vault).filter((n) => n.data.kind !== 'message' && n.data.approved === null && !n.data.resolved_at)
    .map((n) => ({ id: n.data.id, kind: n.data.kind, title: (n.body.match(/^#\s+(.+)$/m)?.[1] ?? n.data.kind).trim(), path: n.path, created: n.data.created }));
  const chat: Snapshot['chat'] = [];
  for (const n of listInbox(vault).filter((n) => n.data.kind === 'message' && n.data.from === 'owner' && n.data.to === 'ceo').slice(-40)) {
    const [ask, reply] = n.body.split(/^## CEO\s*$/m);
    const text = ask.replace(/^#\s.*$/m, '').trim();
    if (text) chat.push({ ts: n.data.created, from: 'you', text });
    if (reply?.trim()) chat.push({ ts: n.data.created, from: 'ceo', text: reply.trim() });
  }
  const brandNote = parseNote(vault.readTextOrNull('Brand/name.md') ?? '').data as Record<string, unknown>;
  const brand = { name: String(brandNote.name ?? ''), tagline: String(brandNote.tagline ?? ''), url: String(brandNote.url ?? '') };
  const org = loadOrg(vault);
  const gates = loadGates();
  const chainFor = (j: JobFrontmatter) => gatesForRisk(gates, j.type, j.risk);
  const teams = Object.values(org.teams).map((t) => ({ id: t.id, name: t.name, lead: t.lead, members: t.members, mission: t.mission, room: t.room, floor: t.floor, parent: t.parent, wip: { limits: t.wip ?? null, load: wipLoad(vault, t.id, chainFor) } }));
  return {
    op: 'snapshot', at: nowIso(), roles, jobs: listJobs(vault),
    surfaces: sessions.map((s) => ({ streamKind: 'browser', streamId: s.session_id, lastFrame: s.path, active: activeSessions.has(s.session_id) })),
    quota: router?.quotaSnapshot() ?? [],
    latestRun: latest ? { path: latest, body: vault.readTextOrNull(latest) ?? '' } : null,
    plan: vault.readTextOrNull('Plans/plan.md') ?? '',
    pendingProposals: inbox.length,
    brand, inbox, chat, teams,
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
    if (!origin) return true; // non-browser client (CLI, tests); browsers always send an Origin ("null" from sandboxed frames is refused)
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

  clientCount(): number { return this.wss?.clients.size ?? 0; }

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
