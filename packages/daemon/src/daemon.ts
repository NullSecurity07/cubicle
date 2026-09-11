import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Vault, VaultWatcher, listJobs, readJob, updateJob, nowIso, HEARTBEAT_WAKE_AREAS, listInbox, migrateOrg, templateDir, placeholderLogo, atomicWriteSync, BRAND_LOGO } from '@cubicle/core';
import { loadProvidersConfig, QuotaTracker, Router, embedTexts, renderQuotaMarkdown } from '@cubicle/router';
import { loadToolsConfig, ToolRegistry, phase3Tools, phase5Tools, phase6Tools, constitutionGuardrail, secretsGuardrail, browserFrames, closeAllSessions, createRoleToolClient, meetingOpen, emailInbox, analyticsPull, type AnyTool, type ToolContext } from '@cubicle/tools';
import { RoleFrontmatter } from '@cubicle/core';
import { MemoryIndex, vaultScheduler, type Llm, type Guardrail } from '@cubicle/harness';
import type { DaemonConfig } from './config.js';
import { WorkerPool } from './workers.js';
import { dispatchProposals } from './dispatcher.js';
import { WsServer } from './ws.js';
import { createHeartbeatJob, NON_WORK_TYPES, type HeartbeatDeps } from './heartbeat.js';
import { writeQueueMd } from './queue-md.js';
import { watchSleep, onProcessSignals, type SleepWatcher } from './signals.js';
import { captureResearchDeliveries, enqueueExperimentReviews, maybeEnqueueCharterCompression, maybeEnqueueIntelligence, collectOwnerFeedback, collectOfflineOwnerComments, feedbackFor, maybeEnqueuePostmortem, maybeEnqueueWeeklyReview } from './evolution.js';
import { hasIdea } from './first-run.js';
import { StaticServer } from './static.js';
import { pruneScreens } from '@cubicle/tools';

export interface DaemonOverrides {
  llm?: Llm;
  extraTools?: AnyTool[];
  guardrails?: Guardrail[];
  heartbeatHooks?: Partial<Pick<HeartbeatDeps, 'pollInbox' | 'pullAnalytics' | 'openMeeting' | 'noCloudKeys'>>;
  disableWs?: boolean;
  disableSleepWatch?: boolean;
  memory?: boolean;
  log?: (msg: string) => void;
  /** Tests set false and close the vault themselves. */
  closeDbOnStop?: boolean;
}

export interface DaemonInfo { pid: number; port: number | null; started: string; vault: string; token?: string }

export function daemonInfoPath(vaultPath: string): string {
  return path.join(vaultPath, '.cubicle', 'daemon.json');
}

export function readDaemonInfo(vaultPath: string): DaemonInfo | null {
  const p = daemonInfoPath(vaultPath);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  // Linux: a zombie answers kill(0) but is dead; and a reused pid must still look like a cubicle daemon.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    if (state === 'Z' || state === 'X') return false;
  } catch { /* not linux or gone */ }
  try { const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); return cmd.length === 0 ? false : /cubicle|daemon|tsx|node/.test(cmd); } catch { return true; }
}

/**
 * The daemon: vault + router + tools + workers + heartbeat trigger + dispatcher + watcher + WS.
 * Everything it does is resumable from the vault; `stop()` checkpoints and exits within `shutdownMs`.
 */
export class Daemon {
  vault!: Vault;
  router!: Router;
  registry!: ToolRegistry;
  workers!: WorkerPool;
  ws: WsServer | null = null;
  web: StaticServer | null = null;
  memory: MemoryIndex | null = null;
  private watcher: VaultWatcher | null = null;
  private sleepWatcher: SleepWatcher | null = null;
  private tick: NodeJS.Timeout | null = null;
  private offSignals: (() => void) | null = null;
  private offEvents: (() => void)[] = [];
  private stopping = false;
  private log: (m: string) => void;
  private jobsDoneSinceHeartbeat = 0;
  private heartbeatRequested: string | null = null;
  private startedAt = new Date();
  private lastPrune = 0;
  private guardrails: import('@cubicle/harness').Guardrail[] = [];
  private openMeeting: (agenda: string, participants?: string[]) => Promise<string | null> = async () => null;

  constructor(public readonly config: DaemonConfig, private overrides: DaemonOverrides = {}) {
    this.log = overrides.log ?? ((m) => console.log(`[cubicle] ${m}`));
  }

  async start(): Promise<void> {
    try { await this.startInner(); }
    catch (err) { await this.stop().catch(() => undefined); throw err; }
  }

