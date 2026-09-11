import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob } from '@cubicle/core';
import { budgetedTier, type ModelBudget, type RoutedChatResult, type RouteRequest, type ChatMessage, type ToolSchema } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { runJob, vaultScheduler, type Llm } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-budget-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

/** Two reads and a finish: three router calls for one job. Records the request each call was routed with. */
function threeCalls(seen: RouteRequest[]): Llm {
  const steps = [
    { name: 'vault.read', args: { path: 'Plans/plan.md' } },
    { name: 'vault.read', args: { path: 'Plans/plan.md' } },
    { name: 'finish', args: { status: 'done', summary: 'read it twice' } },
  ];
  let i = 0;
  return {
    async chat(r: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
      seen.push(r);
      const step = steps[Math.min(i++, steps.length - 1)];
      return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'cheap', downgraded: false, parsedToolCalls: [step] };
    },
    promptBudget: () => 6000,
  };
}

const deps = (llm: Llm, modelBudget?: (roleId: string) => ModelBudget | null) => ({
  vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })),
  scheduler: vaultScheduler(vault), env: {}, modelBudget,
});

describe("a job carries its division's budget (SP4 §4)", () => {
  it('reads the budget once for the whole job, however many calls it makes', async () => {
    const seen: RouteRequest[] = [];
    const asked: string[] = [];
    const id = createJob(vault, { type: 'custom', title: 'Three calls', assigned: 'intelligence_analyst', goal: 'g' }, 'daemon');
    await runJob(deps(threeCalls(seen), (roleId) => { asked.push(roleId); return { used: 1, quota: 10 }; }), id);

    expect(seen).toHaveLength(3);                          // three router calls
    expect(asked).toEqual(['intelligence_analyst']);       // one budget read, for the job's own role
    for (const r of seen) expect(r.budget).toEqual({ used: 1, quota: 10 });
  });

  it('a division past its quota keeps working at the cheapest tier — it never stops', async () => {
    const seen: RouteRequest[] = [];
    const id = createJob(vault, { type: 'custom', title: 'Over quota', assigned: 'intelligence_analyst', goal: 'g' }, 'daemon');
    const out = await runJob(deps(threeCalls(seen), () => ({ used: 40, quota: 40 })), id);

    expect(out.status).toBe('done');                       // the job still ran, start to finish
    expect(readJob(vault, id)!.data.checkpoint_step).toBe(3);
    expect(seen[0].tier).toBe('medium');                   // what the charter asked for
    for (const r of seen) expect(budgetedTier(r.tier, r.budget)).toBe('cheap'); // what the router will route at
  });

  it('no `modelBudget` dep at all leaves the request exactly as it was', async () => {
    const seen: RouteRequest[] = [];
    const id = createJob(vault, { type: 'custom', title: 'Unbudgeted', assigned: 'intelligence_analyst', goal: 'g' }, 'daemon');
    await runJob(deps(threeCalls(seen)), id);
    expect(seen[0].budget).toBeUndefined();
    expect(budgetedTier(seen[0].tier, seen[0].budget)).toBe('medium');
  });

  it('a quota of 0 means "not budgeted", never "stopped"', async () => {
    const seen: RouteRequest[] = [];
    const id = createJob(vault, { type: 'custom', title: 'Unallocated division', assigned: 'intelligence_analyst', goal: 'g' }, 'daemon');
    await runJob(deps(threeCalls(seen), () => ({ used: 99, quota: 0 })), id);
    expect(budgetedTier(seen[0].tier, seen[0].budget)).toBe('medium');
  });
});
