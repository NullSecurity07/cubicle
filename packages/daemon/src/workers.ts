import { EventEmitter } from 'node:events';
import { type Vault, listJobs, readJob, updateJob, RoleFrontmatter, nowIso, loadOrg, loadGates, gatesForRisk, wipLoad, GATE_JOB_TYPES, LEDGER_PATH, type JobFrontmatter } from '@cubicle/core';
import { runJob, type HarnessDeps, type JobOutcome } from '@cubicle/harness';
import { runHeartbeat, type HeartbeatDeps, type HeartbeatOutcome } from './heartbeat.js';
import { runPantryChat } from './pantry.js';

export interface WorkerPoolOptions {
  harness: Omit<HarnessDeps, 'vault'>;
  heartbeat: Omit<HeartbeatDeps, 'vault'>;
  maxConcurrent: number;
  idleMs?: number;
  /**
   * True when the company has spent the capital the owner put in (SP4 §5). Absent means never dormant, which is
   * what every test and every unfunded company wants.
   */
  dormant?: () => boolean;
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
  private dormantWarned = 0;

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
   * team is under its `in_progress` WIP limit. A team whose note never sets `wip:` (most teams outside Dev/QA
   * today) is not opting into Kanban limits at all: `org.teams[team].wip` is `undefined` and the team is
   * unlimited, never refused.
   *
   * Only the in_progress lane gates *starting* work (operating model §7): review and testing are full because
   * someone else has to act, and refusing to start anything until a reviewer catches up would idle the room
   * rather than keep work flowing. A full lane is still reported, so the brief and the room sign can say why the
   * queue is not moving.
   *
   * Gate jobs are exempt from the limit entirely, not merely left out of the tally. `enqueueGate` gives the gate
   * job the *author's* team so the chain stays attributable, so a `team:qa.review` assigned to `qa_lead` carries
   * `team: dev`: applying Dev's limit to it meant three Dev jobs in progress could stop every QA review from
   * starting, while QA's own lanes sat empty. Work then piles up in `in_review` and the room never drains —
   * the opposite of what a WIP limit is for. `wipLoad` already skips these jobs when counting; this is the other
   * half of that rule.
   *
   * A dormant company (SP4 §5: it has spent the capital the owner put in) starts nothing here except its own
   * `ceo.heartbeat` — gate jobs included, since a gate is a model call like any other. The heartbeat is what
   * sees the owner's next `capital` row arrive, so it is the one job dormancy may never hold back.
   */
  nextJob(roleId: string): string | null {
    const all = listJobs(this.vault);
    const byId = new Map(all.map((j) => [j.id, j]));
    const org = loadOrg(this.vault);
    const gates = loadGates();
    // A company that has spent the money the owner gave it starts nothing but its own heartbeat. Reading the
    // ledger must never be able to stop work, so a check that throws is read as "not dormant": the failure mode
    // of this feature has to be a company that keeps working, never one that silently stops.
    //
    // Asked at most once per call, and only once a job is actually in hand: the check reads `Ledger/ledger.md`
    // and every worker calls `nextJob` every idle interval, so an eager read would parse the book a few times a
    // second to answer a question about a queue that is usually empty. The daemon's own hook then holds one
    // reading for a second (`DORMANCY_POLL_MS`), which is what makes a tick — which wakes every worker at once —
    // cost one parse rather than one per active role. That matters because the ledger only grows: a `cost` row
    // a day for ever, and nothing ever removes one.
    let dormantAnswer: boolean | null = null;
    const dormant = (): boolean => {
      if (dormantAnswer === null) { try { dormantAnswer = this.opts.dormant?.() ?? false; } catch { dormantAnswer = false; } }
      return dormantAnswer;
    };
    const chainFor = (j: JobFrontmatter) => gatesForRisk(gates, j.type, j.risk);
    const loads = new Map<string, ReturnType<typeof wipLoad>>();
    for (const j of all) {
      if (j.assigned !== roleId || j.status !== 'queued' || this.active.has(j.id)) continue;
      if (j.depends_on.some((d) => byId.get(d)?.status !== 'done')) continue;
      // The heartbeat is the exception and must stay one: it is what notices the capital row that revives the
      // company, and a dormancy nothing can see its way out of is just a crash with better manners.
      if (j.type !== 'ceo.heartbeat') {
        if (dormant()) { this.warnDormant(roleId, j.id); continue; }
        // Back in funds: forget the last warning, so the next dormancy says so straight away instead of going
        // quiet because the previous episode ended inside the window. The WIP gate clears its stamp the same
        // way, and for the same reason. Done here, where the answer is already in hand, so an unfunded company
        // still pays for no ledger read at all.
        this.dormantWarned = 0;
      }
      if (GATE_JOB_TYPES.includes(j.type)) return j.id;             // a gate is the reviewer's work, not the author team's
      const team = j.team;
      if (!team || !org.teams[team]) return j.id;                   // no team, no limit to apply
      const teamWip = org.teams[team].wip;
      if (!teamWip) { this.wipWarned.delete(team); return j.id; }   // no `wip:` on the team note: unlimited
      const limit = teamWip.in_progress;
      if (!loads.has(team)) loads.set(team, wipLoad(this.vault, team, chainFor, all));
      const load = loads.get(team)!;
      if (load.in_progress < limit) { this.wipWarned.delete(team); return j.id; } // back under the limit: the next full episode should warn again promptly
      const last = this.wipWarned.get(team) ?? 0;
      if (Date.now() - last >= WIP_WARN_MS) {
        this.wipWarned.set(team, Date.now());
        this.vault.events.emit({ type: 'daemon.warning', agent: roleId, job: j.id, payload: { where: 'wip', team, stage: 'in_progress', limit, load, message: `${team} is at its in_progress WIP limit (${load.in_progress}/${limit}); ${j.id} waits. Finish or return something before starting more (operating model §7).` } });
      }
    }
    return null;
  }

  /** One dormancy warning per window: every idle worker would otherwise repeat it every poll, for ever. */
  private warnDormant(roleId: string, jobId: string): void {
    if (Date.now() - this.dormantWarned < WIP_WARN_MS) return;
    this.dormantWarned = Date.now();
    this.vault.events.emit({ type: 'daemon.warning', agent: roleId, job: jobId, payload: { where: 'dormant', message: `The company is out of money, so ${jobId} waits and only the heartbeat runs. Add a \`capital\` row to ${LEDGER_PATH} to start it again.` } });
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
        // A conversation, not work: the same dependency bag the heartbeat gets, so the worker pool gains no
        // option and the turns run against the same house budget the board session does (Decision 9).
        else if (job.type === 'pantry.chat') outcome = await runPantryChat({ vault: this.vault, ...this.opts.heartbeat }, jobId);
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
