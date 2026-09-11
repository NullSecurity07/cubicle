import { readdirSync, statSync, existsSync, type Dirent } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Vault } from './vault.js';
import { atomicWriteSync } from './fs.js';
import { workspacePath } from './streams.js';

/**
 * A stream's pipeline, declared in `Workspace/<slug>/cubicle-ci.yaml` and executed by the `ci.run` tool inside
 * the same sandbox `shell.run` uses. The owner's operating model §17 wants build, tests, static analysis,
 * dependency and security checks run automatically on every meaningful change; the toolchain document §45 gives
 * the canonical order. Which commands implement them is the stream's business, so this file only fixes the
 * shape.
 */
export const CiStep = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  /** A step that reports rather than blocks (a `npm audit` advisory on a hobby project). */
  allow_failure: z.boolean().default(false),
});
export type CiStep = z.infer<typeof CiStep>;

export const CiConfig = z.object({
  steps: z.array(CiStep).min(1).max(10),
  network: z.enum(['none', 'allowlist']).default('none'),
  timeout_s: z.number().int().min(1).max(300).default(300),
});
export type CiConfig = z.infer<typeof CiConfig>;

export const CiStepResult = z.object({
  name: z.string(),
  code: z.number().int().nullable(),
  ok: z.boolean(),
  duration_ms: z.number().int(),
  output: z.string(),
});
export type CiStepResult = z.infer<typeof CiStepResult>;

export const CiRecord = z.object({
  stream: z.string(),
  started: z.string(),
  finished: z.string(),
  green: z.boolean(),
  /** HEAD of the stream's own git repo when it has one; null otherwise. Evidence for a human, not the freshness rule. */
  commit: z.string().nullable().default(null),
  steps: z.array(CiStepResult),
});
export type CiRecord = z.infer<typeof CiRecord>;

export function ciConfigPath(slug: string): string { return `${workspacePath(slug)}/cubicle-ci.yaml`; }
export function ciRecordDir(slug: string): string { return `${workspacePath(slug)}/.cubicle-ci`; }

/** Directories whose contents are outputs or caches, never source; they must not make a green record stale. */
export const CI_IGNORED_DIRS = ['node_modules', 'dist', 'build', 'target', '.git', '.cubicle-ci', '.venv', '__pycache__', 'coverage'] as const;

export function readCiConfig(vault: Vault, slug: string): { ok: true; config: CiConfig } | { ok: false; error: string } {
  const rel = ciConfigPath(slug);
  const text = vault.readTextOrNull(rel);
  if (text === null) return { ok: false, error: `no CI config at ${rel}. Create it with the steps this stream needs (build, lint, test, security-scan) — see Workspace/README.md.` };
  let raw: unknown;
  try { raw = YAML.parse(text); } catch (err) { return { ok: false, error: `${rel} is not valid YAML: ${(err as Error).message}` }; }
  const p = CiConfig.safeParse(raw ?? {});
  if (!p.success) return { ok: false, error: `${rel}: ${p.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
  return { ok: true, config: p.data };
}

/**
 * Records are named by their finish timestamp, so lexical order is chronological order.
 *
 * Written through `atomicWriteSync` rather than `vault.writeText` on purpose: `.cubicle-ci/` is a cache path
 * (guard.ts), so the vault write API refuses it — which is exactly the property we want, because it means an
 * agent cannot forge a green record with `vault.write` and ship on it. Only this function, reached through
 * `ci.run`, puts records there. `recordWritten` still carries the provenance.
 */
export function writeCiRecord(vault: Vault, slug: string, rec: CiRecord, by: string): string {
  const rel = `${ciRecordDir(slug)}/${rec.finished.replace(/[:.]/g, '-')}.json`;
  const sha = atomicWriteSync(vault.abs(rel), JSON.stringify(CiRecord.parse(rec), null, 2) + '\n');
  vault.recordWritten(rel, sha, by);
  return rel;
}

export function latestCiRecord(vault: Vault, slug: string): { path: string; record: CiRecord } | null {
  const files = vault.list(ciRecordDir(slug), { ext: '.json' }).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const text = vault.readTextOrNull(files[i]);
    if (text === null) continue;
    try {
      const p = CiRecord.safeParse(JSON.parse(text));
      if (p.success) return { path: files[i], record: p.data };
    } catch { /* a half-written record; keep looking back */ }
  }
  return null;
}

/** Walk a stream's workspace, skipping outputs and caches, calling `visit` for every source file. */
function walkSource(vault: Vault, slug: string, visit: (abs: string, mtimeMs: number) => void): void {
  const root = vault.abs(workspacePath(slug));
  if (!existsSync(root)) return;
  const walk = (abs: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow links: a sandbox could plant one out of the workspace
      const full = path.join(abs, e.name);
      if (e.isDirectory()) { if (!(CI_IGNORED_DIRS as readonly string[]).includes(e.name)) walk(full); continue; }
      try { visit(full, statSync(full).mtimeMs); } catch { /* vanished mid-walk */ }
    }
  };
  walk(root);
}

/** Epoch ms of the newest source file in the stream's workspace, ignoring outputs and caches. 0 when absent. */
export function newestSourceMtime(vault: Vault, slug: string): number {
  let newest = 0;
  walkSource(vault, slug, (_abs, m) => { if (m > newest) newest = m; });
  return newest;
}

/** The vault path of the newest source file, for a refusal a model can act on. */
export function newestSourceFile(vault: Vault, slug: string): string | null {
  let bestRel: string | null = null;
  let bestMtime = -1;
  walkSource(vault, slug, (abs, m) => { if (m > bestMtime) { bestMtime = m; bestRel = vault.rel(abs); } });
  return bestRel;
}

/**
 * Whether the stream has a CI result the ship gate can accept: green, and finished after every source file was
 * last touched. Timestamps rather than commits, because a workspace need not be its own git repo and "has
 * anything changed since CI ran" is the question that matters (§17: detection close to the change).
 */
export function ciStatus(vault: Vault, slug: string): { ok: boolean; reason: string | null; record: CiRecord | null; path: string | null } {
  const latest = latestCiRecord(vault, slug);
  if (!latest) return { ok: false, reason: `no CI record for stream "${slug}". Run ci.run({ stream: "${slug}" }) and ship on green.`, record: null, path: null };
  const { record, path: rel } = latest;
  if (!record.green) {
    const failed = record.steps.filter((s) => !s.ok).map((s) => s.name).join(', ') || 'unknown step';
    return { ok: false, reason: `the last CI run for "${slug}" was red (${failed}). Fix it and run ci.run again.`, record, path: rel };
  }
  const newest = newestSourceMtime(vault, slug);
  const finished = Date.parse(record.finished);
  if (Number.isFinite(newest) && Number.isFinite(finished) && newest > finished) {
    const changed = newestSourceFile(vault, slug) ?? 'a source file';
    return { ok: false, reason: `the last green CI run for "${slug}" finished at ${record.finished}, before ${changed} was last changed. Run ci.run({ stream: "${slug}" }) again.`, record, path: rel };
  }
  return { ok: true, reason: null, record, path: rel };
}
