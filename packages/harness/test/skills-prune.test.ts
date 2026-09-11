import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, createJob } from '@cubicle/core';
import type { RoutedChatResult } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { runJob, vaultScheduler, type Llm } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
function scripted(steps: { tool: string; args: Record<string, unknown> }[]): Llm {
  let i = 0;
  return { async chat(): Promise<RoutedChatResult> { const s = steps[Math.min(i++, steps.length - 1)]; return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: s.tool, args: s.args }] }; }, promptBudget: () => 6000 };
}

describe('skills pruning (spec §9.3)', () => {
  it('a skill loaded by two failed jobs is archived with a lesson', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-skills-'));
    const { vault } = await scaffoldVault(dir);
    try {
      vault.writeText('Skills/deploy-site.md', '---\nname: Deploy site\nslug: deploy-site\nfailures: 0\n---\n# Deploy site\n\nsteps\n', 'backend_engineer');
      const deps = (llm: Llm) => ({ vault, llm, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools()), scheduler: vaultScheduler(vault), env: {} });
      const failing = () => scripted([{ tool: 'skills.load', args: { name: 'Deploy site' } }, { tool: 'finish', args: { status: 'failed', summary: 'broke', blockers: ['x'] } }]);
      const j1 = createJob(vault, { type: 'custom', title: 'a', assigned: 'backend_engineer', goal: 'g' }, 'cto');
      expect((await runJob(deps(failing()), j1)).status).toBe('failed');
      expect(vault.readNote<{ failures: number }>('Skills/deploy-site.md').data.failures).toBe(1);
      const j2 = createJob(vault, { type: 'custom', title: 'b', assigned: 'backend_engineer', goal: 'g' }, 'cto');
      expect((await runJob(deps(failing()), j2)).status).toBe('failed');
      expect(vault.exists('Skills/deploy-site.md')).toBe(false);
      expect(vault.list('Skills/archive', { ext: '.md' }).length).toBe(1);
      expect(vault.readText('Memory/lessons.md')).toContain('failed twice and was archived');
      // a successful job does not count
      const ok = scripted([{ tool: 'skills.search', args: { query: 'deploy' } }, { tool: 'finish', args: { status: 'done', summary: 'fine' } }]);
      const j3 = createJob(vault, { type: 'custom', title: 'c', assigned: 'backend_engineer', goal: 'g' }, 'cto');
      expect((await runJob(deps(ok), j3)).status).toBe('done');
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
