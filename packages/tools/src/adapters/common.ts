import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Vault } from '@cubicle/core';

/** Mock adapters record what they would have done here, one JSON line per action. */
export function mockLog(vault: Vault, name: string, entry: Record<string, unknown>): string {
  const rel = `.cubicle/mock/${name}.jsonl`;
  const abs = vault.abs(rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  appendFileSync(abs, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  return rel;
}

export function hasEnv(env: NodeJS.ProcessEnv, ...keys: string[]): boolean {
  return keys.every((k) => !!env[k] && env[k]!.trim().length > 0);
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'x';
}

export async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
