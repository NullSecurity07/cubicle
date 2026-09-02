import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Vault, EventLog, listJobs } from '@cubicle/core';

/** Rebuild the `.cubicle` cache (SQLite) from the vault + JSONL event mirror. Screens and browser profile are kept. */
export async function rebuildCache(vaultPath: string, opts: { memory?: (vault: Vault) => Promise<number> } = {}): Promise<{ events: number; writtenSha: number; jobs: number; memoryFiles: number }> {
  const dbFile = path.join(vaultPath, '.cubicle', 'cubicle.db');
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) if (existsSync(f)) rmSync(f);
  const vault = Vault.open(vaultPath);
  try {
    const events = EventLog.rebuildFromJsonl(vault.db, path.join(vault.cubicleDir, 'events'));
    const writtenSha = vault.rebuildWrittenSha();
    const jobs = listJobs(vault);
    const ins = vault.db.prepare('INSERT OR REPLACE INTO jobs_index(id, status, assigned, type, priority, updated, path) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const j of jobs) ins.run(j.id, j.status, j.assigned, j.type, j.priority, j.updated, `Jobs/${j.id}.md`);
    const memoryFiles = opts.memory ? await opts.memory(vault) : 0;
    return { events, writtenSha, jobs: jobs.length, memoryFiles };
  } finally {
    vault.close();
  }
}
