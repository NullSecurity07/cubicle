import { watch, type FSWatcher } from 'chokidar';
import path from 'node:path';
import type { Vault } from './vault.js';
import { isCachePath } from './guard.js';

export interface WatcherOptions {
  debounceMs?: number;
}

export const HEARTBEAT_WAKE_AREAS = ['Jobs', '00 Inbox', 'Brand', 'Roles'];

/**
 * Watches the vault for owner edits. A change whose content sha equals the last `written_sha`
 * for that path is an agent write and is suppressed; anything else emits `owner.edited`.
 */
export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
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
      const prev = this.timers.get(rel);
      if (prev) clearTimeout(prev);
      this.timers.set(rel, setTimeout(() => { this.timers.delete(rel); this.fire(rel, deleted); }, this.debounceMs));
    };
    this.watcher.on('add', (p) => schedule(p, false));
    this.watcher.on('change', (p) => schedule(p, false));
    this.watcher.on('unlink', (p) => schedule(p, true));
    await new Promise<void>((resolve, reject) => {
      this.watcher!.once('ready', () => resolve());
      this.watcher!.once('error', reject);
    });
  }

  private fire(rel: string, deleted: boolean): void {
    const area = rel.split('/')[0];
    if (deleted) {
      if (this.vault.writtenSha(rel) !== null) {
        // The system wrote this file at some point; the owner removed it.
        this.vault.db.prepare('DELETE FROM written_sha WHERE path = ?').run(rel);
      }
      this.vault.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: rel, area, deleted: true, wakes_heartbeat: HEARTBEAT_WAKE_AREAS.includes(area) } });
      return;
    }
    const cur = this.vault.currentSha(rel);
    if (cur === null) return;
    const rec = this.vault.writtenSha(rel);
    if (rec !== null && rec === cur) return; // agent write echo — suppressed
    this.vault.events.emit({ type: 'owner.edited', agent: 'owner', payload: { path: rel, area, deleted: false, wakes_heartbeat: HEARTBEAT_WAKE_AREAS.includes(area) } });
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.watcher?.close();
    this.watcher = null;
  }
}
