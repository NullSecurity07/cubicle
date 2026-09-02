import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Vault, VaultWatcher, listJobs, readJob, updateJob, nowIso, HEARTBEAT_WAKE_AREAS } from '@cubicle/core';
import { loadProvidersConfig, QuotaTracker, Router, embedTexts, renderQuotaMarkdown } from '@cubicle/router';
import { loadToolsConfig, ToolRegistry, phase3Tools, type AnyTool } from '@cubicle/tools';
import { MemoryIndex, vaultScheduler, type Llm, type Guardrail } from '@cubicle/harness';
import type { DaemonConfig } from './config.js';
import { WorkerPool } from './workers.js';
import { dispatchProposals } from './dispatcher.js';
import { WsServer } from './ws.js';
import { createHeartbeatJob, type HeartbeatDeps } from './heartbeat.js';
import { writeQueueMd } from './queue-md.js';
import { watchSleep, onProcessSignals, type SleepWatcher } from './signals.js';

export interface DaemonOverrides {
  llm?: Llm;
  extraTools?: AnyTool[];
  guardrails?: Guardrail[];
  heartbeatHooks?: Partial<Pick<HeartbeatDeps, 'pollInbox' | 'pullAnalytics' | 'openMeeting'>>;
  disableWs?: boolean;
  disableSleepWatch?: boolean;
  memory?: boolean;
  log?: (msg: string) => void;
}

export interface DaemonInfo { pid: number; port: number | null; started: string; vault: string }

export function daemonInfoPath(vaultPath: string): string {
  return path.join(vaultPath, '.cubicle', 'daemon.json');
}

