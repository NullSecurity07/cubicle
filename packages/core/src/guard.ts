/** Paths agents may never write directly. Daemon-side dispatcher writes bypass this by construction. */
export const OWNER_OWNED_PREFIXES = ['Brand/', 'Roles/'];
export const OWNER_OWNED_FILES = ['Memory/constitution.md', 'Memory/owner_preferences.md'];
export const CACHE_PREFIXES = ['.cubicle/', '.obsidian/', '.git/'];

/** Actors that are not agents and may write owner-owned paths (dispatcher, init, owner via Obsidian). */
export const PRIVILEGED_ACTORS = new Set(['daemon', 'owner', 'system', 'init']);

export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function isOwnerOwned(rel: string, extraNeverModify: string[] = []): boolean {
  const p = normalizeRel(rel);
  if (OWNER_OWNED_FILES.includes(p)) return true;
  if (OWNER_OWNED_PREFIXES.some((pre) => p.startsWith(pre))) return true;
  for (const nm of extraNeverModify) {
    const n = normalizeRel(nm);
    if (n.endsWith('/') ? p.startsWith(n) : p === n) return true;
  }
  return false;
}

export function isCachePath(rel: string): boolean {
  const p = normalizeRel(rel);
  return CACHE_PREFIXES.some((pre) => p.startsWith(pre)) || p.startsWith('Site/dist/') || p.startsWith('Site/node_modules/');
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
