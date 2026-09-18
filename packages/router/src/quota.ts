import type { Db } from '@cubicle/core';
import type { ModelConfig, ProviderConfig } from './config.js';

export interface QuotaStatus {
  provider: string;
  model: string;
  rpm_used: number;
  rpd_used: number;
  tpm_used: number;
  tpd_used: number;
  cooling_until: string | null;
  limits: { rpm: number; rpd: number; tpm: number; tpd: number };
  /**
   * This provider declares an `api_key_env` and this router's environment does not set it, so nothing here can
   * be called at all (ruling W4-13). `Metrics/quota.md` listed all five openrouter models as "ok" on a day when
   * `OPENROUTER_API_KEY` was empty; "ok 0/250" reads as an idle cloud tier, which is the opposite of the truth.
   */
  missing_key?: boolean;
}

/**
 * Quota accounting over the `quota_calls` table, plus a `cooling_until` mark per provider+model set
 * from 429 responses. Windows: rpm/tpm are a sliding last-60s window; rpd/tpd are a calendar-day window
 * that resets at midnight in the provider's `day_reset_tz` (see `dayStart`), not a rolling 24h lookback.
 */
export class QuotaTracker {
  constructor(private db: Db, private now: () => Date = () => new Date()) {}

  private calls = 0;

  /**
   * Calls dialled but not yet recorded, per provider+model (ruling W4-13).
   *
   * `Metrics/quota.md` showed gemini-3.7-flash at "21/20" calls a day, past a limit `hasHeadroom` checks on
   * every single call — because the check and the `record` are two steps with a whole HTTP round trip between
   * them. The daemon runs several role workers at once: two of them reading 19/20 both pass, both dial, and the
   * day ends at 21. The provider's own 429 is what stops it, which is the thing the quota table exists to avoid
   * paying for.
   *
   * A reservation closes that window. `reserve` is taken before the request goes out and released when the call
   * is recorded (or abandoned), and `hasHeadroom` counts reservations as though they had already landed. It is
   * in-process because the daemon is one process; a second daemon on the same vault would still race, and the
   * database's own counts remain the truth for everything the owner reads.
   */
  private inFlight = new Map<string, number>();

  private key(provider: string, model: string): string { return `${provider}/${model}`; }

  /** Take a slot for a call about to be dialled. Returns the release, which is safe to call more than once. */
  reserve(provider: string, model: string): () => void {
    const k = this.key(provider, model);
    this.inFlight.set(k, (this.inFlight.get(k) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.inFlight.get(k) ?? 1) - 1;
      if (n > 0) this.inFlight.set(k, n); else this.inFlight.delete(k);
    };
  }

  /** Calls dialled against this model and not yet recorded. */
  reserved(provider: string, model: string): number {
    return this.inFlight.get(this.key(provider, model)) ?? 0;
  }

  /** Calls dialled against this whole provider and not yet recorded — the provider-wide limits count them too. */
  private reservedForProvider(provider: string): number {
    let n = 0;
    for (const [k, v] of this.inFlight) if (k.startsWith(`${provider}/`)) n += v;
    return n;
  }

  record(provider: string, model: string, promptTokens: number, completionTokens: number, ok = true): void {
    this.db.prepare('INSERT INTO quota_calls(ts, provider, model, prompt_tokens, completion_tokens, ok) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.now().toISOString(), provider, model, promptTokens, completionTokens, ok ? 1 : 0);
    this.db.prepare('INSERT OR IGNORE INTO quota(provider, model, window_start) VALUES (?, ?, ?)').run(provider, model, this.now().toISOString());
    if (++this.calls % 200 === 0) this.db.prepare('DELETE FROM quota_calls WHERE ts < ?').run(new Date(this.now().getTime() - 48 * 3600_000).toISOString());
  }

  /** Start of the current calendar day in the provider's reset time zone. */
  static dayStart(now: Date, tz: string): Date {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(now);
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
      const h = get('hour') % 24, m = get('minute'), s = get('second');
      return new Date(now.getTime() - ((h * 3600 + m * 60 + s) * 1000) - now.getMilliseconds());
    } catch {
      const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d;
    }
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

  private windowSince(provider: string, model: string | null, since: string): { calls: number; tokens: number } {
    const row = (model
      ? this.db.prepare('SELECT COUNT(*) c, COALESCE(SUM(prompt_tokens + completion_tokens), 0) t FROM quota_calls WHERE provider = ? AND model = ? AND ts >= ?').get(provider, model, since)
      : this.db.prepare('SELECT COUNT(*) c, COALESCE(SUM(prompt_tokens + completion_tokens), 0) t FROM quota_calls WHERE provider = ? AND ts >= ?').get(provider, since)) as { c: number; t: number };
    return { calls: row.c, tokens: row.t };
  }

  private window(provider: string, model: string | null, sinceMs: number): { calls: number; tokens: number } {
    return this.windowSince(provider, model, new Date(this.now().getTime() - sinceMs).toISOString());
  }

  status(provider: string, m: ModelConfig, tz = 'UTC'): QuotaStatus {
    const minute = this.window(provider, m.id, 60_000);
    const day = this.windowSince(provider, m.id, QuotaTracker.dayStart(this.now(), tz).toISOString());
    const cooling = this.coolingUntil(provider, m.id);
    return {
      provider, model: m.id,
      rpm_used: minute.calls, tpm_used: minute.tokens,
      rpd_used: day.calls, tpd_used: day.tokens,
      cooling_until: cooling?.toISOString() ?? null,
      limits: { rpm: m.limits.rpm, rpd: m.limits.rpd, tpm: m.limits.tpm, tpd: m.limits.tpd },
    };
  }

  /**
   * True when the next call (with an estimated token cost) fits inside every configured limit. A limit of 0
   * means unlimited. Calls already dialled and not yet recorded count as though they had landed — see
   * `inFlight` for the "21/20" this closes.
   */
  hasHeadroom(provider: string, m: ModelConfig, estimatedTokens: number, providerCfg?: Pick<ProviderConfig, 'limits' | 'day_reset_tz'>): { ok: boolean; reason?: string } {
    if (this.coolingUntil(provider, m.id)) return { ok: false, reason: 'cooling' };
    const tz = providerCfg?.day_reset_tz ?? 'UTC';
    const s = this.status(provider, m, tz);
    const L = m.limits;
    const held = this.reserved(provider, m.id);
    if (L.rpm && s.rpm_used + held + 1 > L.rpm) return { ok: false, reason: 'rpm' };
    if (L.rpd && s.rpd_used + held + 1 > L.rpd) return { ok: false, reason: 'rpd' };
    if (L.tpm && s.tpm_used + estimatedTokens > L.tpm) return { ok: false, reason: 'tpm' };
    if (L.tpd && s.tpd_used + estimatedTokens > L.tpd) return { ok: false, reason: 'tpd' };
    const P = providerCfg?.limits;
    if (P) {
      const pm = this.window(provider, null, 60_000);
      const pd = this.windowSince(provider, null, QuotaTracker.dayStart(this.now(), tz).toISOString());
      const heldHere = this.reservedForProvider(provider);
      if (P.rpm && pm.calls + heldHere + 1 > P.rpm) return { ok: false, reason: 'provider rpm' };
      if (P.rpd && pd.calls + heldHere + 1 > P.rpd) return { ok: false, reason: 'provider rpd' };
      if (P.tpm && pm.tokens + estimatedTokens > P.tpm) return { ok: false, reason: 'provider tpm' };
      if (P.tpd && pd.tokens + estimatedTokens > P.tpd) return { ok: false, reason: 'provider tpd' };
    }
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
