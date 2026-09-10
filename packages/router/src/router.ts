import type { EventLog, ModelTier } from '@cubicle/core';
import { TIER_RANK, type ModelConfig, type ProviderConfig, type ProvidersFile } from './config.js';
import { QuotaTracker, estimateTokens } from './quota.js';
import { chatOnce, apiKeyFor, RateLimitedError, ProviderError, type ChatRequest, type ChatResult } from './client.js';
import { buildJsonToolInstruction, parseJsonToolReply, type ToolSchema } from './jsontools.js';

export interface RouteRequest {
  tier: ModelTier;
  needsTools: boolean;
  maxContext?: number;
  roleId?: string;
  privacy?: 'cloud' | 'local';
  /** Providers to skip (already failed this call). */
  exclude?: string[];
}

export interface Candidate {
  provider: ProviderConfig;
  model: ModelConfig;
}

export interface RoutedChatResult extends ChatResult {
  provider: string;
  model: string;
  tier: ModelTier;
  downgraded: boolean;
  /** Tool calls parsed from a `tools: json` model reply, unified with native ones. */
  parsedToolCalls: { name: string; args: Record<string, unknown> }[];
  jsonParseError?: string;
  /** A `tools: json` model answered with {"final": ...} — an explicit finish signal, content holds the text. */
  finalAnswer?: boolean;
}

export interface RouterOptions {
  env?: NodeJS.ProcessEnv;
  events?: EventLog;
  now?: () => Date;
  backoffBaseMs?: number;
}

export class NoModelAvailableError extends Error {
  constructor(public readonly tried: string[]) {
    super(`No model available. Tried: ${tried.join(', ') || 'none'}`);
    this.name = 'NoModelAvailableError';
  }
}

/**
 * Quota-aware, capability-aware model router. Order: cascade providers, same tier first, then downgrade.
 * Every call is recorded; 429s and 503s mark the model cooling; failures cascade to the next candidate.
 */
export class Router {
  private env: NodeJS.ProcessEnv;
  private events?: EventLog;
  private now: () => Date;
  private backoffBaseMs: number;
  private attemptCounts = new Map<string, number>();

  constructor(public readonly config: ProvidersFile, public readonly quota: QuotaTracker, opts: RouterOptions = {}) {
    this.env = opts.env ?? process.env;
    this.events = opts.events;
    this.now = opts.now ?? (() => new Date());
    this.backoffBaseMs = opts.backoffBaseMs ?? 2000;
  }

  /** Every configured provider in cascade order (those absent from `cascade:` trail in file order). */
  private orderedProviders(): ProviderConfig[] {
    const byId = new Map(this.config.providers.map((p) => [p.id, p]));
    const ordered = this.config.cascade.map((id) => byId.get(id)).filter((p): p is ProviderConfig => !!p);
    for (const p of this.config.providers) if (!ordered.includes(p)) ordered.push(p);
    return ordered;
  }

  /** Enabled providers with a usable key, in cascade order. */
  availableProviders(): ProviderConfig[] {
    return this.orderedProviders().filter((p) => p.enabled && apiKeyFor(p, this.env) !== null);
  }

  /**
   * Enabled providers whose `api_key_env` is unset (or blank) in this router's env. `availableProviders` drops
   * them silently, which is right for routing but wrong for the owner: a live run spent three days on the local
   * floor because `.env` was blank, while Metrics/quota.md showed Gemini "ok 0/250" and nothing said why. The
   * daemon logs and warns from this list at start. Keyless providers (ollama) have nothing to miss and never appear.
   */
  missingKeyProviders(): { id: string; env: string }[] {
    return this.orderedProviders()
      .filter((p) => p.enabled && p.api_key_env && apiKeyFor(p, this.env) === null)
      .map((p) => ({ id: p.id, env: p.api_key_env! }));
  }

