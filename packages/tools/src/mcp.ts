import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolveMode, type AnyTool, type ToolContext, type ToolResult } from './registry.js';

export interface RoleToolClient {
  client: Client;
  server: McpServer;
  /** JSON-schema tool list as MCP reports it (used for native tools and the JSON-tool prompt). */
  listTools(): Promise<{ name: string; description: string; parameters: Record<string, unknown> }[]>;
  call(name: string, args: Record<string, unknown>, ctxOverride?: Partial<ToolContext>): Promise<ToolResult>;
  close(): Promise<void>;
}

/**
 * Build an in-process MCP server exposing exactly `defs`, connected to a client over InMemoryTransport.
 * Every tool call carries the ToolContext (per role + job); the harness swaps `idempotencyKey` per call.
 */
export async function createRoleToolClient(defs: AnyTool[], baseCtx: ToolContext): Promise<RoleToolClient> {
  const server = new McpServer({ name: `cubicle-${baseCtx.roleId}`, version: '0.1.0' });
  let ctx: ToolContext = baseCtx;
  const results = new Map<string, ToolResult>();
  for (const def of defs) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.schema }, (async (args: Record<string, unknown>) => {
      const callId = `${def.name}#${Math.random().toString(36).slice(2)}`;
      let res: ToolResult;
      const refuse = (reason: string): ToolResult => {
        ctx.events.emit({ type: 'guardrail.blocked', agent: ctx.roleId, job: ctx.jobId, payload: { tool: def.name, reason } });
        return { ok: false, text: `blocked: ${reason}` };
      };
      try {
        // Spec §7: `never` and the constitution are enforced *in the tool layer*, so a call made outside
        // the harness loop (daemon system tools, an approved stored call) inherits them too. Callers that
        // block before calling (the harness pre-check) never reach here, so no event is emitted twice.
        res = await (async () => {
          if (resolveMode(def.name, ctx.config, ctx.role) === 'never') return refuse('mode never');
          for (const g of ctx.guardrails ?? []) {
            const veto = await g.check(def.name, args, ctx);
            if (veto) return refuse(veto);
          }
          return def.handler(args as never, ctx);
        })();
      } catch (err) {
        res = { ok: false, text: `tool error: ${(err as Error).message}` };
      }
      results.set(callId, res);
      return { content: [{ type: 'text' as const, text: res.text }], structuredContent: undefined, _meta: { callId }, isError: !res.ok };
    }) as never);
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `cubicle-${baseCtx.roleId}-client`, version: '0.1.0' });
  await server.connect(st);
  await client.connect(ct);
  return {
    client, server,
    async listTools() {
      const r = await client.listTools();
      return r.tools.map((t) => ({ name: t.name, description: t.description ?? '', parameters: stripSchema(t.inputSchema as Record<string, unknown>) }));
    },
    async call(name, args, ctxOverride) {
      const prev = ctx;
      if (ctxOverride) ctx = { ...ctx, ...ctxOverride };
      try {
        const r = await client.callTool({ name, arguments: args });
        const callId = (r._meta as { callId?: string } | undefined)?.callId;
        const stored = callId ? results.get(callId) : undefined;
        if (callId) results.delete(callId);
        if (stored) return stored;
        const text = Array.isArray(r.content) ? r.content.map((c) => (c as { text?: string }).text ?? '').join('\n') : '';
        return { ok: !r.isError, text };
      } finally {
        ctx = prev;
      }
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function stripSchema(s: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, additionalProperties: _a, ...rest } = s;
  return rest;
}
