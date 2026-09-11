/**
 * Paths agents may never write directly. Daemon-side dispatcher writes bypass this by construction.
 * `Ledger/` joins this list for the book (spec §7): the only sanctioned writer is `appendEntry` (money.ts),
 * reached through the `ledger.record` tool or the daemon's own accrual. It writes through this same guard —
 * as `'daemon'`, a privileged actor, regardless of who actually asked — rather than going around it, so the
 * compare-and-write it does against `Ledger/ledger.md` and the `vault.wrote` event it emits stay the ones this
 * guard already produces (see `appendEntry`'s doc comment for why).
 */
export const OWNER_OWNED_PREFIXES = ['Brand/', 'Roles/', 'Teams/', 'Ledger/'];
export const OWNER_OWNED_FILES = ['Memory/constitution.md', 'Memory/owner_preferences.md'];
export const CACHE_PREFIXES = ['.cubicle/', '.obsidian/', '.git/'];

/** Actors that are not agents and may write owner-owned paths (dispatcher, init, owner via Obsidian). */
export const PRIVILEGED_ACTORS = new Set(['daemon', 'owner', 'system', 'init']);

export class UnsafePathError extends Error {
  constructor(public readonly path: string) {
    super(`Unsafe vault path: ${JSON.stringify(path)}`);
    this.name = 'UnsafePathError';
  }
}

/**
 * Normalise a vault-relative path: backslashes → slashes, posix-normalised, no leading ./ or /.
 * Throws UnsafePathError on `..` segments, NUL bytes, or absolute/drive paths — never resolves outside the vault.
 */
export function normalizeRel(rel: string): string {
  if (typeof rel !== 'string' || rel.includes('\0') || /^[A-Za-z]:/.test(rel)) throw new UnsafePathError(rel);
  let p = rel.replace(/\\/g, '/');
  p = posixNormalize(p).replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (p === '..' || p.startsWith('../') || p.includes('/../') || p.endsWith('/..')) throw new UnsafePathError(rel);
  if (p === '.') p = '';
  return p;
}

function posixNormalize(p: string): string {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); continue; }
    out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}

/** Role ids are path segments; keep them boring. */
export const ROLE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export function isValidRoleId(id: string): boolean {
  return ROLE_ID_RE.test(id);
}

/** Files agents may never read (secrets, git internals). */
export function isSecretPath(rel: string): boolean {
  const p = normalizeRel(rel);
  if (/^\.env(\.|$)/.test(p) || p.startsWith('.git/') || p === '.git') return true;
  if ((p.startsWith('.cubicle/') || p === '.cubicle') && !p.startsWith('.cubicle/screens/')) return true; // daemon.json token, mock ledgers, transcripts
  return false;
}

/**
 * Whether `rel` matches one of the owner's own `never_modify` entries — the constitution's list, never the
 * structural `OWNER_OWNED_PREFIXES`/`OWNER_OWNED_FILES` above. Split out from `isOwnerOwned` so a caller that
 * needs to know specifically "did the owner veto *this*" can ask, without a path that is owner-owned for a
 * structural reason (e.g. `Ledger/`) always answering yes regardless of what `never_modify` actually contains.
 */
export function isNeverModifyPath(rel: string, extraNeverModify: string[] = []): boolean {
  const p = normalizeRel(rel);
  for (const nm of extraNeverModify) {
    let n: string;
    try { n = normalizeRel(nm); } catch { continue; }
    if (!n) continue;
    const isDir = /[\\/]\s*$/.test(nm);
    if (isDir ? (p === n || p.startsWith(n + '/')) : p === n) return true;
  }
  return false;
}

export function isOwnerOwned(rel: string, extraNeverModify: string[] = []): boolean {
  const p = normalizeRel(rel);
  if (OWNER_OWNED_FILES.includes(p)) return true;
  if (OWNER_OWNED_PREFIXES.some((pre) => p.startsWith(pre))) return true;
  return isNeverModifyPath(p, extraNeverModify);
}

/**
 * A stream's build output, dependencies and CI records: `Workspace/<slug>/{node_modules,dist,.venv,.cubicle-ci}`,
 * exactly what `vault-template/.gitignore` declares as generated. Without this the recursive vault scan would walk
 * a stream's `node_modules`, and `vault.write` would let an agent forge a CI record under `.cubicle-ci/`
 * (`writeCiRecord` goes around the vault write API precisely so only `ci.run` can put one there).
 */
const WORKSPACE_GENERATED_RE = /^Workspace\/[^/]+\/(node_modules|dist|\.venv|\.cubicle-ci)(\/|$)/;

export function isCachePath(rel: string): boolean {
  let p: string;
  try { p = normalizeRel(rel); } catch { return true; }
  return CACHE_PREFIXES.some((pre) => p.startsWith(pre) || p === pre.slice(0, -1)) || p.startsWith('Site/dist/') || p === 'Site/dist' || p.startsWith('Site/node_modules/') || p === 'Site/node_modules' || WORKSPACE_GENERATED_RE.test(p);
}

export function isPrivilegedActor(by: string): boolean {
  return PRIVILEGED_ACTORS.has(by);
}

export class OwnerOwnedPathError extends Error {
  constructor(public readonly path: string, public readonly by: string) {
    super(`Path "${path}" is owner-owned; agent "${by}" must file a proposal instead of writing it`);
    this.name = 'OwnerOwnedPathError';
  }
}

/** Assert an actor may write a path; throws OwnerOwnedPathError for agents on owner-owned paths. */
export function assertWritable(rel: string, by: string, extraNeverModify: string[] = []): void {
  if (isPrivilegedActor(by)) return;
  if (isOwnerOwned(rel, extraNeverModify)) throw new OwnerOwnedPathError(normalizeRel(rel), by);
}
