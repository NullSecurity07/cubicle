import type { Vault } from '@cubicle/core';
import { mockLog, hasEnv, fetchJson } from './common.js';

export interface OutgoingEmail { to: string; toName?: string; subject: string; text: string; html?: string; idempotencyKey: string; replyTo?: string }
export interface EmailSender { mode: 'mock' | 'live'; send(vault: Vault, m: OutgoingEmail): Promise<{ ok: boolean; id?: string; detail: string }> }

/** Brevo transactional send — endpoint/headers/fields verified 2026-09-02 (POST /v3/smtp/email, header api-key). */
export function emailSender(env: NodeJS.ProcessEnv): EmailSender {
  if (hasEnv(env, 'BREVO_API_KEY', 'BREVO_SENDER_EMAIL')) {
    return {
      mode: 'live',
      async send(_vault, m) {
        const body = {
          sender: { name: env.BREVO_SENDER_NAME || env.BREVO_SENDER_EMAIL, email: env.BREVO_SENDER_EMAIL },
          to: [{ email: m.to, name: m.toName || m.to }],
          subject: m.subject,
          textContent: m.text,
          ...(m.html ? { htmlContent: m.html } : {}),
          ...(m.replyTo ? { replyTo: { email: m.replyTo } } : {}),
          headers: { 'X-Cubicle-Idempotency-Key': m.idempotencyKey },
        };
        const r = await fetchJson('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
        const id = (r.json as { messageId?: string } | null)?.messageId;
        return { ok: r.status >= 200 && r.status < 300, id, detail: r.status >= 300 ? `Brevo HTTP ${r.status}: ${r.text.slice(0, 200)}` : `sent (messageId ${id ?? '?'})` };
      },
    };
  }
  return {
    mode: 'mock',
    async send(vault, m) {
      const rel = mockLog(vault, 'email', { key: m.idempotencyKey, to: m.to, subject: m.subject, text: m.text.slice(0, 2000) });
      return { ok: true, id: `mock-${m.idempotencyKey}`, detail: `MOCK (no BREVO_API_KEY): recorded to ${rel}` };
    },
  };
}

export const UNSUBSCRIBE_FOOTER = (sender: string) => `\n\n--\nYou received this because we thought it might be relevant to you. Reply "unsubscribe" and you will never hear from us again. ${sender}`;

/** Suppression list: one address per line in Customers/_suppression.md (comments and blank lines ignored). */
export function suppressed(vault: Vault, email: string): boolean {
  const text = vault.readTextOrNull('Customers/_suppression.md') ?? '';
  const e = email.trim().toLowerCase();
  return text.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#') && l.includes('@')).some((l) => l === e || l.replace(/^-\s*/, '') === e);
}

export function addSuppression(vault: Vault, email: string, by: string): void {
  if (suppressed(vault, email)) return;
  vault.appendText('Customers/_suppression.md', `${email.trim().toLowerCase()}\n`, by);
}
