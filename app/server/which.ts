import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

type Where = { env?: NodeJS.ProcessEnv; extra?: string[] };
// Answers about the app's own environment are kept a minute: a person's tool asks whether its program is here before
// every call, and the answer is the same until somebody installs something. A lookup against any other environment
// (a test's, a child's) is never kept, so it always sees the folders as they are.
const KEEP_FOR = 60_000;
const kept = new Map<string, { at: number; path: string | null }>();

// Every place a program may be, in the order they are looked in: the caller's own folders first (a desktop entry may
// start the app with a PATH that never had ~/.local/bin in it), then the PATH.
const placesOf = (name: string, { env = process.env, extra = [] }: Where) => [...extra, ...(env.PATH ?? '').split(delimiter).filter(Boolean)].map((dir) => join(dir, name));
const keyOf = (name: string, { env = process.env, extra = [] }: Where) => (env === process.env ? `${name}\n${extra.join(delimiter)}\n${env.PATH ?? ''}` : null);
function remembered(key: string | null): { path: string | null } | null {
  if (!key) return null;
  const held = kept.get(key);
  if (!held || Date.now() - held.at > KEEP_FOR) return null;
  // A program taken away inside the minute is not here any more; one stat is still far cheaper than the whole PATH.
  if (held.path && !existsSync(held.path)) { kept.delete(key); return null; }
  return held;
}
const keep = (key: string | null, path: string | null) => { if (key) kept.set(key, { at: Date.now(), path }); return path; };

// Where a program is, the way a shell finds it, or null. Synchronous, for a tool's `ready()`, which must answer at once.
export function which(name: string, where: Where = {}): string | null {
  const key = keyOf(name, where);
  const held = remembered(key);
  if (held) return held.path;
  return keep(key, placesOf(name, where).find((path) => existsSync(path)) ?? null);
}
// The same, without holding the event loop while the folders are looked in.
export async function whichAsync(name: string, where: Where = {}): Promise<string | null> {
  const key = keyOf(name, where);
  const held = remembered(key);
  if (held) return held.path;
  for (const path of placesOf(name, where)) if (await access(path).then(() => true, () => false)) return keep(key, path);
  return keep(key, null);
}
// For a check that has just installed or removed a program and must see it at once.
export const forgetWhich = () => { kept.clear(); };
