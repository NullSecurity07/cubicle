import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { runJob, vaultScheduler, effectiveTier, type Llm } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-tier-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

/** Records the tier the harness asked the router for, then finishes. */
const recording = (seen: RouteRequest[]): Llm => ({
  async chat(r: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
    seen.push(r);
    return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'cheap', downgraded: false, parsedToolCalls: [{ name: 'finish', args: { status: 'done', summary: 'ok' } }] };
  },
  promptBudget: () => 6000,
});
const deps = (llm: Llm) => ({ vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })), scheduler: vaultScheduler(vault), env: {} });

describe('a job may pin its own model tier', () => {
  it('model_tier on the job wins over the charter; without it the charter still decides', async () => {
    const seen: RouteRequest[] = [];
    const cheap = createJob(vault, { type: 'intelligence', title: 'Competitive sweep', assigned: 'intelligence_analyst', goal: 'g', model_tier: 'cheap' }, 'daemon');
    await runJob(deps(recording(seen)), cheap);
    expect(seen.at(-1)!.tier).toBe('cheap');

    const plain = createJob(vault, { type: 'custom', title: 'Plain', assigned: 'intelligence_analyst', goal: 'g' }, 'daemon');
    await runJob(deps(recording(seen)), plain);
    expect(seen.at(-1)!.tier).toBe('medium'); // intelligence_analyst's charter
  });

  it('a job may not route above its charter: strong on a medium charter clamps to medium', async () => {
    const seen: RouteRequest[] = [];
    const overreach = createJob(vault, { type: 'custom', title: 'Overreach', assigned: 'intelligence_analyst', goal: 'g', model_tier: 'strong' }, 'daemon');
    await runJob(deps(recording(seen)), overreach);
    expect(seen.at(-1)!.tier).toBe('medium'); // clamped: intelligence_analyst's charter is medium
  });
});

describe('effectiveTier (pure)', () => {
  it('lets a job route below its charter', () => {
    expect(effectiveTier('cheap', 'medium')).toBe('cheap');
  });
  it('clamps a job that asks above its charter', () => {
    expect(effectiveTier('strong', 'medium')).toBe('medium');
  });
  it('allows a job pinned to the same tier as its charter', () => {
    expect(effectiveTier('medium', 'medium')).toBe('medium');
  });
  it('falls back to the charter tier when the job has none', () => {
    expect(effectiveTier(undefined, 'medium')).toBe('medium');
  });
});
