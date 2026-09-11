import { EventEmitter } from 'node:events';
import { type Vault, listJobs, readJob, updateJob, RoleFrontmatter, nowIso, loadOrg, loadGates, gatesForRisk, wipLoad, type JobFrontmatter } from '@cubicle/core';
import { runJob, type HarnessDeps, type JobOutcome } from '@cubicle/harness';
import { runHeartbeat, type HeartbeatDeps, type HeartbeatOutcome } from './heartbeat.js';

export interface WorkerPoolOptions {
  harness: Omit<HarnessDeps, 'vault'>;
  heartbeat: Omit<HeartbeatDeps, 'vault'>;
  maxConcurrent: number;
  idleMs?: number;
}

/** One WIP warning per team per window: a worker loops every idle interval and would otherwise flood the log. */
export const WIP_WARN_MS = 300_000;

/**
 * One worker per active role. Each worker picks the next runnable job for its role and runs it to an
 * outcome. Workers are interruptible: `pause()` stops them from starting new jobs; in-flight jobs are
 * already checkpointed after every tool step, so the process may exit at any time.
 */
export class WorkerPool extends EventEmitter {
  private running = new Map<string, Promise<void>>();
  private active = new Set<string>(); // job ids in flight
  private paused = false;
  private stopped = false;
  private wakeResolvers: (() => void)[] = [];
  private wipWarned = new Map<string, number>();

  constructor(private vault: Vault, private opts: WorkerPoolOptions) { super(); }

  roles(): RoleFrontmatter[] {
    return this.vault.list('Roles', { ext: '.md' }).filter((r) => !r.includes('/archive/')).flatMap((rel) => {
      const note = this.vault.readNoteOrNull(rel);
      const p = note && RoleFrontmatter.safeParse(note.data);
      return p && p.success && p.data.active ? [p.data] : [];
    });
  }

  start(): void {
    this.stopped = false; this.paused = false;
    for (const role of this.roles()) this.ensureWorker(role.role);
  }

  ensureWorker(roleId: string): void {
    if (this.running.has(roleId)) return;
    const p = this.loop(roleId).catch((err) => { this.vault.events.emit({ type: 'daemon.warning', payload: { where: `worker:${roleId}`, message: String((err as Error).stack ?? err) } }); }).finally(() => this.running.delete(roleId));
    this.running.set(roleId, p);
  }

  wake(): void {
    const rs = this.wakeResolvers; this.wakeResolvers = [];
    for (const r of rs) r();
  }

  pause(): void { this.paused = true; this.wake(); }
  resume(): void { this.paused = false; this.wake(); }

  async stop(): Promise<void> {
    this.stopped = true; this.paused = true; this.wake();
    await Promise.allSettled([...this.running.values()]);
  }

  activeJobs(): string[] { return [...this.active]; }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.wakeResolvers = this.wakeResolvers.filter((r) => r !== done); resolve(); }, ms);
      const done = () => { clearTimeout(t); resolve(); };
      this.wakeResolvers.push(done);
    });
  }

  /**
   * Next runnable job for a role: only `queued` jobs (interrupted `running` ones are re-queued by the daemon at
   * startup; `blocked` ones by the dispatcher), dependencies done, priority then age — and only while the job's
   * team is under its `in_progress` WIP limit.
   *
   * Only the in_progress lane gates *starting* work (operating model §7): review and testing are full because
   * someone else has to act, and refusing to start anything until a reviewer catches up would idle the room
   * rather than keep work flowing. A full lane is still reported, so the brief and the room sign can say why the
   * queue is not moving.
   */
  nextJob(roleId: string): string | null {
    const all = listJobs(this.vault);
    const byId = new Map(all.map((j) => [j.id, j]));
    const org = loadOrg(this.vault);
    const gates = loadGates();
    const chainFor = (j: JobFrontmatter) => gatesForRisk(gates, j.type, j.risk);
    const loads = new Map<string, ReturnType<typeof wipLoad>>();
    for (const j of all) {
      if (j.assigned !== roleId || j.status !== 'queued' || this.active.has(j.id)) continue;
      if (j.depends_on.some((d) => byId.get(d)?.status !== 'done')) continue;
      const team = j.team;
      if (!team || !org.teams[team]) return j.id;                   // no team, no limit to apply
      const limit = org.teams[team].wip.in_progress;
      if (!loads.has(team)) loads.set(team, wipLoad(this.vault, team, chainFor));
      const load = loads.get(team)!;
      if (load.in_progress < limit) return j.id;
      const last = this.wipWarned.get(team) ?? 0;
      if (Date.now() - last >= WIP_WARN_MS) {
        this.wipWarned.set(team, Date.now());
        this.vault.events.emit({ type: 'daemon.warning', agent: roleId, job: j.id, payload: { where: 'wip', team, stage: 'in_progress', limit, load, message: `${team} is at its in_progress WIP limit (${load.in_progress}/${limit}); ${j.id} waits. Finish or return something before starting more (operating model §7).` } });
      }
    }
    return null;
  }

  private roleActive(roleId: string): boolean {
    const n = this.vault.readNoteOrNull(`Roles/${roleId}.md`);
    const p = n && RoleFrontmatter.safeParse(n.data);
    return !!(p && p.success && p.data.active);
  }

  private async loop(roleId: string): Promise<void> {
    while (!this.stopped) {
      if (!this.roleActive(roleId)) { this.emit('worker.exit', { roleId }); return; } // fired or archived
      if (this.paused || this.active.size >= this.opts.maxConcurrent) { await this.sleep(1000); continue; }
      const jobId = this.nextJob(roleId);
      if (!jobId) { await this.sleep(this.opts.idleMs ?? 15_000); continue; }
      this.active.add(jobId);
      try {
        const job = readJob(this.vault, jobId)!.data;
        let outcome: JobOutcome | HeartbeatOutcome;
        if (job.type === 'ceo.heartbeat') outcome = await runHeartbeat({ vault: this.vault, ...this.opts.heartbeat }, jobId);
        else outcome = await runJob({ vault: this.vault, ...this.opts.harness }, jobId);
        this.emit('outcome', { jobId, roleId, outcome });
      } catch (err) {
        const msg = String((err as Error).stack ?? err);
        this.vault.events.emit({ type: 'daemon.warning', agent: roleId, job: jobId, payload: { where: 'runJob', message: msg.slice(0, 500) } });
        try { updateJob(this.vault, jobId, { status: 'failed' }, 'daemon', `- ${nowIso()}: crashed: ${msg.slice(0, 200)}`); } catch { /* ignore */ }
      } finally {
        this.active.delete(jobId);
      }
      await this.sleep(250);
    }
  }
}
