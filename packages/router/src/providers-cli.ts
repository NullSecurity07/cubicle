import { readFileSync, writeFileSync } from 'node:fs';
import YAML, { Document, YAMLSeq, YAMLMap } from 'yaml';
import type { ProvidersFile } from './config.js';
import { chatOnce, apiKeyFor, RateLimitedError, ProviderError } from './client.js';

export interface ProviderTestRow {
  provider: string;
  model: string;
  tier: string;
  tools: string;
  ok: boolean;
  detail: string;
  ms: number;
}

/** Ping every enabled model with a one-word prompt and (for native-tools models) one tool call. */
export async function providersTest(config: ProvidersFile, env: NodeJS.ProcessEnv = process.env, opts: { toolsCheck?: boolean; only?: string } = {}): Promise<ProviderTestRow[]> {
  const rows: ProviderTestRow[] = [];
  for (const p of config.providers) {
    if (!p.enabled) { for (const m of p.models) rows.push({ provider: p.id, model: m.id, tier: m.tier, tools: m.tools, ok: false, detail: 'provider disabled', ms: 0 }); continue; }
    if (opts.only && p.id !== opts.only) continue;
    if (apiKeyFor(p, env) === null) { for (const m of p.models) rows.push({ provider: p.id, model: m.id, tier: m.tier, tools: m.tools, ok: false, detail: `no key (${p.api_key_env})`, ms: 0 }); continue; }
    for (const m of p.models) {
      if (!m.enabled) { rows.push({ provider: p.id, model: m.id, tier: m.tier, tools: m.tools, ok: false, detail: 'model disabled', ms: 0 }); continue; }
      const t0 = Date.now();
      try {
        const res = await chatOnce(p, m.id, { messages: [{ role: 'user', content: 'Reply with the single word: pong' }], maxTokens: 64 }, env);
        let detail = `"${res.content.trim().slice(0, 20)}" ${res.usage.prompt_tokens}/${res.usage.completion_tokens} tok`;
        if (opts.toolsCheck && m.tools === 'native') {
          const tr = await chatOnce(p, m.id, {
            messages: [{ role: 'user', content: 'Call the ping tool with value 1.' }],
            tools: [{ type: 'function', function: { name: 'ping', description: 'ping', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } } }],
            toolChoice: 'auto', maxTokens: 64,
          }, env);
          detail += tr.toolCalls.length ? ' tools:ok' : ' tools:NO-CALL';
        }
        rows.push({ provider: p.id, model: m.id, tier: m.tier, tools: m.tools, ok: true, detail, ms: Date.now() - t0 });
      } catch (err) {
        const e = err as Error;
        const detail = err instanceof RateLimitedError ? '429 rate limited' : err instanceof ProviderError ? `HTTP ${err.status ?? 'net'}: ${e.message.slice(0, 80)}` : e.message.slice(0, 80);
        rows.push({ provider: p.id, model: m.id, tier: m.tier, tools: m.tools, ok: false, detail, ms: Date.now() - t0 });
      }
    }
  }
  return rows;
}

export function formatTestRows(rows: ProviderTestRow[]): string {
  const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const lines = [`${w('provider', 12)}${w('model', 44)}${w('tier', 8)}${w('tools', 8)}${w('ok', 5)}detail`];
  for (const r of rows) lines.push(`${w(r.provider, 12)}${w(r.model, 44)}${w(r.tier, 8)}${w(r.tools, 8)}${w(r.ok ? 'yes' : 'no', 5)}${r.detail}${r.ms ? ` (${r.ms} ms)` : ''}`);
  return lines.join('\n');
}

interface OpenRouterModel { id: string; context_length?: number; supported_parameters?: string[]; name?: string }

/** Fetch OpenRouter's public model list and return the :free models. */
export async function fetchOpenRouterFree(fetchImpl: typeof fetch = fetch): Promise<OpenRouterModel[]> {
  const res = await fetchImpl('https://openrouter.ai/api/v1/models');
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
  const j = (await res.json()) as { data: OpenRouterModel[] };
  return j.data.filter((m) => m.id.endsWith(':free')).sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
}

/**
 * Rewrite the `openrouter` provider's `models` block in providers.yaml from the live :free list,
 * preserving every other provider, comments, and any manual entries marked `manual: true`.
 */
export function refreshOpenRouterBlock(yamlText: string, free: OpenRouterModel[], today = new Date().toISOString().slice(0, 10), maxModels = 8): string {
  const doc: Document = YAML.parseDocument(yamlText);
  const providers = doc.get('providers') as YAMLSeq | undefined;
  if (!providers) throw new Error('providers.yaml has no providers list');
  const or = providers.items.find((it) => (it as YAMLMap).get('id') === 'openrouter') as YAMLMap | undefined;
  if (!or) throw new Error('providers.yaml has no openrouter provider');
  const existing = (or.get('models') as YAMLSeq | undefined)?.items ?? [];
  const manual = existing.filter((it) => (it as YAMLMap).get('manual') === true);
  const picked = free.slice(0, maxModels).map((m) => {
    const ctx = m.context_length ?? 8192;
    const tools = m.supported_parameters?.includes('tools') ? 'native' : 'json';
    const tier = ctx >= 200_000 ? 'medium' : 'cheap';
    return doc.createNode({ id: m.id, tier, tools, context: ctx, max_prompt_tokens: Math.min(32000, Math.floor(ctx / 4)), limits: { rpm: 20, rpd: 50 } });
  });
  const seq = doc.createNode([...manual, ...picked]) as YAMLSeq;
  or.set('models', seq);
  or.set('note', `free list refreshed ${today} from https://openrouter.ai/api/v1/models (${free.length} :free models found)`);
  return doc.toString({ lineWidth: 0 });
}

export async function providersRefresh(file: string, fetchImpl: typeof fetch = fetch): Promise<{ count: number }> {
  const free = await fetchOpenRouterFree(fetchImpl);
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, refreshOpenRouterBlock(text, free));
  return { count: free.length };
}
