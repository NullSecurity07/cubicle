import { readdirSync, lstatSync, existsSync, type Dirent } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Vault } from './vault.js';
import { atomicWriteSync } from './fs.js';
import { workspacePath, isValidStreamSlug } from './streams.js';

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

/**
 * The stream-slug shape lives in `streams.ts` (this module imports that one, so it cannot be the other way
 * round) and is re-exported here, where every caller already looks for it.
 */
export { STREAM_SLUG_RE, isValidStreamSlug } from './streams.js';

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
 * Records are named by their finish timestamp, so lexical order is chronological order. Two runs finishing in
 * the same millisecond would collide, so a taken name gets a `-2`, `-3`, … before the extension.
 *
 * Written through `atomicWriteSync` rather than `vault.writeText` on purpose: `.cubicle-ci/` is a cache path
 * (guard.ts), so the vault write API refuses it — which is exactly the property we want, because it means an
 * agent cannot forge a green record with `vault.write` and ship on it. Only this function, reached through
 * `ci.run`, puts records there.
 *
 * `recordWritten` carries the provenance `ciRecordAttested` checks, and the `vault.wrote` event is what makes
 * that provenance survive a cache rebuild: `rebuildWrittenSha()` replays the event log, so without the event
 * every genuine record would read as unattested after a rebuild and no stream could ship until CI ran again.
 */
export function writeCiRecord(vault: Vault, slug: string, rec: CiRecord, by: string): string {
  const base = `${ciRecordDir(slug)}/${rec.finished.replace(/[:.]/g, '-')}`;
  let rel = `${base}.json`;
  for (let n = 2; n < 50 && existsSync(vault.abs(rel)); n++) rel = `${base}-${n}.json`;
  const sha = atomicWriteSync(vault.abs(rel), JSON.stringify(CiRecord.parse(rec), null, 2) + '\n');
  vault.recordWritten(rel, sha, by);
  vault.events.emit({ type: 'vault.wrote', agent: by, payload: { path: rel, sha, by, generated: true } });
  return rel;
}

/**
 * Whether the vault's own write ledger vouches for this record's exact bytes.
 *
 * `.cubicle-ci/` is refused by `vault.write` (it is a cache path), but it lives *inside* `Workspace/<slug>`,
 * which `ci.run` bind-mounts read-write at `/work/stream` — and the steps that run there come from
 * `cubicle-ci.yaml`, a file any engineer writes. So a step of `echo '{"green":true,...}' > .cubicle-ci/9999-...json`
 * can put a green, far-future record on disk, and a check that only reads the file would accept it.
 *
 * The record therefore has to carry something a step cannot produce. That something is its row in
 * `written_sha` (`.cubicle/`, outside every mount and unreachable from the sandbox), written by `writeCiRecord`
 * and keyed on the content sha: a forged file has no row at all, and overwriting a genuine record's bytes makes
 * the row disagree. Checking provenance beats moving the records out of the workspace — they are meant to be
 * readable next to the code they describe, the workspace .gitignore already treats them as generated, and a
 * relocation would still need this check the day something else is mounted.
 */
export function ciRecordAttested(vault: Vault, rel: string): boolean {
  const written = vault.writtenSha(rel);
  if (written === null) return false;
  const current = vault.currentSha(rel);
  return current !== null && current === written;
}

/**
 * The newest attested, parsable record, plus the unattested files newer than it — the ones a refusal should
 * name, so an engineer whose pipeline step wrote a record learns why it is ignored rather than reading
 * "no CI record" and trying again.
 */
function scanCiRecords(vault: Vault, slug: string): { latest: { path: string; record: CiRecord } | null; unattested: string[] } {
  const files = vault.list(ciRecordDir(slug), { ext: '.json' }).sort();
  const unattested: string[] = [];
  for (let i = files.length - 1; i >= 0; i--) {
    if (!ciRecordAttested(vault, files[i])) { unattested.push(files[i]); continue; }
    const text = vault.readTextOrNull(files[i]);
    if (text === null) continue;
    try {
      const p = CiRecord.safeParse(JSON.parse(text));
      if (p.success) return { latest: { path: files[i], record: p.data }, unattested };
    } catch { /* a half-written record; keep looking back */ }
  }
  return { latest: null, unattested };
}

