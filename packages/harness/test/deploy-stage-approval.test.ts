import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, createJob, listInbox } from '@cubicle/core';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools, phase6Tools } from '@cubicle/tools';
import { runJob, vaultScheduler, type Llm } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
function scripted(steps: { tool: string; args: Record<string, unknown> }[]): Llm {
  let i = 0;
  return { async chat(_r: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> { const s = steps[Math.min(i++, steps.length - 1)]; return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: s.tool, args: s.args }] }; }, promptBudget: () => 6000 };
}
const finishStep = { tool: 'finish', args: { status: 'done', summary: 'x' } };

/**
 * R17 meets §20: `deploy.site` is `first_time_only`, so the owner approves the first one. Progressive delivery
 * made the first call a *preview*, and a preview must not spend the approval the production deploy needs.
 */
describe('deploy.site first-time approval counts live deploys only', () => {
  it('a preview does not spend the approval; the first live deploy still needs it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-deploy-appr-'));
    const { vault } = await scaffoldVault(dir);
    try {
      mkdirSync(path.join(dir, 'Site/dist'), { recursive: true });
      writeFileSync(path.join(dir, 'Site/dist/index.html'), '<h1>v1</h1>');
      const base = { vault, toolsConfig: cfg, registry: new ToolRegistry().registerAll([...phase3Tools(), ...phase6Tools()]), scheduler: vaultScheduler(vault), env: {} };
      const spends = () => listInbox(vault).filter((n) => n.data.kind === 'spend');

      // A preview is proposed like any first deploy; the owner approves it out of band.
      const j1 = createJob(vault, { type: 'engineer.ship', title: 'preview', assigned: 'platform_engineer', goal: 'deploy' }, 'cto');
      await runJob({ ...base, llm: scripted([{ tool: 'deploy.site', args: { stage: 'preview' } }, finishStep]) }, j1);
      expect(spends().length).toBe(1);
      expect(vault.events.count('deploy.done')).toBe(0);

      // Record the preview and the canary as having gone out, as the dispatcher would after approval.
      vault.events.emit({ type: 'deploy.done', agent: 'daemon', payload: { url: 'https://preview.acme.pages.dev', project: 'acme', mode: 'mock', stage: 'preview' } });
      vault.events.emit({ type: 'deploy.done', agent: 'daemon', payload: { url: 'https://canary.acme.pages.dev', project: 'acme', mode: 'mock', stage: 'canary' } });

      // The first *live* deploy is still owner business: two non-live deploys bought it nothing.
      const j2 = createJob(vault, { type: 'engineer.ship', title: 'go live', assigned: 'platform_engineer', goal: 'deploy' }, 'cto');
      await runJob({ ...base, llm: scripted([{ tool: 'deploy.site', args: { stage: 'live', metrics: ['error rate'] } }, finishStep]) }, j2);
      expect(spends().length).toBe(2);
      expect(vault.events.count('deploy.done')).toBe(2); // still only the two we recorded by hand

      // Once a live deploy is on the record, later deploys run without asking again.
      vault.events.emit({ type: 'deploy.done', agent: 'daemon', payload: { url: 'https://acme.pages.dev', project: 'acme', mode: 'mock', stage: 'live' } });
      const j3 = createJob(vault, { type: 'engineer.ship', title: 'again', assigned: 'platform_engineer', goal: 'deploy' }, 'cto');
      expect((await runJob({ ...base, llm: scripted([{ tool: 'deploy.site', args: { stage: 'preview' } }, finishStep]) }, j3)).status).toBe('done');
      expect(spends().length).toBe(2); // no third proposal
      expect(vault.events.count('deploy.done')).toBe(4);
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
