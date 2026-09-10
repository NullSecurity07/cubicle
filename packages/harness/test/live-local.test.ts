/**
 * Live test against the local Ollama floor (acceptance test 5: a `tools: json` model completes a 3-tool job).
 * Runs only when CUBICLE_LIVE=1; needs Ollama with qwen2.5:7b and nomic-embed-text.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, createJob, readJob } from '@cubicle/core';
import { loadProvidersConfig, QuotaTracker, Router, embedTexts } from '@cubicle/router';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { runJob, vaultScheduler, MemoryIndex } from '../src/index.js';

const live = process.env.CUBICLE_LIVE === '1';
const root = path.resolve(__dirname, '../../..');

describe.skipIf(!live)('live local model', () => {
  it('qwen2.5:7b completes a 3-tool job via prompt-based tool calling and nomic finds the deploy skill', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-live-'));
    const { vault } = await scaffoldVault(dir);
    try {
      const cfg = loadProvidersConfig(path.join(root, 'config/providers.yaml'));
      const env = { ...process.env, GEMINI_API_KEY: '', GROQ_API_KEY: '', OPENROUTER_API_KEY: '' } as NodeJS.ProcessEnv;
      const router = new Router(cfg, new QuotaTracker(vault.db), { env, events: vault.events });
      const memory = new MemoryIndex(vault, (t) => embedTexts(cfg, t));
      vault.writeText('Skills/deploy-site.md', '---\nname: Deploy site\n---\n# Deploy site\n\nBuild Site/, then run `wrangler pages deploy Site/dist` to publish to Cloudflare Pages.\n', 'backend_engineer');
      vault.writeText('Skills/cold-email.md', '---\nname: Cold email\n---\n# Cold email\n\nShort subject line, one clear ask, unsubscribe footer, respect the suppression list.\n', 'cmo');
      await memory.indexAll();
      const hits = await memory.search('how do I deploy the website', 2, ['Skills']);
      expect(hits[0].path).toBe('Skills/deploy-site.md');

      const tools = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
      const registry = new ToolRegistry().registerAll(phase3Tools());
      const id = createJob(vault, {
        type: 'research', title: 'Note the company name', assigned: 'coo',
        goal: 'Do exactly this, one tool per turn: (1) call vault.read on "Brand/name.md"; (2) call vault.write to create "Plans/notes.md" containing one line: "name file read"; (3) call finish with status done and a one-sentence summary. Do not do anything else.',
      }, 'cto');
      const t0 = Date.now();
      const out = await runJob({ vault, llm: router, toolsConfig: tools, registry, scheduler: vaultScheduler(vault), memory, env, maxSteps: 8, localMaxSteps: 8 }, id);
      const j = readJob(vault, id)!;
      console.log(`live local job → ${out.status} in ${Math.round((Date.now() - t0) / 1000)}s; steps=${j.data.checkpoint_step}; router.calls=${vault.events.count('router.call')}; downgraded=${vault.events.count('router.downgraded')}`);
      console.log(j.body.split('## Checkpoint log')[1]?.split('## Result')[0]);
      expect(out.status).toBe('done');
      expect(vault.exists('Plans/notes.md')).toBe(true);
      expect(vault.events.last('router.call')?.payload.provider).toBe('ollama');
      expect(vault.events.count('router.downgraded')).toBeGreaterThanOrEqual(1);
    } finally {
      vault.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
