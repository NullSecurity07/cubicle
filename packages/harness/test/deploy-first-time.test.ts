import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, createJob, readJob, listInbox } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools, phase6Tools } from '@cubicle/tools';
import { runJob, vaultScheduler, type Llm } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
function scripted(steps: { tool: string; args: Record<string, unknown> }[]): Llm {
  let i = 0;
  return { async chat(_r: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> { const s = steps[Math.min(i++, steps.length - 1)]; return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: s.tool, args: s.args }] }; }, promptBudget: () => 6000 };
}

describe('deploy.site first-time semantics (R17)', () => {
  it('first deploy is proposed (stored call); after a deploy.done, later deploys run automatically', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-deploy-'));
    const { vault } = await scaffoldVault(dir);
    try {
      mkdirSync(path.join(dir, 'Site/dist'), { recursive: true }); writeFileSync(path.join(dir, 'Site/dist/index.html'), '<h1>v1</h1>');
      const deps = { vault, llm: scripted([{ tool: 'deploy.site', args: {} }, { tool: 'finish', args: { status: 'done', summary: 'x' } }]), toolsConfig: cfg, registry: new ToolRegistry().registerAll([...phase3Tools(), ...phase6Tools()]), scheduler: vaultScheduler(vault), env: {} };
      const j1 = createJob(vault, { type: 'custom', title: 'ship', assigned: 'platform_engineer', goal: 'deploy' }, 'cto');
      expect((await runJob(deps, j1)).status).toBe('done');
      const spend = listInbox(vault).filter((n) => n.data.kind === 'spend');
      expect(spend.length).toBe(1);
      expect(spend[0].data.call?.tool).toBe('deploy.site');
      expect(vault.events.count('deploy.done')).toBe(0);
      // simulate the dispatcher having executed it once
      vault.events.emit({ type: 'deploy.done', agent: 'daemon', payload: { url: 'https://x.pages.dev', mode: 'mock' } });
      const j2 = createJob(vault, { type: 'custom', title: 'ship again', assigned: 'platform_engineer', goal: 'deploy' }, 'cto');
      expect((await runJob({ ...deps, llm: scripted([{ tool: 'deploy.site', args: {} }, { tool: 'finish', args: { status: 'done', summary: 'x' } }]) }, j2)).status).toBe('done');
      expect(listInbox(vault).filter((n) => n.data.kind === 'spend').length).toBe(1); // no second proposal
      expect(vault.events.count('deploy.done')).toBe(2);
      expect(readJob(vault, j2)!.data.side_effects_done).toEqual([`${j2}:1:1`]);
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
