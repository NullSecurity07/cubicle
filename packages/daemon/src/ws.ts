import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { type Vault, listJobs, listInbox, parseNote, RoleFrontmatter, createProposal, nowIso, loadOrg, loadGates, gatesForRisk, wipLoad, readLedger, moneyReport, money as moneyStr, ownerDecide, proposalOptions, decidableFor, pressureBlock, noteVerdict, needsConfirm, resolvedOutcome, listConversations, readConversation, type Decidable, type Thread, type Turn, type WipLimits, type WipStage, type JobFrontmatter, type CubicleEvent } from '@cubicle/core';
import type { Router } from '@cubicle/router';
import { budgetRows } from './money.js';

export interface WsDeps {
  vault: Vault;
  router?: Router;
  port: number;
  host?: string;
  onChat?: (text: string) => void;
  /**
   * Called after `decide` has written the owner's flags, so the dispatcher applies them **now** rather than on
   * the next interval. The watcher cannot do it: `ownerDecide` writes through the vault and records the sha, so
   * the file never reads as an outside edit — which is the whole point (the guard has to be able to tell this
   * write apart from an Obsidian save), and the cost of it is that the tick has to be asked for by hand.
   *
   * The same silence cost the company a cycle (ruling P8-14): the decision the owner takes here is also the
   * one an Obsidian save would have woken a heartbeat for, so the handler is given the note's `id` and the
   * daemon puts it through `inboxEditWakesHeartbeat` before it ticks.
   */
  onDecide?: (id: string) => void;
  /** Shared secret; clients pass it as `?token=`. Generated when omitted and exposed via `token`. */
  token?: string;
  /** Extra allowed Origins (the viewer dev server, the Tauri app). Requests with no Origin (CLI/tests) are allowed. */
  allowedOrigins?: string[];
}

/**
 * The company's money for the bank screen. Every figure appears **twice**: the integer minor units, for meters
 * and comparisons, and the string to print. The viewer has no `@cubicle/core` dependency by design, so it must
 * never format money itself — a second formatter is a second rounding rule waiting to disagree with the book.
 */
export interface MoneySnapshot {
  currency: string;
  cash_cents: number; cash: string;
  burn_cents_per_day: number; burn: string;
  runway_days: number | null; runway: string;
  dormant: boolean;
  mock_revenue_cents: number; mock_revenue: string;
  problems: number;
  budgets: { division: string; used: number; quota: number }[];
  entries: { at: string; kind: string; amount: string; mode: string; who: string; why: string }[];
}

/**
 * A ledger row's `why` on the way to the screen. `ledger.record` puts a floor under it and no ceiling, so a
 * model can put a paragraph in a drawer row; it is capped here, where the daemon formats, so the viewer keeps
 * formatting nothing. Whole words where there is a boundary, mid-word when there is not.
 */
const cutWhy = (s: string, n = 80): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const head = t.slice(0, Math.max(0, n - 1));
  const space = head.lastIndexOf(' ');
  return (space > (n - 1) / 2 ? head.slice(0, space) : head).trimEnd() + '…';
};

/**
 * How much of a proposal's body crosses the wire. A decision the owner reads on screen is a page or two; the
 * cap is here so one pathological note — a founder brief that quoted a whole research report — cannot make
 * every reconnect expensive. Past it the reader says so and "Open in Obsidian" is the rest.
 */
export const INBOX_BODY_MAX = 32 * 1024;
/** How many closed notes the *Decided* segment carries. */
export const DECIDED_ROWS = 20;

const cutBody = (s: string): string => (s.length <= INBOX_BODY_MAX ? s : `${s.slice(0, INBOX_BODY_MAX)}\n\n_…truncated; open the note in Obsidian for the rest._\n`);