export function latestCiRecord(vault: Vault, slug: string): { path: string; record: CiRecord } | null {
  return scanCiRecords(vault, slug).latest;
}

const isIgnoredDir = (name: string): boolean => (CI_IGNORED_DIRS as readonly string[]).includes(name);

/**
 * Walk a stream's workspace, skipping outputs and caches, calling `visit` for every source file.
 *
 * Symlinks are never *followed* — a sandbox could plant one pointing out of the workspace, and a green record
 * must not be decided by a file the stream does not own — but the link's own `lstat` mtime does count, so
 * re-pointing a symlinked `src/` is seen as a source change rather than silently keeping CI green. (What the
 * link points *at* changing is still invisible; a stream whose sources live behind a link should commit them.)
 */
function walkSource(vault: Vault, slug: string, visit: (abs: string, mtimeMs: number) => void): void {
  const root = vault.abs(workspacePath(slug));
  if (!existsSync(root)) return;
  const walk = (abs: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(abs, e.name);
      if (isIgnoredDir(e.name)) continue;                                  // also when it is a link named node_modules
      if (e.isDirectory()) { walk(full); continue; }
      try { visit(full, lstatSync(full).mtimeMs); } catch { /* vanished mid-walk */ }
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
 *
 * The window this cannot see: a file edited *while* the run was in flight predates `record.finished` and so
 * reads as covered. That is inherent to comparing mtimes against a finish time, not an oversight — a stream
 * that wants the stronger guarantee should freeze its workspace for the run.
 */
export function ciStatus(vault: Vault, slug: string): { ok: boolean; reason: string | null; record: CiRecord | null; path: string | null } {
  // A model writes `stream` onto a job, and this is reached from `shipRefusal` on the finish path: an invalid
  // slug must come back as a refusal the agent can act on, not as an UnsafePathError stack trace from vault.abs.
  if (!isValidStreamSlug(slug)) {
    return { ok: false, reason: `"${slug}" is not a stream slug, so there is no CI record to check. Use the slug from the Streams/<slug>.md note: lower-case letters, digits and hyphens only, starting with a letter or digit, at most 48 characters.`, record: null, path: null };
  }
  const { latest, unattested } = scanCiRecords(vault, slug);
  if (!latest) {
    const ignored = unattested.length
      ? ` (${unattested.length} file${unattested.length === 1 ? '' : 's'} under ${ciRecordDir(slug)} — ${unattested.slice(0, 3).join(', ')} — were not written by ci.run, so they are ignored: a CI record cannot be hand-written or produced by a pipeline step)`
      : '';
    return { ok: false, reason: `no CI record for stream "${slug}"${ignored}. Run ci.run({ stream: "${slug}" }) and ship on green.`, record: null, path: null };
  }
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

/**
 * Feature flags separate deployment from release (operating model §21). Every flag has an owner and a removal
 * date, because "feature flags create technical debt if abandoned flags are never removed" is the tradeoff the
 * document names, and a date nobody checks is not a plan.
 */
export const FeatureFlag = z.object({
  key: z.string().min(1),
  owner: z.string().min(1),
  state: z.enum(['on', 'off', 'percent']).default('off'),
  percent: z.number().int().min(0).max(100).optional(),
  created: z.string().min(4),
  remove_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'remove_by must be a YYYY-MM-DD date'),
});
export type FeatureFlag = z.infer<typeof FeatureFlag>;

export const FlagsFile = z.object({ flags: z.array(FeatureFlag).default([]) });

export function flagsPath(slug: string): string { return `${workspacePath(slug)}/flags.json`; }

/** Every well-formed flag in a stream. A missing, unparsable or malformed file reads as none. */
export function readFlags(vault: Vault, slug: string): FeatureFlag[] {
  const text = vault.readTextOrNull(flagsPath(slug));
  if (text === null) return [];
  try {
    const raw = JSON.parse(text) as { flags?: unknown[] };
    const list = Array.isArray(raw.flags) ? raw.flags : [];
    return list.flatMap((f) => { const p = FeatureFlag.safeParse(f); return p.success ? [p.data] : []; });
  } catch { return []; }
}

export function expiredFlags(flags: FeatureFlag[], today: string): FeatureFlag[] {
  return flags.filter((f) => f.remove_by < today);
}
