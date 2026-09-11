import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { ModelTier } from '@cubicle/core';

export const ToolCapability = z.enum(['native', 'json', 'none']);
export type ToolCapability = z.infer<typeof ToolCapability>;

export const ModelLimits = z.object({
  rpm: z.number().int().min(0).default(0),
  rpd: z.number().int().min(0).default(0),
  tpm: z.number().int().min(0).default(0),
  tpd: z.number().int().min(0).default(0),
});

/**
 * What a paid model costs, in **integer cents per million tokens**. Absent means free, which is every model
 * `config/providers.yaml` ships today. Prices are a fact the owner supplies: a remembered vendor price goes
 * stale and would put a wrong runway in front of them.
 */
export const ModelPrice = z.object({
  input_per_mtok: z.number().int().min(0),
  output_per_mtok: z.number().int().min(0),
});
export type ModelPrice = z.infer<typeof ModelPrice>;

export const ModelConfig = z.object({
  id: z.string(),
  tier: ModelTier,
  tools: ToolCapability.default('json'),
  context: z.number().int().min(1).default(8192),
  max_prompt_tokens: z.number().int().min(256).default(6000),
  max_output_tokens: z.number().int().min(16).default(4096),
  limits: ModelLimits.default({ rpm: 0, rpd: 0, tpm: 0, tpd: 0 }),
  enabled: z.boolean().default(true),
  /** Cents per million tokens. No `price:` means the model is free and costs 0. */
  price: ModelPrice.optional(),
  note: z.string().optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const ProviderConfig = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  base_url: z.string().url(),
  api_key_env: z.string().optional(),
  privacy: z.enum(['cloud', 'local']).default('cloud'),
  /** Request timeout for this provider (local models on small GPUs can be slow). */
  timeout_ms: z.number().int().min(1000).default(60_000),
  /** Account-wide limits summed across the provider's models (e.g. OpenRouter's 50 RPD per account). */
  limits: ModelLimits.optional(),
  /** IANA time zone in which daily limits reset (UTC if unknown). */
  day_reset_tz: z.string().default('UTC'),
  models: z.array(ModelConfig).default([]),
  embeddings: z.object({ id: z.string(), endpoint: z.string().optional(), dims: z.number().int().optional() }).optional(),
  note: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const ProvidersFile = z.object({
  verified: z.string().optional(),
  /** When the `price:` blocks below were last checked against the vendors. Absent: no model carries a price. */
  prices_verified: z.string().optional(),
  cascade: z.array(z.string()).default([]),
  providers: z.array(ProviderConfig),
});
export type ProvidersFile = z.infer<typeof ProvidersFile>;

export const TIER_RANK: Record<ModelTier, number> = { strong: 3, medium: 2, cheap: 1, local: 0 };

export function loadProvidersConfig(file: string): ProvidersFile {
  const doc = YAML.parse(readFileSync(file, 'utf8'));
  const parsed = ProvidersFile.parse(doc);
  if (parsed.cascade.length === 0) parsed.cascade = parsed.providers.map((p) => p.id);
  return parsed;
}

export function parseProvidersConfig(text: string): ProvidersFile {
  const parsed = ProvidersFile.parse(YAML.parse(text));
  if (parsed.cascade.length === 0) parsed.cascade = parsed.providers.map((p) => p.id);
  return parsed;
}