  private async startInner(): Promise<void> {
    const cfg = this.config;
    if (!Vault.isVault(cfg.vaultPath)) throw new Error(`${cfg.vaultPath} is not a cubicle vault (run: cubicle init <path>)`);
    const info = readDaemonInfo(cfg.vaultPath);
    if (info && info.pid !== process.pid && isPidAlive(info.pid)) throw new Error(`daemon already running (pid ${info.pid})`);
    this.vault = Vault.open(cfg.vaultPath);
    const mig = migrateOrg(this.vault, templateDir());
    if (mig.changed.length) this.log(`org migrated: ${mig.changed.length} file(s) written`);
    this.ensureBrandLogo();
    const providers = loadProvidersConfig(cfg.providersPath);
    this.router = new Router(providers, new QuotaTracker(this.vault.db), { env: cfg.env, events: this.vault.events });
    // A cloud provider without its key is not an error to the router (the cascade just gets shorter) but it is
    // news to the owner: a blank .env once ran the whole company on the local model for three days with nothing
    // in the log, the brief or Metrics/quota.md saying so. One line per provider, one event for the office.
    const missingKeys = this.router.missingKeyProviders();
    for (const m of missingKeys) this.log(`provider ${m.id}: ${m.env} not set — its models are unavailable; set it in .env or the environment`);
    if (missingKeys.length) this.vault.events.emit({ type: 'daemon.warning', payload: { where: 'provider_key', providers: missingKeys } });
    // "No cloud at all" (every keyed provider is keyless) is what turns the brief's degraded-mode row from
    // "rate-limited or cooling" into "no cloud provider has an API key".
    const noCloudKeys = () => missingKeys.length > 0 && this.router.availableProviders().every((p) => p.privacy === 'local');
    const toolsConfig = loadToolsConfig(cfg.toolsPath);
    this.registry = new ToolRegistry().registerAll([...phase3Tools({ includeMock: !!cfg.env.CUBICLE_MOCK_TOOLS }), ...phase5Tools(), ...phase6Tools(), ...(this.overrides.extraTools ?? [])]);
    const llm: Llm = this.overrides.llm ?? this.router;
    if (this.overrides.memory !== false) {
      this.memory = new MemoryIndex(this.vault, (t) => embedTexts(providers, t));
      this.memory.indexAll().then((n) => n && this.log(`memory: indexed ${n} files`)).catch((e) => this.log(`memory index unavailable: ${(e as Error).message}`));
    }
    const scheduler = vaultScheduler(this.vault, 'daemon');
    const guardrails = [constitutionGuardrail(this.router), secretsGuardrail(), ...(this.overrides.guardrails ?? [])];
    this.guardrails = guardrails;
    this.openMeeting = async (agenda: string, participants?: string[]): Promise<string | null> => {
      const ceoNote = this.vault.readNoteOrNull('Roles/ceo.md');
      if (!ceoNote) return null;
      const ctx: ToolContext = { vault: this.vault, events: this.vault.events, roleId: 'ceo', role: RoleFrontmatter.parse(ceoNote.data), jobId: null, config: toolsConfig, env: cfg.env, scheduler, router: this.router, workspace: '.cubicle/workspace/meeting', now: () => new Date(), guardrails };
      const client = await createRoleToolClient([meetingOpen], ctx);
      try {
        const attendees = participants ?? this.workers.roles().map((r) => r.role).filter((r) => r !== 'ceo');
        const r = await client.call('meeting.open', { room: 'board', participants: attendees, agenda, rounds: 2 });
        return r.ok ? String((r.data as { path?: string })?.path ?? 'held') : null;
      } finally { await client.close(); }
    };
    // Heartbeat hooks run system tools as the COO/CEO without an LLM in the loop.
    const runSystemTool = async (roleId: string, tool: AnyTool, args: Record<string, unknown>) => {
      const note = this.vault.readNoteOrNull(`Roles/${roleId}.md`);
      if (!note) return null;
      const ctx: ToolContext = { vault: this.vault, events: this.vault.events, roleId, role: RoleFrontmatter.parse(note.data), jobId: null, config: toolsConfig, env: cfg.env, scheduler, router: this.router, workspace: '.cubicle/workspace/system', now: () => new Date(), guardrails };
      const client = await createRoleToolClient([tool], ctx);
      try { return await client.call(tool.name, args); } finally { await client.close(); }
    };
    const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms).unref())]);
    const pollInbox = async (): Promise<string[]> => { const r = await withTimeout(runSystemTool('coo', emailInbox, {}), 60_000, 'email.inbox'); return r?.ok ? r.text.split('\n').slice(1) : []; };
    const pullAnalytics = async (): Promise<string | null> => { const r = await withTimeout(runSystemTool('coo', analyticsPull, {}), 60_000, 'analytics.pull'); return r?.ok ? r.text : null; };
    const ownerFeedback = (roleId: string) => feedbackFor(collectOwnerFeedback(this.vault, this.vault.events.last('heartbeat.completed')?.ts), roleId).map((f) => `- (${f.source}) ${f.text}`);
    // Context compaction (spec §6): observations the prompt budget drops, and an over-long plan, are summarised
    // by the cheapest model there is — the local tier — so compaction never spends cloud quota. A failure here is
    // never fatal: the harness treats '' as "no summary" and falls back to clipping.
    const summarize = async (text: string): Promise<string> => {
      try {
        const r = await llm.chat({ tier: 'local', needsTools: false }, {
          messages: [
            { role: 'system', content: 'Summarize the following observations in ≤ 200 words, keeping file paths, ids and numbers.' },
            { role: 'user', content: text },
          ],
          maxTokens: 400,
        });
        return r.content;
      } catch { return ''; }
    };
    this.workers = new WorkerPool(this.vault, {
      harness: { llm, router: this.router, toolsConfig, registry: this.registry, scheduler, memory: this.memory ?? undefined, guardrails, env: cfg.env, ownerFeedback, summarize },
      heartbeat: { llm, router: this.router, openMeeting: this.openMeeting, pollInbox, pullAnalytics, env: cfg.env, noCloudKeys, planMaxAgeDays: cfg.planMaxAgeDays, log: this.log, ...this.overrides.heartbeatHooks },
      maxConcurrent: cfg.maxConcurrentJobs,
    });
    this.workers.on('outcome', ({ jobId, outcome }: { jobId: string; outcome: { status: string } }) => {
      if (this.stopping) return;
      if (outcome.status === 'done' || outcome.status === 'failed') {
        const j = readJob(this.vault, jobId)?.data;
        if (j && !NON_WORK_TYPES.includes(j.type)) {
          // Counted from the event log, so a restart does not forget completed work.
          const since = this.vault.events.last('heartbeat.completed')?.ts;
          const done = this.vault.events.query({ types: ['job.done', 'job.failed'], from: since }).filter((e) => e.job && !NON_WORK_TYPES.includes(readJob(this.vault, e.job)?.data.type ?? '')).length;
          if (done >= cfg.heartbeat.jobsCompletedN) this.requestHeartbeat(`${done} jobs completed`);
        }
      }
      this.workers.wake();
    });

    // Resumability: running jobs were interrupted by the previous process
    for (const j of listJobs(this.vault, { status: 'running' })) {
      updateJob(this.vault, j.id, { status: 'queued' }, 'daemon', `- ${nowIso()}: interrupted (daemon restart); resuming from step ${j.checkpoint_step}`);
      this.vault.events.emit({ type: 'job.interrupted', agent: j.assigned, job: j.id, payload: { checkpoint_step: j.checkpoint_step } });
    }

    this.watcher = new VaultWatcher(this.vault);
    await this.watcher.start();
    this.offEvents.push(this.vault.events.on('owner.edited', (e) => {
      const area = String(e.payload.area);
      if (area === '00 Inbox') void this.runTick('inbox edit');
      if (HEARTBEAT_WAKE_AREAS.includes(area)) this.requestHeartbeat(`owner edited ${e.payload.path}`);
      this.workers.wake();
    }));
    this.offEvents.push(this.vault.events.on('job.queued', () => this.workers.wake()));
    this.offEvents.push(this.vault.events.on('heartbeat.completed', () => {
      this.jobsDoneSinceHeartbeat = 0;
      const id = maybeEnqueueCharterCompression(this.vault);
      if (id) this.log(`charter compression queued: ${id}`);
      const intel = maybeEnqueueIntelligence(this.vault);
      if (intel.length) this.log(`intelligence sweeps queued: ${intel.join(', ')}`);
    }));
    this.offEvents.push(this.vault.events.on('quota.updated', () => this.writeQuotaMd()));

    if (!this.overrides.disableWs) {
      this.ws = new WsServer({ vault: this.vault, router: this.router, port: cfg.port, onChat: () => { this.requestHeartbeat('owner message'); void this.runTick('chat'); } });
      const port = await this.ws.start();
      this.log(`ws listening on ws://127.0.0.1:${port}`);
      const onFrame = (f: { session: string; seq: number; jpegBase64: string }) => { if (this.ws?.clientCount()) this.ws.frame(f.session, f.seq, f.jpegBase64); };
      browserFrames.on('frame', onFrame);
      this.offEvents.push(() => browserFrames.off('frame', onFrame));
      this.web = new StaticServer({ port: cfg.port + 1, vaultRoot: cfg.vaultPath, log: this.log, token: this.ws.token });
      const webPort = await this.web.start();
      if (webPort) this.log(`open the office: http://127.0.0.1:${webPort}/?token=${this.ws.token}`);
    }
    writeFileSync(daemonInfoPath(cfg.vaultPath), JSON.stringify({ pid: process.pid, port: this.ws ? cfg.port : null, started: nowIso(), vault: cfg.vaultPath, token: this.ws?.token } satisfies DaemonInfo, null, 2), { mode: 0o600 });
    this.offSignals = onProcessSignals((s) => { this.log(`${s} received; checkpointing`); void this.stop().then(() => process.exit(0)); });
    if (!this.overrides.disableSleepWatch) {
      // Non-blocking: a hung system bus must never delay workers.
      void watchSleep(() => { this.log('sleep imminent; checkpointing'); void this.stop().then(() => process.exit(0)); }, cfg.env, this.log).then((w) => { this.sleepWatcher = w; if (this.stopping) void w?.stop(); });
    }

    this.vault.events.emit({ type: 'daemon.started', payload: { pid: process.pid, port: this.ws ? cfg.port : null, roles: this.workers.roles().map((r) => r.role) } });
    this.workers.start();
    writeQueueMd(this.vault);

    // The watcher ignores what was already on disk, so `%%cubicle: …%%` comments the owner typed while the daemon
    // was down would be lost. Sweep for them now that the owner.edited handlers are wired, so a comment left
    // overnight still wakes the heartbeat and still reaches the role it was written at.
    const offline = collectOfflineOwnerComments(this.vault);
    if (offline.length) this.log(`owner comments found in ${offline.length} file(s) edited while the daemon was off`);

    // Startup trigger: away ≥ 1 h, or never run
    const last = this.vault.events.last('heartbeat.completed');
    const away = last ? (Date.now() - Date.parse(last.ts)) / 3600_000 : Infinity;
    if (away >= cfg.heartbeat.startupAwayHours) this.requestHeartbeat(last ? `startup after ${away.toFixed(1)} h away` : 'first start');
    this.tick = setInterval(() => void this.runTick('interval'), cfg.tickMs);
    await this.runTick('startup');
  }

  /**
   * Spec §11 names `Brand/logo.png` and the Engineer's charter tells it to use one, but vaults scaffolded before
   * the logo existed have none. Draw the same placeholder `cubicle init` draws — never over an existing file, so
   * the owner's own logo is safe, and flagged `generated` so the viewer does not read it as owner churn.
   *
   * Written with the low-level helpers rather than `vault.writeText`, which takes a string: this is a PNG, and
   * it is the same path `scaffoldVault` uses for exactly this file.
   */
  private ensureBrandLogo(): void {
    if (existsSync(this.vault.abs(BRAND_LOGO))) return;
    try {
      const png = placeholderLogo(this.vault.readTextOrNull('Brand/palette.md'));
      const sha = atomicWriteSync(this.vault.abs(BRAND_LOGO), png);
      this.vault.recordWritten(BRAND_LOGO, sha, 'daemon');
      this.vault.events.emit({ type: 'vault.wrote', agent: 'daemon', payload: { path: BRAND_LOGO, sha, by: 'daemon', generated: true } });
      this.log(`scaffolded ${BRAND_LOGO}`);
    } catch (err) {
      this.vault.events.emit({ type: 'daemon.warning', payload: { where: 'brand-logo', message: String((err as Error).message) } });
    }
  }

  /**
   * Ask for a heartbeat; coalesced — one open heartbeat job at a time. A request while an open heartbeat has not
   * gathered yet is already covered by it.
   *
   * Nothing runs before the owner has typed an idea (spec §12): on a freshly scaffolded vault the startup
   * trigger used to plan, critique and seed a whole first cycle for a nameless company, and it wrote a job note
   * into the vault before any viewer could see the empty office (C1). The gate applies only to the very first
   * heartbeat — once one has completed the company is real, and every later trigger stands on its own.
   */
  requestHeartbeat(trigger: string): string | null {
    if (this.stopping) return null;
    if (!this.vault.events.last('heartbeat.completed') && !hasIdea(this.vault)) return null;
    const open = listJobs(this.vault, { status: ['queued', 'running', 'blocked'] }).find((j) => j.type === 'ceo.heartbeat');
    if (open) { if (open.checkpoint_step >= 1) this.heartbeatRequested = trigger; return open.id; }
    const id = createHeartbeatJob(this.vault, trigger);
    this.heartbeatRequested = null;
    this.workers.wake();
    return id;
  }

  private ticking = false;
  async runTick(reason: string): Promise<void> {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      const n = await dispatchProposals({ vault: this.vault, registry: this.registry, toolsConfig: loadToolsConfig(this.config.toolsPath), scheduler: vaultScheduler(this.vault, 'daemon'), env: this.config.env, wake: () => this.workers.wake(), onRoleHired: (r) => this.workers.ensureWorker(r), onRoleFired: () => this.workers.wake(), guardrails: this.guardrails, questionWaitMs: this.config.questionWaitMs });
      if (Date.now() - this.lastPrune > 3600_000) { this.lastPrune = Date.now(); const pruned = pruneScreens(this.vault); if (pruned) this.log(`pruned ${pruned} old screencast frames`); }
      if (n) this.log(`tick(${reason}): ${n} proposal/unblock action(s)`);
      const reviews = enqueueExperimentReviews(this.vault);
      if (reviews.length) this.log(`tick(${reason}): ${reviews.length} experiment review(s) queued`);
      const captured = captureResearchDeliveries(this.vault);
      if (captured.length) this.log(`tick(${reason}): indexed ${captured.length} delivered research project(s)`);
      const pm = maybeEnqueuePostmortem(this.vault);
      if (pm) this.log(`tick(${reason}): postmortem ${pm}`);
      const wr = await maybeEnqueueWeeklyReview(this.vault, this.openMeeting);
      if (wr.length) this.log(`tick(${reason}): weekly review expanded (${wr.length} job(s))`);
      const last = this.vault.events.last('heartbeat.completed');
      const since = last ? (Date.now() - Date.parse(last.ts)) / 3600_000 : Infinity;
      const hasOpen = listJobs(this.vault, { status: ['queued', 'running', 'blocked'] }).some((j) => j.type === 'ceo.heartbeat');
      // An owner note nobody has answered (typed while the daemon was down, or missed by an older build) is a heartbeat trigger too.
      const unanswered = hasOpen ? undefined : listInbox(this.vault).find((n) => n.data.kind === 'message' && n.data.from === 'owner' && n.data.to === 'ceo' && !n.data.answered);
      if (!hasOpen && (since >= this.config.heartbeat.maxElapsedHours || this.heartbeatRequested || unanswered)) this.requestHeartbeat(this.heartbeatRequested ?? (unanswered ? `unanswered owner message ${unanswered.data.id}` : `${since.toFixed(1)} h elapsed`));
      this.workers.wake();
    } catch (err) {
      this.vault.events.emit({ type: 'daemon.warning', payload: { where: 'tick', message: String((err as Error).stack ?? err).slice(0, 500) } });
    } finally {
      this.ticking = false;
    }
  }

  private writeQuotaMd(): void {
    try { this.vault.writeText('Metrics/quota.md', renderQuotaMarkdown(this.router.quotaSnapshot()), 'daemon', { generated: true }); } catch { /* ignore */ }
  }

  /** Graceful stop: no new jobs, wait up to shutdownMs for in-flight steps, close everything. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const t0 = Date.now();
    try { this.vault?.events.emit({ type: 'daemon.stopping', payload: { active_jobs: this.workers?.activeJobs() ?? [] } }); } catch { /* vault may not be open */ }
    if (this.tick) clearInterval(this.tick);
    this.offSignals?.();
    for (const off of this.offEvents) off();
    if (this.workers) { this.workers.pause(); await Promise.race([this.workers.stop(), new Promise((r) => setTimeout(r, Math.max(500, this.config.shutdownMs - 2000)))]); }
    if (!this.vault) { this.log(`stopped in ${Date.now() - t0} ms`); return; }
    await Promise.race([closeAllSessions(this.vault.events), new Promise((r) => setTimeout(r, 1500))]);
    await this.watcher?.stop();
    await this.sleepWatcher?.stop();
    await this.ws?.stop();
    await this.web?.stop();
    try { rmSync(daemonInfoPath(this.config.vaultPath), { force: true }); } catch { /* ignore */ }
    // Keep the DB open until the process exits: a late LLM return in a worker must not throw on a closed handle.
    if (this.overrides.closeDbOnStop !== false) { setTimeout(() => { try { this.vault.close(); } catch { /* ignore */ } }, 250).unref(); }
    this.log(`stopped in ${Date.now() - t0} ms`);
  }
}
