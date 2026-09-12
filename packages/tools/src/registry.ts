import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import { ApprovalMode, type Vault, type EventLog, type RoleFrontmatter, type ProposalKind, type OwnerPreferences, type ResearchRequest, type ModelTier } from '@cubicle/core';
import type { Router } from '@cubicle/router';
import type { Guardrail } from './guardrails.js';

// ---------- tools.yaml ----------
export const ToolPolicy = z.object({
  mode: ApprovalMode.default('auto'),
  outbound: z.boolean().default(false),
  /**
   * SP5: this tool leaves the company, so every call needs the compliance office and the security office to have
   * read the exact arguments first (`trustReviewsFor` refines it per call — a `deploy.site` preview does not).
   * Enforced unconditionally in `mcp.ts`, beside the `mode: never` checks, so no caller can forget it.
   */
  trust_review: z.boolean().default(false),
  proposal_kind: z.string().optional(),
  owner_owned_mode: ApprovalMode.optional(),
  first_time_only: z.boolean().default(false), // first-time propose is implemented in the harness loop
  roles: z.array(z.string()).optional(),
});
export type ToolPolicy = z.infer<typeof ToolPolicy>;

export const ToolsConfig = z.object({
  tools: z.record(z.string(), ToolPolicy),
  sandbox_allowlist: z.array(z.string()).default([]),
  http_fetch: z.object({
    max_bytes: z.number().int().default(400000),
    timeout_ms: z.number().int().default(20000),
    per_host_interval_ms: z.number().int().default(1000),
    user_agent: z.string().default('cubicle-bot/0.1'),
  }).default({ max_bytes: 400000, timeout_ms: 20000, per_host_interval_ms: 1000, user_agent: 'cubicle-bot/0.1' }),
});
export type ToolsConfig = z.infer<typeof ToolsConfig>;

export function loadToolsConfig(file: string): ToolsConfig {
  return ToolsConfig.parse(YAML.parse(readFileSync(file, 'utf8')));
}

export function parseToolsConfig(text: string): ToolsConfig {
  return ToolsConfig.parse(YAML.parse(text));
}

// ---------- approval resolution ----------
const ORDER: Record<ApprovalMode, number> = { auto: 0, propose: 1, ask: 2, never: 3 };

/**
 * Resolve the effective approval mode: tools.yaml → charter approval_overrides → owner preferences.
 * A `never` in tools.yaml cannot be loosened by anyone; a role may not loosen what tools.yaml set either
 * (roles can only tighten); the owner may loosen or tighten anything except a config-level `never`.
 */
export function resolveMode(tool: string, cfg: ToolsConfig, role?: Pick<RoleFrontmatter, 'approval_overrides'>, prefs?: Pick<OwnerPreferences, 'approvals'>): ApprovalMode {
  const base = cfg.tools[tool]?.mode ?? 'auto';
  if (base === 'never') return 'never';
  let mode: ApprovalMode = base;
  const roleMode = role?.approval_overrides?.[tool];
  if (roleMode && ORDER[roleMode] > ORDER[mode]) mode = roleMode; // roles may only tighten
  const ownerMode = prefs?.approvals?.[tool];
  if (ownerMode) mode = ownerMode; // owner is authoritative (except config never, handled above)
  return mode;
}

// ---------- tool definitions ----------
export interface ToolResult {
  ok: boolean;
  text: string;
  data?: unknown;
  /** Set by handlers that performed an external side effect. */
  sideEffectKey?: string;
  /**
   * Set by the MCP wrapper when it refused the call, carrying the reason. Its presence is a guarantee that
   * the handler never ran, so a caller that recorded an idempotency key up front knows nothing happened.
   */
  guardrailBlocked?: string;
  /** Set by colleague.message(kind: question) etc. to block the calling job. */
  block?: { kind: 'message' | 'job' | 'proposal'; id: string };
  /** Set by `finish`. */
  finished?: boolean;
}

export interface SchedulerApi {
  enqueue(job: { id?: string; type: string; title: string; assigned: string; goal: string; priority?: number; depends_on?: string[]; privacy?: 'cloud' | 'local'; parent?: string; links?: string[]; team?: string; owner_role?: string; for?: string; done_when?: string; risk?: 'low' | 'medium' | 'high'; stream?: string; research?: ResearchRequest; research_slug?: string; model_tier?: ModelTier }): string;
  reprioritize?(jobId: string, priority: number): void;
}

export interface MemoryApi {
  search(query: string, k?: number, dirs?: string[]): Promise<{ path: string; text: string; score: number }[]>;
  indexFile?(rel: string): Promise<void>;
}

export interface ToolContext {
  vault: Vault;
  events: EventLog;
  roleId: string;
  role: RoleFrontmatter;
  jobId: string | null;
  config: ToolsConfig;
  router?: Router;
  scheduler: SchedulerApi;
  memory?: MemoryApi;
  env: NodeJS.ProcessEnv;
  /** Idempotency key for outbound tools, supplied by the harness per call. */
  idempotencyKey?: string;
  /** Vault-relative working directory for the job (scratch). */
  workspace: string;
  /**
   * Constitution guardrails. The MCP wrapper runs these before every handler, so a tool call made
   * outside the harness loop is enforced too (spec §7: `never` and the constitution live in the tool layer).
   */
  guardrails?: Guardrail[];
  now(): Date;
}

export interface ToolDefinition<S extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>;
}

export function defineTool<S extends ZodRawShape>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDefinition<any>;

export class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  register(def: AnyTool): this {
    this.tools.set(def.name, def);
    return this;
  }

  registerAll(defs: AnyTool[]): this {
    for (const d of defs) this.register(d);
    return this;
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Tools a role may see: charter `tools` list with `prefix.*` wildcards, intersected with policy `roles` restrictions. */
  forRole(role: RoleFrontmatter, cfg: ToolsConfig): AnyTool[] {
    const allowed = (name: string) => role.tools.some((pat) => pat === name || (pat.endsWith('.*') && name.startsWith(pat.slice(0, -1))));
    return [...this.tools.values()].filter((t) => {
      if (!allowed(t.name)) return false;
      const pol = cfg.tools[t.name];
      if (pol?.roles && !pol.roles.includes(role.role)) return false;
      return true;
    });
  }
}

export function policyFor(cfg: ToolsConfig, tool: string): ToolPolicy {
  return cfg.tools[tool] ?? ToolPolicy.parse({});
}

export function proposalKindFor(cfg: ToolsConfig, tool: string): ProposalKind {
  return (cfg.tools[tool]?.proposal_kind ?? 'outbound_batch') as ProposalKind;
}