export function readDaemonInfo(vaultPath: string): DaemonInfo | null {
  const p = daemonInfoPath(vaultPath);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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

  constructor(public readonly config: DaemonConfig, private overrides: DaemonOverrides = {}) {
    this.log = overrides.log ?? ((m) => console.log(`[cubicle] ${m}`));
  }

  async start(): Promise<void> {
    const cfg = this.config;
    if (!Vault.isVault(cfg.vaultPath)) throw new Error(`${cfg.vaultPath} is not a cubicle vault (run: cubicle init <path>)`);
    const info = readDaemonInfo(cfg.vaultPath);
    if (info && info.pid !== process.pid && isPidAlive(info.pid)) throw new Error(`daemon already running (pid ${info.pid})`);
    this.vault = Vault.open(cfg.vaultPath);
    const providers = loadProvidersConfig(cfg.providersPath);
    this.router = new Router(providers, new QuotaTracker(this.vault.db), { env: cfg.env, events: this.vault.events });
    const toolsConfig = loadToolsConfig(cfg.toolsPath);
    this.registry = new ToolRegistry().registerAll([...phase3Tools({ includeMock: !!cfg.env.CUBICLE_MOCK_TOOLS }), ...(this.overrides.extraTools ?? [])]);
    const llm: Llm = this.overrides.llm ?? this.router;
    if (this.overrides.memory !== false) {
      this.memory = new MemoryIndex(this.vault, (t) => embedTexts(providers, t));
      this.memory.indexAll().then((n) => n && this.log(`memory: indexed ${n} files`)).catch((e) => this.log(`memory index unavailable: ${(e as Error).message}`));
    }
    const scheduler = vaultScheduler(this.vault, 'daemon');
    this.workers = new WorkerPool(this.vault, {
      harness: { llm, toolsConfig, registry: this.registry, scheduler, memory: this.memory ?? undefined, guardrails: this.overrides.guardrails, env: cfg.env },
      heartbeat: { llm, router: this.router, ...this.overrides.heartbeatHooks },
      maxConcurrent: cfg.maxConcurrentJobs,
    });
    this.workers.on('outcome', ({ jobId, outcome }: { jobId: string; outcome: { status: string } }) => {
      if (outcome.status === 'done' || outcome.status === 'failed') {
        const j = readJob(this.vault, jobId)?.data;
        if (j && j.type !== 'ceo.heartbeat') this.jobsDoneSinceHeartbeat++;
        if (this.jobsDoneSinceHeartbeat >= cfg.heartbeat.jobsCompletedN) this.requestHeartbeat(`${this.jobsDoneSinceHeartbeat} jobs completed`);
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
    this.offEvents.push(this.vault.events.on('heartbeat.completed', () => { this.jobsDoneSinceHeartbeat = 0; }));
    this.offEvents.push(this.vault.events.on('quota.updated', () => this.writeQuotaMd()));

    if (!this.overrides.disableWs) {
      this.ws = new WsServer({ vault: this.vault, router: this.router, port: cfg.port, onChat: () => { this.requestHeartbeat('owner message'); void this.runTick('chat'); } });
      const port = await this.ws.start();
      this.log(`ws listening on ws://127.0.0.1:${port}`);
    }
    writeFileSync(daemonInfoPath(cfg.vaultPath), JSON.stringify({ pid: process.pid, port: this.ws ? cfg.port : null, started: nowIso(), vault: cfg.vaultPath } satisfies DaemonInfo, null, 2));
    this.offSignals = onProcessSignals((s) => { this.log(`${s} received; checkpointing`); void this.stop().then(() => process.exit(0)); });
    if (!this.overrides.disableSleepWatch) {
      // Non-blocking: a hung system bus must never delay workers.
      void watchSleep(() => { this.log('sleep imminent; checkpointing'); void this.stop().then(() => process.exit(0)); }, cfg.env, this.log).then((w) => { this.sleepWatcher = w; if (this.stopping) void w?.stop(); });
    }

    this.vault.events.emit({ type: 'daemon.started', payload: { pid: process.pid, port: this.ws ? cfg.port : null, roles: this.workers.roles().map((r) => r.role) } });
    this.workers.start();
    writeQueueMd(this.vault);

    // Startup trigger: away ≥ 1 h, or never run
    const last = this.vault.events.last('heartbeat.completed');
    const away = last ? (Date.now() - Date.parse(last.ts)) / 3600_000 : Infinity;
    if (away >= cfg.heartbeat.startupAwayHours) this.requestHeartbeat(last ? `startup after ${away.toFixed(1)} h away` : 'first start');
    this.tick = setInterval(() => void this.runTick('interval'), cfg.tickMs);
    await this.runTick('startup');
  }

  /** Ask for a heartbeat; coalesced — one open heartbeat job at a time. */
  requestHeartbeat(trigger: string): string | null {
    if (this.stopping) return null;
    const open = listJobs(this.vault, { status: ['queued', 'running', 'blocked'] }).find((j) => j.type === 'ceo.heartbeat');
    if (open) { this.heartbeatRequested = trigger; return open.id; }
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
      const n = await dispatchProposals({ vault: this.vault, registry: this.registry, toolsConfig: loadToolsConfig(this.config.toolsPath), scheduler: vaultScheduler(this.vault, 'daemon'), env: this.config.env, wake: () => this.workers.wake() });
      if (n) this.log(`tick(${reason}): ${n} proposal/unblock action(s)`);
      const last = this.vault.events.last('heartbeat.completed');
      const since = last ? (Date.now() - Date.parse(last.ts)) / 3600_000 : Infinity;
      const hasOpen = listJobs(this.vault, { status: ['queued', 'running', 'blocked'] }).some((j) => j.type === 'ceo.heartbeat');
      if (!hasOpen && (since >= this.config.heartbeat.maxElapsedHours || this.heartbeatRequested)) this.requestHeartbeat(this.heartbeatRequested ?? `${since.toFixed(1)} h elapsed`);
      this.workers.wake();
    } catch (err) {
      this.vault.events.emit({ type: 'daemon.warning', payload: { where: 'tick', message: String((err as Error).stack ?? err).slice(0, 500) } });
    } finally {
      this.ticking = false;
    }
  }

  private writeQuotaMd(): void {
    try { this.vault.writeText('Metrics/quota.md', renderQuotaMarkdown(this.router.quotaSnapshot()), 'daemon', { silent: true }); } catch { /* ignore */ }
  }

  /** Graceful stop: no new jobs, wait up to shutdownMs for in-flight steps, close everything. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const t0 = Date.now();
    this.vault.events.emit({ type: 'daemon.stopping', payload: { active_jobs: this.workers.activeJobs() } });
    if (this.tick) clearInterval(this.tick);
    this.offSignals?.();
    for (const off of this.offEvents) off();
    this.workers.pause();
    await Promise.race([this.workers.stop(), new Promise((r) => setTimeout(r, Math.max(500, this.config.shutdownMs - 2000)))]);
    await this.watcher?.stop();
    await this.sleepWatcher?.stop();
    await this.ws?.stop();
    try { rmSync(daemonInfoPath(this.config.vaultPath), { force: true }); } catch { /* ignore */ }
    this.vault.close();
    this.log(`stopped in ${Date.now() - t0} ms`);
  }
}
