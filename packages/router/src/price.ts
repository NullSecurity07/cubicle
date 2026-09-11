import type { ModelConfig, ProvidersFile } from './config.js';

/**
 * What a model call costs, in exact integer arithmetic.
 *
 * `price` is **cents per million tokens**, so `price × tokens` is already an exact integer count of
 * *micro-cents* (1e-6 of a cent) with no division anywhere. Rounding happens once, at the end of a sum, which
 * is why `shadowCost` adds micro-cents and converts at the very end: rounding each call to whole cents first
 * would turn a thousand half-cent calls into nothing at all.
 *
 * A model with no `price:` is free and costs 0. Today that is every model `config/providers.yaml` ships.
 */

export interface CallUsage { prompt_tokens: number; completion_tokens: number }

/** Cost of one call in micro-cents. Exact: no floats, no division. */
export function modelCostMicro(model: Pick<ModelConfig, 'price'>, usage: CallUsage): number {
  const p = model.price;
  if (!p) return 0;
  return Math.max(0, Math.trunc(usage.prompt_tokens)) * p.input_per_mtok + Math.max(0, Math.trunc(usage.completion_tokens)) * p.output_per_mtok;
}

/** Micro-cents to whole cents, rounded once. */
export function microToCents(micro: number): number {
  return Math.round(micro / 1_000_000);
}

export function findModel(cfg: ProvidersFile, provider: string, model: string): ModelConfig | null {
  return cfg.providers.find((p) => p.id === provider)?.models.find((m) => m.id === model) ?? null;
}

export interface RecordedCall { provider: string; model: string; prompt_tokens: number; completion_tokens: number }

/**
 * What a list of calls would have cost on the prices in `config/providers.yaml`. Never a ledger entry — no
 * money moved — only the number the CFO uses to say what a paid tier would have cost.
 */
export function shadowCost(cfg: ProvidersFile, calls: RecordedCall[]): { cents: number; paidCalls: number } {
  let micro = 0;
  let paidCalls = 0;
  for (const c of calls) {
    const m = findModel(cfg, c.provider, c.model);
    if (!m?.price) continue;
    micro += modelCostMicro(m, c);
    paidCalls++;
  }
  return { cents: microToCents(micro), paidCalls };
}

/** Whether any model anywhere carries a price. False on the shipped file, and the runway note says so. */
export function hasPrices(cfg: ProvidersFile): boolean {
  return cfg.providers.some((p) => p.models.some((m) => !!m.price));
}
