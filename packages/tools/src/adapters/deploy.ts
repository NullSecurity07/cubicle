import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Vault } from '@cubicle/core';
import { hasEnv, mockLog, slugify } from './common.js';

export interface Deployer { mode: 'mock' | 'live'; deploy(vault: Vault, opts: { project: string; dir: string; idempotencyKey: string }): Promise<{ ok: boolean; url?: string; detail: string }> }

/** Cloudflare Pages via `npx wrangler pages deploy <dir>`; wrangler reads CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (verified 2026-09-02). */
export function deployer(env: NodeJS.ProcessEnv, repoRoot: string): Deployer {
  if (hasEnv(env, 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID')) {
    return {
      mode: 'live',
      deploy(_vault, { project, dir }) {
        return new Promise((resolve) => {
          const args = ['exec', 'wrangler', 'pages', 'deploy', dir, '--project-name', project, '--commit-dirty=true'];
          const p = spawn('pnpm', args, { cwd: repoRoot, env: { ...env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
          let out = '';
          p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
          const t = setTimeout(() => p.kill('SIGKILL'), 10 * 60_000);
          p.on('close', (code) => {
            clearTimeout(t);
            const url = out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev\S*/i)?.[0]?.replace(/[.,)]+$/, '');
            resolve({ ok: code === 0 && !!url, url, detail: code === 0 ? `deployed ${url ?? '(url not found in output)'}` : `wrangler exit ${code}: ${out.slice(-600)}` });
          });
        });
      },
    };
  }
  return {
    mode: 'mock',
    async deploy(vault, { project, dir, idempotencyKey }) {
      const target = vault.abs(`.cubicle/mock/deploy/${slugify(project)}-${Date.now().toString(36)}`);
      mkdirSync(path.dirname(target), { recursive: true });
      if (existsSync(dir)) cpSync(dir, target, { recursive: true });
      const url = `https://${slugify(project)}.pages.dev`;
      mockLog(vault, 'deploy', { key: idempotencyKey, project, dir, copy: vault.rel(target), url });
      return { ok: true, url, detail: `MOCK (no CLOUDFLARE_API_TOKEN): copied ${vault.rel(target)}; pretend URL ${url}` };
    },
  };
}
