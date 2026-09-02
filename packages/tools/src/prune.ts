import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Vault } from '@cubicle/core';

const KEEP_ALL_MS = 7 * 86400_000;
const KEEP_EVERY = 5;
const MAX_PER_SESSION = 3000;

/** Screencast retention (A26): all frames for 7 days, then every 5th; at most 3000 frames per session. Returns files removed. */
export function pruneScreens(vault: Vault, now = Date.now()): number {
  const root = path.join(vault.cubicleDir, 'screens');
  if (!existsSync(root)) return 0;
  let removed = 0;
  const del = vault.db.prepare('DELETE FROM screens WHERE session_id = ? AND seq = ?');
  for (const session of readdirSync(root, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const dir = path.join(root, session.name);
    const frames = readdirSync(dir).filter((f) => /^\d+\.jpg$/.test(f)).sort();
    const overflow = Math.max(0, frames.length - MAX_PER_SESSION);
    frames.forEach((f, i) => {
      const seq = Number(f.replace(/\.jpg$/, ''));
      const age = now - statSync(path.join(dir, f)).mtimeMs;
      const old = age > KEEP_ALL_MS && seq % KEEP_EVERY !== 0;
      if (old || i < overflow) { rmSync(path.join(dir, f), { force: true }); del.run(session.name, seq); removed++; }
    });
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  }
  return removed;
}
