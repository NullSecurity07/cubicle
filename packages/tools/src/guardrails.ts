import type { Router } from '@cubicle/router';
import type { ToolContext } from './registry.js';
import { QuotaTracker } from '@cubicle/router';

export interface Guardrail {
  check(tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string | null> | string | null;
}

const OUTBOUND_TEXT_TOOLS: Record<string, string[]> = { 'email.send': ['subject', 'body', 'html'], 'social.post': ['title', 'body', 'text'], 'mock.outbound': ['body'] };

function textOf(tool: string, args: Record<string, unknown>): string {
  return (OUTBOUND_TEXT_TOOLS[tool] ?? []).map((k) => (typeof args[k] === 'string' ? args[k] : '')).join('\n').trim();
}

/** Ask the smallest local model whether text uses a banned tactic. Fails closed on an explicit "yes", open on no model. */
export async function classifyBannedTactic(router: Router, text: string, tactics: string[]): Promise<string | null> {
  if (!text || tactics.length === 0) return null;
  try {
    const r = await router.chat({ tier: 'local', needsTools: false, privacy: 'local', roleId: 'guardrail' }, {
      messages: [
        { role: 'system', content: 'You are a strict compliance checker. Answer with exactly one line of JSON: {"violates": true|false, "tactic": "<name or empty>"}.' },
        { role: 'user', content: `Banned tactics: ${tactics.join('; ')}.\n\nText:\n"""\n${text.slice(0, 4000)}\n"""\n\nDoes the text use any banned tactic?` },
      ], maxTokens: 60,
    });
    const m = r.content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]) as { violates?: boolean; tactic?: string };
    return j.violates ? `banned tactic detected: ${j.tactic || 'unspecified'}` : null;
  } catch {
    return null;
  }
}

/**
 * Constitution enforcement at the tool layer (spec §7): max_emails_per_day, banned_channels, banned_tactics
 * (local classifier), never_modify (vault guard already), pii_local_only (harness routing). Emits nothing itself;
 * the harness turns a non-null reason into `guardrail.blocked`.
 */
export function constitutionGuardrail(router?: Router): Guardrail {
  return {
    async check(tool, args, ctx) {
      const c = ctx.vault.constitution();
      if (tool === 'email.send' || tool === 'mock.outbound') {
        const since = QuotaTracker.dayStart(ctx.now(), 'UTC').toISOString();
        const sent = ctx.events.count('email.sent', since);
        if (c.max_emails_per_day >= 0 && sent >= c.max_emails_per_day) return `constitution: max_emails_per_day (${c.max_emails_per_day}) reached (${sent} sent today)`;
      }
      if (tool === 'social.post') {
        const channel = String(args.channel ?? args.site ?? '').toLowerCase();
        const banned = c.banned_channels.map((b) => b.toLowerCase());
        if (channel && banned.some((b) => channel.includes(b))) return `constitution: channel "${channel}" is banned`;
      }
      if (tool === 'proposal.create' && args.kind === 'hire') {
        const active = ctx.vault.list('Roles', { ext: '.md' }).filter((r) => !r.includes('/archive/')).filter((r) => /active:\s*true/.test(ctx.vault.readText(r))).length;
        if (active >= c.max_roles) return `constitution: max_roles (${c.max_roles}) reached`;
      }
      const text = textOf(tool, args);
      if (text && c.banned_tactics.length) {
        const lower = text.toLowerCase();
        const cheap = c.banned_tactics.find((t) => lower.includes(t.toLowerCase()));
        if (cheap) return `constitution: text mentions banned tactic "${cheap}"`;
        if (router) { const r = await classifyBannedTactic(router, text, c.banned_tactics); if (r) return `constitution: ${r}`; }
      }
      return null;
    },
  };
}
