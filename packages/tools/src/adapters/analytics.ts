import type { Vault } from '@cubicle/core';
import { hasEnv, fetchJson } from './common.js';

export interface DailyStats { date: string; visitors: number; pageviews: number; topPaths: { path: string; count: number }[]; source: 'mock' | 'goatcounter' }
export interface Analytics { mode: 'mock' | 'live'; today(vault: Vault): Promise<DailyStats> }

/** GoatCounter API (verified 2026-09-02): https://<code>.goatcounter.com/api/v0, Bearer token, /stats/total and /stats/hits. */
export function analytics(env: NodeJS.ProcessEnv): Analytics {
  if (hasEnv(env, 'GOATCOUNTER_CODE', 'GOATCOUNTER_API_TOKEN')) {
    const base = `https://${env.GOATCOUNTER_CODE}.goatcounter.com/api/v0`;
    const headers = { authorization: `Bearer ${env.GOATCOUNTER_API_TOKEN}`, 'content-type': 'application/json' };
    return {
      mode: 'live',
      async today() {
        const date = new Date().toISOString().slice(0, 10);
        const q = `start=${date}T00:00:00Z&end=${date}T23:59:59Z`;
        const total = await fetchJson(`${base}/stats/total?${q}`, { headers });
        const hits = await fetchJson(`${base}/stats/hits?${q}&limit=10`, { headers });
        const t = total.json as { total?: number; total_utc?: number; total_visitors?: number } | null;
        const h = hits.json as { hits?: { path: string; count: number; count_unique?: number }[] } | null;
        return { date, visitors: Number(t?.total_visitors ?? 0), pageviews: Number(t?.total ?? t?.total_utc ?? 0), topPaths: (h?.hits ?? []).map((x) => ({ path: x.path, count: x.count })), source: 'goatcounter' };
      },
    };
  }
  return { mode: 'mock', async today() { return { date: new Date().toISOString().slice(0, 10), visitors: 0, pageviews: 0, topPaths: [], source: 'mock' }; } };
}

/** Upsert today's row in Metrics/daily.md (a markdown table; other columns preserved). */
export function upsertDailyRow(vault: Vault, by: string, s: DailyStats, extra: Partial<Record<'leads' | 'emails_sent' | 'replies' | 'revenue', number | string>> = {}): void {
  const text = vault.readTextOrNull('Metrics/daily.md') ?? '# Daily metrics\n\n| date | visitors | pageviews | leads | emails_sent | replies | revenue |\n|---|---|---|---|---|---|---|\n';
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.startsWith(`| ${s.date} |`));
  const prev = idx >= 0 ? lines[idx].split('|').map((c) => c.trim()) : [];
  const cell = (i: number, v?: number | string) => (v !== undefined ? String(v) : prev[i] ?? '0');
  const row = `| ${s.date} | ${s.visitors} | ${s.pageviews} | ${cell(4, extra.leads)} | ${cell(5, extra.emails_sent)} | ${cell(6, extra.replies)} | ${cell(7, extra.revenue)} |`;
  if (idx >= 0) lines[idx] = row; else lines.push(row);
  vault.writeText('Metrics/daily.md', lines.join('\n').replace(/\n*$/, '\n'), by, { silent: true });
}
