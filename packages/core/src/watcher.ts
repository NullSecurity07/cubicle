import { watch, type FSWatcher } from 'chokidar';
import path from 'node:path';
import type { Vault } from './vault.js';
import { isCachePath } from './guard.js';
import { TOMBSTONE } from './vault.js';

export interface WatcherOptions {
  debounceMs?: number;
}

/**
 * Owner edits in these areas wake a heartbeat. `Discovery` and `Ideas` are here because dropping a file in
 * `Discovery/inbox/` or flipping a card's `decision:` by hand is the owner telling the company something, and it
 * should not wait six hours to be noticed. `Ledger` is here for a sharper reason: a `capital` row is the only
 * thing that brings a dormant company back, and a company that is dormant is not running cycles to notice it.
 */
export const HEARTBEAT_WAKE_AREAS = ['Jobs', '00 Inbox', 'Brand', 'Roles', 'Teams', 'Discovery', 'Ideas', 'Ledger'];

/**
 * Watches the vault for owner edits. A change whose content sha equals the last `written_sha`
 * for that path is an agent write and is suppressed; anything else emits `owner.edited`.
 */
export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  /** Paths where some generation inside the debounce window already differed from the last system write. */
  private ownerSeen = new Set<string>();
  private readonly debounceMs: number;

  constructor(private vault: Vault, opts: WatcherOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 1500;
  }

  async start(): Promise<void> {
    if (this.watcher) return;
    const root = this.vault.root;
    this.watcher = watch(root, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p: string) => {
        const rel = path.relative(root, p).split(path.sep).join('/');
        if (!rel) return false;
        if (isCachePath(rel)) return true;
        const base = path.basename(rel);
        return base.startsWith('.') && base.includes('.tmp-');
      },
    });
    const schedule = (p: string, deleted: boolean) => {
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (!rel || isCachePath(rel)) return;
      // Check this generation now: an agent write landing later in the window must not hide an owner edit.
      if (!deleted) { const cur = this.vault.currentSha(rel); const rec = this.vault.writtenSha(rel); if (cur !== null && (rec === null || rec !== cur)) this.ownerSeen.add(rel); }
      const prev = this.timers.get(rel);
      if (prev) clearTimeout(prev);
      this.timers.set(rel, setTimeout(() => { this.timers.delete(rel); this.fire(rel, deleted); }, this.debounceMs));
    };
    this.watcher.on('add', (p) => schedule(p, false));
    this.watcher.on('change', (p) => schedule(p, false));
    this.watcher.on('unlink', (p) => schedule(p, true));
    // chokidar is an EventEmitter, so an `error` with no listener is re-thrown as an uncaught exception — and
    // the only listener used to be the one-shot `reject` below, which is gone the moment the watcher is ready.
    // A transient FS error after that is ordinary (a file removed mid-scan — an `ENOENT lstat` on a temp vault
    // being torn down failed a test run; EMFILE under load) and it must cost a warning, not the daemon. The
    // listener goes on before the ready race so there is no window in which an error has nowhere to go.
    this.watcher.on('error', (err) => this.vault.events.emit({ type: 'daemon.warning', agent: 'daemon', payload: { where: 'watcher', message: String((err as Error)?.message ?? err) } }));
    await new Promise<void>((resolve, reject) => {
      this.watcher!.once('ready', () => resolve());
      this.watcher!.once('error', reject);
    });
  }

  /** The live chokidar instance, for tests that need to drive its error path. */
  get fsWatcher(): FSWatcher | null { return this.watcher; }

  private fire(rel: string, deleted: boolean): void {
    const area = rel.split('/')[0];
    if (deleted) {
      const rec = this.vault.writtenSha(rel);
      if (rec === TOMBSTONE) return; // system delete/move — not an owner edit
      if (rec !== null) this.vault.db.prepare('DELETE FROM written_sha WHERE path = ?').run(rel);
      this.vault.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: rel, area, deleted: true, wakes_heartbeat: HEARTBEAT_WAKE_AREAS.includes(area) } });
      return;
    }
    const seen = this.ownerSeen.delete(rel);
    const cur = this.vault.currentSha(rel);
    if (cur === null) return;
    const rec = this.vault.writtenSha(rel);
    if (!seen && rec !== null && rec === cur) return; // agent write echo — suppressed
    this.vault.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: rel, area, deleted: false, wakes_heartbeat: HEARTBEAT_WAKE_AREAS.includes(area) } });
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.watcher?.close();
    this.watcher = null;
  }
}