  /** Candidate list for a request: same-or-higher tier first (closest tier first), then lower tiers. */
  candidates(req: RouteRequest): Candidate[] {
    const want = TIER_RANK[req.tier];
    const all: Candidate[] = [];
    for (const provider of this.availableProviders()) {
      if (req.exclude?.includes(provider.id)) continue;
      if (req.privacy === 'local' && provider.privacy !== 'local') continue;
      for (const model of provider.models) {
        if (!model.enabled) continue;
        if (req.needsTools && model.tools === 'none') continue;
        if (req.maxContext && model.context < req.maxContext) continue;
        all.push({ provider, model });
      }
    }
    const rank = (c: Candidate) => TIER_RANK[c.model.tier];
    const atOrAbove = all.filter((c) => rank(c) >= want).sort((a, b) => rank(a) - rank(b)); // closest tier first, stable = cascade order
    const below = all.filter((c) => rank(c) < want).sort((a, b) => rank(b) - rank(a));   // best lower tier first
    return [...atOrAbove, ...below];
  }

  /** Prompt budget for a request: the smallest max_prompt_tokens among the top same-tier candidates (so context fits whichever answers). */
  promptBudget(req: RouteRequest): number {
    const cands = this.candidates(req);
    if (cands.length === 0) return 6000;
    const want = TIER_RANK[req.tier];
    const top = cands.filter((c) => TIER_RANK[c.model.tier] >= want);
    const pool = (top.length ? top : cands).slice(0, 3);
    return Math.min(...pool.map((c) => c.model.max_prompt_tokens));
  }

  /** Pick the first candidate with quota headroom. */
  route(req: RouteRequest, estimatedTokens = 1000): Candidate | null {
    for (const c of this.candidates(req)) {
      if (this.quota.hasHeadroom(c.provider.id, c.model, estimatedTokens, c.provider).ok) return c;
    }
    return null;
  }

