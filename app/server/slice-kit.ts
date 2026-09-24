import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import type { Card, Stage } from '../shared/model.ts';
import { libraryFor } from './library/notes.ts';
import { wired } from './prompt.ts';
import { localEmbedder, wordEmbedder } from './recall.ts';
import type { Store } from './store.ts';
import type { Tool } from './tools/registry.ts';

// Small things more than one slice needs. They live here, outside `server/slices`, because every `*.ts` file in that
// folder is loaded as a slice of its own, and because one slice importing another means a broken file takes two
// features down instead of one.

// ---------------------------------------------------------------- ids

// A fresh id: the prefix, the moment in base 36, and a few random letters. The prefix is kept exactly as each caller
// had it, because the guard, the leads route and the hooks match ids on it; `joiner` is '' where an id was always one
// run of letters after its prefix.
export function newId(prefix: string, letters = 4, joiner = '-', at = Date.now()): string {
  return `${prefix}${at.toString(36)}${joiner}${Math.random().toString(36).slice(2, 2 + letters)}`;
}

// ---------------------------------------------------------------- programs on this machine

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

// ---------------------------------------------------------------- offering

// The tools that only make sense with one kind of card wired to the person (or, given a test, whenever it holds):
// everyone else is not offered them. Each slice keeps its list of names beside its tools and hands it here, so the
// rule and the tools cannot drift apart when one is renamed.
export function offerWhenWired(kind: Card['kind'] | ((stage: Stage, roomId: string) => boolean), names: readonly string[]) {
  const holds = typeof kind === 'function' ? kind : (stage: Stage, roomId: string) => wired(stage, roomId, (stage.cards ?? []).filter((card) => card.kind === kind).map((card) => card.id)).length > 0;
  return (tools: Tool[], stage: Stage, roomId: string): Tool[] => (holds(stage, roomId) ? tools : tools.filter((tool) => !names.includes(tool.name)));
}

// ---------------------------------------------------------------- the library

// The workspace's one library and its recall, with the embedder the app itself uses, chosen the same way: words only
// in fake mode, the small local model otherwise.
export const sharedLibrary = (deps: { workspace: string; root: string; fake: boolean }) =>
  libraryFor(deps.workspace, deps.fake ? wordEmbedder : localEmbedder(resolve(deps.root, 'app/.cache/recall')));

// ---------------------------------------------------------------- the stage

type Patchable = Pick<Store, 'loadStage' | 'saveStage'> & { patchStage?: (edit: (stage: Stage) => void | Stage) => Promise<Stage> };
const queues = new WeakMap<object, Promise<unknown>>();

// Load the stage, change one card or room, save it: one after another, never two at once, so two slices writing
// different fields cannot each save a copy that lacks the other's change. A change that changed nothing is not saved.
// TODO(lead): swap for store.patchStage once it is in; this already defers to it when the store has one.
export function patchStageVia(store: Patchable, edit: (stage: Stage) => void | Stage): Promise<Stage> {
  if (typeof store.patchStage === 'function') return store.patchStage(edit);
  const job = (queues.get(store) ?? Promise.resolve()).then(async () => {
    const stage = await store.loadStage();
    const before = JSON.stringify(stage);
    const after = edit(stage) ?? stage;
    if (JSON.stringify(after) !== before) await store.saveStage(after);
    return after;
  });
  queues.set(store, job.catch(() => {}));
  return job;
}
