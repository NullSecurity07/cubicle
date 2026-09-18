import type { QuotaStatus } from './quota.js';

/** Render Metrics/quota.md — the company's "runway" in free calls instead of dollars. */
export function renderQuotaMarkdown(statuses: QuotaStatus[], now = new Date()): string {
  const rows = statuses.map((s) => {
    const rpd = s.limits.rpd ? `${s.rpd_used}/${s.limits.rpd}` : `${s.rpd_used}/∞`;
    const rpm = s.limits.rpm ? `${s.rpm_used}/${s.limits.rpm}` : `${s.rpm_used}/∞`;
    const tpm = s.limits.tpm ? `${s.tpm_used}/${s.limits.tpm}` : `${s.tpm_used}/∞`;
    const pct = s.limits.rpd ? Math.round((100 * s.rpd_used) / s.limits.rpd) : 0;
    // "no key" first, before any reading of the counters (ruling W4-13). A provider whose `api_key_env` is
    // unset cannot be called at all, and on 2026-09-14 every openrouter row here said "ok" while
    // `OPENROUTER_API_KEY` was empty — which is exactly what an idle cloud tier looks like.
    const status = s.missing_key ? 'no key' : s.cooling_until ? `cooling until ${s.cooling_until.slice(11, 19)}Z` : pct >= 90 ? 'nearly out' : 'ok';
    return `| ${s.provider} | ${s.model} | ${rpm} | ${rpd} | ${tpm} | ${status} |`;
  });
  return [
    '# Quota runway',
    '',
    `Updated ${now.toISOString()} by the router after every call. Limits are what \`config/providers.yaml\` declares; a 429 (or a 503 overload) marks a model cooling, and "no key" means the provider's API key is not set in \`.env\` so nothing here can be called at all.`,
    '',
    '| provider | model | calls/min | calls/day | tokens/min | status |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