  /**
   * Run a chat completion through the cascade. `tools` are given as neutral schemas; for `native` models they
   * become OpenAI tools, for `json` models they are injected into the prompt and the reply is parsed.
   */
  async chat(req: RouteRequest, chat: Omit<ChatRequest, 'tools'> & { tools?: ToolSchema[] }): Promise<RoutedChatResult> {
    const promptText = chat.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n');
    const est = estimateTokens(promptText) + (chat.maxTokens ?? 1024);
    const tried: string[] = [];
    const cands = this.candidates(req);
    if (cands.length === 0) throw new NoModelAvailableError(tried);
    const wantRank = TIER_RANK[req.tier];
    let downgradedLogged = false;

    for (const c of cands) {
      const key = `${c.provider.id}/${c.model.id}`;
      const head = this.quota.hasHeadroom(c.provider.id, c.model, est, c.provider);
      if (!head.ok) { tried.push(`${key} (${head.reason})`); continue; }
      const isDowngrade = TIER_RANK[c.model.tier] < wantRank;
      if (isDowngrade && !downgradedLogged) {
        this.events?.emit({ type: 'router.downgraded', agent: req.roleId ?? null, payload: { requested_tier: req.tier, chosen_tier: c.model.tier, provider: c.provider.id, model: c.model.id, tried } });
        downgradedLogged = true;
      }
      // Build the provider-specific request
      let messages = chat.messages;
      let nativeTools: ChatRequest['tools'];
      const useJsonTools = !!chat.tools?.length && c.model.tools === 'json';
      if (chat.tools?.length && c.model.tools === 'native') {
        nativeTools = chat.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
      } else if (useJsonTools) {
        // Append to the existing system message so the constitution stays first (spec §6 order).
        const instr = buildJsonToolInstruction(chat.tools!);
        const first = chat.messages[0];
        messages = first && first.role === 'system' && typeof first.content === 'string'
          ? [{ role: 'system', content: `${first.content}\n\n# Tool protocol\n${instr}` }, ...chat.messages.slice(1)]
          : [{ role: 'system', content: instr }, ...chat.messages];
      }
      const maxTokens = Math.min(chat.maxTokens ?? c.model.max_output_tokens, c.model.max_output_tokens);
      try {
        const res = await chatOnce(c.provider, c.model.id, { ...chat, messages, tools: nativeTools, maxTokens, responseFormatJson: useJsonTools && chat.responseFormatJson !== false ? false : chat.responseFormatJson }, this.env);
        this.quota.record(c.provider.id, c.model.id, res.usage.prompt_tokens, res.usage.completion_tokens, true);
        this.attemptCounts.delete(key);
        this.events?.emit({ type: 'router.call', agent: req.roleId ?? null, payload: { provider: c.provider.id, model: c.model.id, tier: c.model.tier, tokens: res.usage, tools: c.model.tools, downgraded: isDowngrade } });
        this.emitQuotaUpdated(c);
        const parsed: RoutedChatResult['parsedToolCalls'] = [];
        let jsonParseError: string | undefined;
        let finalAnswer = false;
        if (nativeTools) {
          for (const tc of res.toolCalls) {
            try { parsed.push({ name: tc.name, args: tc.arguments ? JSON.parse(tc.arguments) : {} }); }
            catch { const r = parseJsonToolReply(tc.arguments); parsed.push({ name: tc.name, args: r.kind === 'tool' ? r.args : {} }); }
          }
        } else if (useJsonTools) {
          const r = parseJsonToolReply(res.content);
          if (r.kind === 'tool') parsed.push({ name: r.name, args: r.args });
          else if (r.kind === 'final') { res.content = r.text; finalAnswer = true; }
          else jsonParseError = r.reason;
        }
        return { ...res, provider: c.provider.id, model: c.model.id, tier: c.model.tier, downgraded: isDowngrade, parsedToolCalls: parsed, jsonParseError, finalAnswer };
      } catch (err) {
        if (err instanceof RateLimitedError) {
          const n = (this.attemptCounts.get(key) ?? 0) + 1;
          this.attemptCounts.set(key, n);
          const backoff = err.retryAfterMs ?? Math.min(this.backoffBaseMs * 2 ** (n - 1), 15 * 60_000);
          this.quota.setCooling(c.provider.id, c.model.id, new Date(this.now().getTime() + backoff));
          this.quota.record(c.provider.id, c.model.id, 0, 0, false);
          this.events?.emit({ type: 'quota.updated', payload: { provider: c.provider.id, model: c.model.id, cooling_ms: backoff, reason: '429' } });
          tried.push(`${key} (429)`);
          continue;
        }
        if (err instanceof ProviderError) {
          this.quota.record(c.provider.id, c.model.id, 0, 0, false);
          this.events?.emit({ type: 'daemon.warning', payload: { provider: c.provider.id, model: c.model.id, status: err.status, message: err.message.slice(0, 300) } });
          if (err.permanent && err.status === 401) {
            // Bad key: skip the whole provider for this call
            tried.push(`${key} (401)`);
            continue;
          }
          if (err.status === 503 || err.status === 502 || err.status === 529) {
            // "High demand" lasts minutes, not one request: without a cooling mark every call re-pays the failed
            // round-trip before cascading (a live day showed 162 downgrades in 244 calls). Same backoff ladder as
            // 429, capped lower — overload clears sooner than a quota does.
            const n = (this.attemptCounts.get(key) ?? 0) + 1;
            this.attemptCounts.set(key, n);
            const backoff = Math.min(this.backoffBaseMs * 15 * 2 ** (n - 1), 5 * 60_000);
            this.quota.setCooling(c.provider.id, c.model.id, new Date(this.now().getTime() + backoff));
            this.events?.emit({ type: 'quota.updated', payload: { provider: c.provider.id, model: c.model.id, cooling_ms: backoff, reason: String(err.status) } });
          }
          tried.push(`${key} (${err.status ?? 'net'})`);
          continue;
        }
        throw err;
      }
    }
    throw new NoModelAvailableError(tried);
  }

  private emitQuotaUpdated(c: Candidate): void {
    if (!this.events) return;
    const s = this.quota.status(c.provider.id, c.model);
    this.events.emit({ type: 'quota.updated', payload: { ...s } });
  }

  /** Snapshot of every enabled model's quota status, for the bank and Metrics/quota.md. */
  quotaSnapshot(): ReturnType<QuotaTracker['status']>[] {
    const out = [];
    for (const p of this.config.providers) {
      if (!p.enabled) continue;
      for (const m of p.models) if (m.enabled) out.push(this.quota.status(p.id, m, p.day_reset_tz));
    }
    return out;
  }
}