export interface Snapshot {
  op: 'snapshot';
  at: string;
  roles: (RoleFrontmatter & { path: string })[];
  jobs: ReturnType<typeof listJobs>;
  surfaces: { streamKind: string; streamId: string; lastFrame?: string; active: boolean }[];
  quota: unknown[];
  /** Cash, burn, runway, the division quotas and the last few ledger rows; null if the book could not be read. */
  money: MoneySnapshot | null;
  latestRun: { path: string; body: string } | null;
  plan: string;
  pendingProposals: number;
  /** Brand/name.md frontmatter — the office top bar. */
  brand: { name: string; tagline: string; url: string };
  /**
   * Every open proposal (never a plain message) — the Decisions sheet's *Needs you* segment.
   *
   * Everything the reader needs to show the decision and everything the action bar needs to send one, so that
   * opening a row is a render and not a round trip. `body` is the note as markdown, CEO boilerplate included,
   * because the owner is deciding on what the company actually wrote; it is capped, since a founder brief with
   * a long pressure test is the one note that could otherwise put a megabyte on every reconnect.
   *
   * **Open, not undecided** (ruling P8-8). The list used to be `approved === null`, which meant a note fell out
   * of it the instant the owner decided and did not appear in `decided` until the dispatcher had resolved it —
   * a hole the reader rendered as nothing at all. For a note the dispatcher *refuses* (`refuseNote` records the
   * reason and never resolves it) that hole is permanent: the owner's decision would simply vanish from the
   * sheet. A decided-but-unresolved note keeps its row, marked `pending`, and carries the refusal when there is
   * one, so the sheet can say "applying…" and then say what went wrong.
   *
   * Whatever computes a row's `decidable`, it owes this row nothing but `core`'s own predicate: a row where
   * `boardStillSitting(note.data)` holds has no decidable state at all, and the `decide` op refuses it with
   * `BOARD_STILL_SITTING` (ruling R-T3-3) so a plain browser tab cannot decide what the office greys out.
   */
  inbox: {
    id: string; kind: string; title: string; path: string; created: string;
    from: string; job: string; target: string;
    body: string;
    /** The numbered choices, or `[]`. `n` is the number `chosen:` is matched against, never the index. */
    options: { n: number; label: string }[];
    band: string; band_reason: string; board_verdict: string;
    /** The `## Pressure test` block when the note carries one, so the argument is on screen with the button. */
    pressure: string;
    /**
     * The board's pressure-test verdict word on this note — `STRONG`, `WEAK`, `PIVOT REQUIRED` — or `''`.
     * `board_verdict` above is the pass/return of the *session*; this is what the board actually thinks of the
     * business, and the reader puts it in the action bar so the owner reads it on the same screen as the button.
     */
    verdict: string;
    /**
     * Adopting this one overrules the board, so the office asks twice (ruling W3-3): the primary button reads
     * "Adopt anyway" and sends `confirm: true`, and a `decide` without it is refused by `ownerDecide`.
     */
    needs_confirm: boolean;
    decidable: Decidable;
    /** Decided and waiting on the dispatcher. `false` for a row that still needs the owner. */
    pending: boolean;
    /** The owner's own flags, so a pending row can show what was decided. `null` while undecided. */
    approved: boolean | null;
    chosen: number | null;
    /** Why the dispatcher would not apply it — the `refused` the note carries — or null. */
    refused: string | null;
    /**
     * A `founder_brief` the board has not pressure-tested yet (ruling P8-6): the document is half-written, so it
     * is listed — the owner can see the board is sitting on it — but must not be decidable, and it is not counted
     * on the pill.
     */
    board_pending: boolean;
  }[];
  /** The last 20 notes the dispatcher closed — the Decisions sheet's *Decided* segment. */
  decided: { id: string; kind: string; title: string; path: string; created: string; resolved_at: string; approved: boolean | null; chosen: number | null; outcome: string }[];
  /** Every conversation in the vault, newest first — the Messages view's thread list. */
  conversations: Thread[];
  /** Owner ↔ CEO conversation from 00 Inbox/ message notes (oldest first) — the cabin thread. */
  chat: { ts: string; from: 'you' | 'ceo'; text: string }[];
  /**
   * `Teams/*.md` — the org chart in the Org drawer. `wip` is what the office room sign and the queue sheet read:
   * a lane whose `load` has reached its `limit` is a red tab on the sign, and the sheet groups jobs by the lane
   * `stageOf` puts them in. `limits` is `null` for a team whose note never sets `wip:` — it is not on Kanban
   * limits at all, so the sign shows its lanes but never turns one red.
   */
  teams: { id: string; name: string; lead: string; members: string[]; mission: string; room?: string; floor?: number; parent?: string; wip: { limits: WipLimits | null; load: Record<WipStage, number> } }[];
  /** The constitution's office → role map, so the viewer animates the right desks. */
  offices: Record<string, string>;
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
  const notes = listInbox(vault);
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const inbox: Snapshot['inbox'] = notes.filter((n) => n.data.kind !== 'message' && !n.data.resolved_at)
    .map((n) => {
      const d = n.data as Record<string, unknown>;
      const options = proposalOptions(n.data.kind, n.body);
      return {
        id: n.data.id, kind: n.data.kind, title: (n.body.match(/^#\s+(.+)$/m)?.[1] ?? n.data.kind).trim(), path: n.path, created: n.data.created,
        from: n.data.from, job: str(n.data.job), target: str(n.data.target),
        body: cutBody(n.body),
        options: options.map((o) => ({ n: o.n, label: o.label })),
        band: str(d.band), band_reason: str(d.band_reason), board_verdict: str(d.board_verdict),
        pressure: pressureBlock(n.body),
        // Both off the whole note, never off `cutBody`'s truncation: the verdict line is the last line of the
        // pressure test, which on a founder brief is the last section inside the fence — the first thing a cap
        // would take. A row that lost it would offer a plain "Adopt brief" over a PIVOT REQUIRED.
        verdict: noteVerdict(n.body),
        needs_confirm: needsConfirm(n.data.kind, n.body),
        decidable: decidableFor(n.data.kind, options),
        pending: n.data.approved !== null,
        approved: n.data.approved, chosen: n.data.chosen,
        refused: typeof d.refused === 'string' && d.refused ? d.refused : null,
        board_pending: d.board_pending === true,
      };
    });
  // Newest first and few: *Decided* is the owner's receipt for what their clicks did, not the archive. The
  // archive is `00 Inbox/` itself, and every row here names the note it came from.
  const decided: Snapshot['decided'] = notes.filter((n) => n.data.kind !== 'message' && !!n.data.resolved_at)
    .sort((a, b) => String(b.data.resolved_at).localeCompare(String(a.data.resolved_at)))
    .slice(0, DECIDED_ROWS)
    .map((n) => ({
      id: n.data.id, kind: n.data.kind, title: (n.body.match(/^#\s+(.+)$/m)?.[1] ?? n.data.kind).trim(), path: n.path, created: n.data.created,
      resolved_at: str(n.data.resolved_at), approved: n.data.approved, chosen: n.data.chosen,
      outcome: resolvedOutcome(n.body),
    }));
  const chat: Snapshot['chat'] = [];
  for (const n of notes.filter((n) => n.data.kind === 'message' && n.data.from === 'owner' && n.data.to === 'ceo').slice(-40)) {
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
  // One job listing for the whole snapshot: `wipLoad` used to list every job note again per team, so a
  // ten-team office paid ten full vault scans for one snapshot.
  const allJobs = listJobs(vault);
  const teams = Object.values(org.teams).map((t) => ({ id: t.id, name: t.name, lead: t.lead, members: t.members, mission: t.mission, room: t.room, floor: t.floor, parent: t.parent, wip: { limits: t.wip ?? null, load: wipLoad(vault, t.id, chainFor, allJobs) } }));
  // A book that cannot be read must cost the owner the bank screen's money block and nothing else: the office
  // still opens, the queue still renders, and the brief is where the complaint about the file belongs.
  let money: MoneySnapshot | null = null;
  try {
    const ledger = readLedger(vault);
    const now = new Date();
    const r = moneyReport(ledger, now);
    money = {
      currency: r.currency,
      cash_cents: r.cashCents, cash: moneyStr(r.cashCents, r.currency),
      burn_cents_per_day: r.burnCentsPerDay, burn: moneyStr(r.burnCentsPerDay, r.currency),
      runway_days: r.runwayDays, runway: r.runwayDays === null ? 'not spending' : `${r.runwayDays} day${r.runwayDays === 1 ? '' : 's'}`,
      dormant: r.dormant,
      mock_revenue_cents: r.mockRevenueCents, mock_revenue: moneyStr(r.mockRevenueCents, r.currency),
      problems: r.problems.length,
      budgets: router ? budgetRows(vault, org, router.config, now) : [],
      // Newest first, and few: the bank screen is a gauge, not the book. The book is one click away in Obsidian.
      entries: ledger.entries.slice(-6).reverse().map((e) => ({ at: e.at, kind: e.kind, amount: moneyStr(e.cents, r.currency), mode: e.mode, who: e.who, why: cutWhy(e.why) })),
    };
  } catch { money = null; }
  return {
    op: 'snapshot', at: nowIso(), roles, jobs: allJobs, money,
    surfaces: sessions.map((s) => ({ streamKind: 'browser', streamId: s.session_id, lastFrame: s.path, active: activeSessions.has(s.session_id) })),
    quota: router?.quotaSnapshot() ?? [],
    latestRun: latest ? { path: latest, body: vault.readTextOrNull(latest) ?? '' } : null,
    plan: vault.readTextOrNull('Plans/plan.md') ?? '',
    // The pill is "N to approve", so it counts what still needs the owner — never a row that is only waiting
    // on the dispatcher. A decided note is off the owner's plate whatever the sheet still shows of it.
    pendingProposals: inbox.filter((r) => !r.pending && !r.board_pending).length,
    brand, inbox, decided, chat, teams, offices: org.offices ?? {},
    conversations: listConversations(vault),
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
          let msg: { op?: string; from?: string; to?: string; text?: string; cursor?: number; id?: unknown; approved?: unknown; chosen?: unknown; comment?: unknown; confirm?: unknown } = {};
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
          } else if (msg.op === 'decide') {
            // Malformed known ops answer; unknown ops are still ignored. A `decide` the daemon cannot parse is
            // the office asking for something, and silence there is a button that does nothing.
            //
            // **Every one of these answers names the note** (review I4). The viewer routes an error to the
            // reader it belongs to by `id`, and with no id it falls back to the first pending decision — so two
            // decisions in flight and the wrong reader shows the refusal. `id` is null only when the message
            // did not carry a usable one, which is the one case there is no note to name.
            const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
            const refuse = (message: string) => ws.send(JSON.stringify({ op: 'error', id, message }));
            if (!id || typeof msg.approved !== 'boolean') {
              refuse('decide needs id (string) and approved (boolean)');
            } else if (msg.chosen !== undefined && msg.chosen !== null && typeof msg.chosen !== 'number') {
              refuse('decide: chosen must be a number');
            } else if (msg.comment !== undefined && typeof msg.comment !== 'string') {
              refuse('decide: comment must be a string');
            } else if (msg.confirm !== undefined && typeof msg.confirm !== 'boolean') {
              refuse('decide: confirm must be a boolean');
            } else {
              try {
                // `confirm` is the owner saying yes over the board's verdict (ruling W3-3). It is passed straight
                // through and never defaulted: `ownerDecide` is the one place that decides whether this note needs
                // it, so a client that forgets it gets the refusal that names the verdict rather than a silent yes.
                ownerDecide(this.deps.vault, id, { approved: msg.approved, chosen: msg.chosen as number | null | undefined, comment: msg.comment as string | undefined, confirm: msg.confirm as boolean | undefined });
              } catch (err) {
                refuse(String((err as Error).message).slice(0, 200));
                return;
              }
              // Acknowledge first, tick second: the reader goes to "applying…" on the ack, and a dispatcher pass
              // that takes a second must not be what the owner is waiting on before the button responds.
              ws.send(JSON.stringify({ op: 'decide.ack', id }));
              this.deps.onDecide?.(id);
            }
          } else if (msg.op === 'conversation.get') {
            if (typeof msg.id !== 'string' || !msg.id) ws.send(JSON.stringify({ op: 'error', message: 'conversation.get needs id (string)' }));
            else {
              const turns: Turn[] = readConversation(this.deps.vault, msg.id);
              ws.send(JSON.stringify({ op: 'conversation', id: msg.id, turns }));
            }
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
