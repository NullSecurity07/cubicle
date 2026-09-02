import type { Vault } from '@cubicle/core';
import { hasEnv, mockLog, fetchJson } from './common.js';

export interface PaymentLinkRequest { name: string; amountCents: number; currency: string; description?: string; idempotencyKey: string }
export interface PaymentLinks { mode: 'mock' | 'live'; create(vault: Vault, r: PaymentLinkRequest): Promise<{ ok: boolean; url?: string; id?: string; detail: string }> }

function form(o: Record<string, string | number>): string {
  return Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

/**
 * Stripe Payment Links: product → price → payment_link (form-encoded, Idempotency-Key header). Test-mode keys
 * (sk_test_…) create test links; the tool never touches card data. Body shape per the API reference [A22].
 */
export function paymentLinks(env: NodeJS.ProcessEnv): PaymentLinks {
  if (hasEnv(env, 'STRIPE_SECRET_KEY')) {
    const key = env.STRIPE_SECRET_KEY!;
    const call = (path: string, body: Record<string, string | number>, idem: string) => fetchJson(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idem }, body: form(body) });
    return {
      mode: 'live',
      async create(_vault, r) {
        const prod = await call('products', { name: r.name, ...(r.description ? { description: r.description } : {}) }, `${r.idempotencyKey}:product`);
        if (prod.status >= 300) return { ok: false, detail: `Stripe product HTTP ${prod.status}: ${prod.text.slice(0, 200)}` };
        const productId = (prod.json as { id: string }).id;
        const price = await call('prices', { product: productId, unit_amount: r.amountCents, currency: r.currency.toLowerCase() }, `${r.idempotencyKey}:price`);
        if (price.status >= 300) return { ok: false, detail: `Stripe price HTTP ${price.status}: ${price.text.slice(0, 200)}` };
        const priceId = (price.json as { id: string }).id;
        const link = await call('payment_links', { 'line_items[0][price]': priceId, 'line_items[0][quantity]': 1 }, `${r.idempotencyKey}:link`);
        if (link.status >= 300) return { ok: false, detail: `Stripe payment_link HTTP ${link.status}: ${link.text.slice(0, 200)}` };
        const j = link.json as { id: string; url: string };
        return { ok: true, url: j.url, id: j.id, detail: `created ${j.url}${key.startsWith('sk_test') ? ' (test mode)' : ''}` };
      },
    };
  }
  return {
    mode: 'mock',
    async create(vault, r) {
      const url = `https://buy.stripe.com/test_mock_${r.idempotencyKey.replace(/[^a-z0-9]/gi, '').slice(-12)}`;
      mockLog(vault, 'stripe', { key: r.idempotencyKey, name: r.name, amount_cents: r.amountCents, currency: r.currency, url });
      return { ok: true, url, id: `plink_mock`, detail: `MOCK (no STRIPE_SECRET_KEY): ${url}` };
    },
  };
}
