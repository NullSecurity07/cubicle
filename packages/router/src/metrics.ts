import type { QuotaStatus } from './quota.js';

/**
 * One job the company cannot run because no model would take it — `blocked_on: {kind: 'quota'}` on the job note.
 * The router has no vault, so whoever writes `Metrics/quota.md` hands these in.
 */
export interface QuotaBlockedJob { id: string; title: string; since: string }

/**
 * What a model's row says in the `status` column.
 *
 * **Every** limit, not only the day's (ruling W6-8). On 2026-09-18 a discovery job sat blocked on
 * `all-providers` for two hours while this file called `gemini-3.5-flash-lite` "ok" at `15/15` calls a minute —
 * saturated, refused by `hasHeadroom` on every single attempt, and reported to the owner as healthy. The two
 * views of one fact disagreed, and the owner-facing one was the wrong one.
 */
export function quotaRowStatus(s: QuotaStatus): string {
  if (s.missing_key) return 'no key';                       // cannot be called at all, whatever the counters say
  if (s.cooling_until) return `cooling until ${s.cooling_until.slice(11, 19)}Z`;
  const at = (used: number, limit: number) => limit > 0 && used >= limit;
  if (at(s.rpd_used, s.limits.rpd)) return 'out for today';
  if (at(s.tpd_used, s.limits.tpd)) return 'out of tokens for today';
  if (at(s.rpm_used, s.limits.rpm)) return 'at its minute limit';
  if (at(s.tpm_used, s.limits.tpm)) return 'at its token-a-minute limit';
  if (s.limits.rpd > 0 && (100 * s.rpd_used) / s.limits.rpd >= 90) return 'nearly out';
  return 'ok';
}

/** Render Metrics/quota.md — the company's "runway" in free calls instead of dollars. */
export function renderQuotaMarkdown(statuses: QuotaStatus[], now = new Date(), blocked: QuotaBlockedJob[] = []): string {
  const rows = statuses.map((s) => {
    const rpd = s.limits.rpd ? `${s.rpd_used}/${s.limits.rpd}` : `${s.rpd_used}/∞`;
    const rpm = s.limits.rpm ? `${s.rpm_used}/${s.limits.rpm}` : `${s.rpm_used}/∞`;
    const tpm = s.limits.tpm ? `${s.tpm_used}/${s.limits.tpm}` : `${s.tpm_used}/∞`;
    return `| ${s.provider} | ${s.model} | ${rpm} | ${rpd} | ${tpm} | ${quotaRowStatus(s)} |`;
  });
  // The other half of ruling W6-8: nothing in this note ever said that a job had *stopped* for want of a
  // provider. The table is a gauge; this line is the consequence, and it is what the owner came here to read.
  const stalled = blocked.length
    ? ['', `**${blocked.length} job${blocked.length === 1 ? ' is' : 's are'} stopped waiting for model quota.** They start again on their own as the windows below reset.`, '',
       ...blocked.map((b) => `- ${b.title} (\`${b.id}\`) — waiting since ${b.since.slice(11, 19)}Z`)]
    : [];
  return [
    '# Quota runway',
    '',
    `Updated ${now.toISOString()} by the router after every call. Limits are what \`config/providers.yaml\` declares; a 429 (or a 503 overload) marks a model cooling, "no key" means the provider's API key is not set in \`.env\` so nothing here can be called at all, and a model at any one of its limits is not callable until that window rolls over.`,
    ...stalled,
    '',
    '| provider | model | calls/min | calls/day | tokens/min | status |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
