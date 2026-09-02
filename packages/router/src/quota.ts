import type { Db } from '@cubicle/core';
import type { ModelConfig } from './config.js';

export interface QuotaStatus {
  provider: string;
  model: string;
  rpm_used: number;
  rpd_used: number;
  tpm_used: number;
  tpd_used: number;
  cooling_until: string | null;
  limits: { rpm: number; rpd: number; tpm: number; tpd: number };
}

/**
 * Sliding-window quota accounting over the `quota_calls` table, plus a `cooling_until` mark per
 * provider+model set from 429 responses. Windows: rpm/tpm = last 60 s, rpd/tpd = last 24 h.
 */
export class QuotaTracker {
  constructor(private db: Db, private now: () => Date = () => new Date()) {}

  record(provider: string, model: string, promptTokens: number, completionTokens: number, ok = true): void {
    this.db.prepare('INSERT INTO quota_calls(ts, provider, model, prompt_tokens, completion_tokens, ok) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.now().toISOString(), provider, model, promptTokens, completionTokens, ok ? 1 : 0);
    this.db.prepare('INSERT OR IGNORE INTO quota(provider, model, window_start) VALUES (?, ?, ?)').run(provider, model, this.now().toISOString());
  }

  setCooling(provider: string, model: string, until: Date): void {
    this.db.prepare('INSERT INTO quota(provider, model, window_start, cooling_until) VALUES (?, ?, ?, ?) ON CONFLICT(provider, model) DO UPDATE SET cooling_until = excluded.cooling_until')
      .run(provider, model, this.now().toISOString(), until.toISOString());
  }

  coolingUntil(provider: string, model: string): Date | null {
    const row = this.db.prepare('SELECT cooling_until FROM quota WHERE provider = ? AND model = ?').get(provider, model) as { cooling_until: string | null } | undefined;
    if (!row?.cooling_until) return null;
    const d = new Date(row.cooling_until);
    return d.getTime() > this.now().getTime() ? d : null;
  }

  private window(provider: string, model: string, sinceMs: number): { calls: number; tokens: number } {
    const since = new Date(this.now().getTime() - sinceMs).toISOString();
    const row = this.db.prepare('SELECT COUNT(*) c, COALESCE(SUM(prompt_tokens + completion_tokens), 0) t FROM quota_calls WHERE provider = ? AND model = ? AND ts >= ?')
      .get(provider, model, since) as { c: number; t: number };
    return { calls: row.c, tokens: row.t };
  }

  status(provider: string, m: ModelConfig): QuotaStatus {
    const minute = this.window(provider, m.id, 60_000);
    const day = this.window(provider, m.id, 24 * 3600_000);
    const cooling = this.coolingUntil(provider, m.id);
    return {
      provider, model: m.id,
      rpm_used: minute.calls, tpm_used: minute.tokens,
      rpd_used: day.calls, tpd_used: day.tokens,
      cooling_until: cooling?.toISOString() ?? null,
      limits: { rpm: m.limits.rpm, rpd: m.limits.rpd, tpm: m.limits.tpm, tpd: m.limits.tpd },
    };
  }

  /** True when the next call (with an estimated token cost) fits inside every configured limit. A limit of 0 means unlimited. */
  hasHeadroom(provider: string, m: ModelConfig, estimatedTokens: number): { ok: boolean; reason?: string } {
    if (this.coolingUntil(provider, m.id)) return { ok: false, reason: 'cooling' };
    const s = this.status(provider, m);
    const L = m.limits;
    if (L.rpm && s.rpm_used + 1 > L.rpm) return { ok: false, reason: 'rpm' };
    if (L.rpd && s.rpd_used + 1 > L.rpd) return { ok: false, reason: 'rpd' };
    if (L.tpm && s.tpm_used + estimatedTokens > L.tpm) return { ok: false, reason: 'tpm' };
    if (L.tpd && s.tpd_used + estimatedTokens > L.tpd) return { ok: false, reason: 'tpd' };
    return { ok: true };
  }

  /** Calls and tokens today (UTC) per provider+model, for Metrics/quota.md. */
  todayTotals(): { provider: string; model: string; calls: number; tokens: number }[] {
    const start = new Date(this.now()); start.setUTCHours(0, 0, 0, 0);
    return this.db.prepare('SELECT provider, model, COUNT(*) calls, COALESCE(SUM(prompt_tokens + completion_tokens), 0) tokens FROM quota_calls WHERE ts >= ? GROUP BY provider, model ORDER BY provider, model')
      .all(start.toISOString()) as { provider: string; model: string; calls: number; tokens: number }[];
  }
}

/** Rough token estimate: 4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
