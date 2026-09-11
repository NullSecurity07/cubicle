import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Vault } from '@cubicle/core';
import { hasEnv, mockLog, slugify } from './common.js';

/** Progressive delivery stages (owner's operating model §20). `preview` and `canary` are Pages branch deploys. */
export const DEPLOY_STAGES = ['preview', 'canary', 'live'] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];

export interface DeployOptions { project: string; dir: string; idempotencyKey: string; stage: DeployStage }
export interface Deployer { mode: 'mock' | 'live'; deploy(vault: Vault, opts: DeployOptions): Promise<{ ok: boolean; url?: string; detail: string }> }

/** Cloudflare Pages branch names: `main` is production, anything else is a preview URL of its own. */
function branchFor(stage: DeployStage): string { return stage === 'live' ? 'main' : stage; }

/** Cloudflare Pages via `npx wrangler pages deploy <dir>`; wrangler reads CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (verified 2026-09-02). */
export function deployer(env: NodeJS.ProcessEnv, repoRoot: string): Deployer {
  if (hasEnv(env, 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID')) {
    return {
      mode: 'live',
      deploy(_vault, { project, dir, stage }) {
        return new Promise((resolve) => {
          const branch = branchFor(stage);
          const args = ['exec', 'wrangler', 'pages', 'deploy', dir, '--project-name', project, '--branch', branch, '--commit-dirty=true'];
          const p = spawn('pnpm', args, { cwd: repoRoot, env: { ...env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
          let out = '';
          p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
          const t = setTimeout(() => p.kill('SIGKILL'), 10 * 60_000);
          p.on('close', (code) => {
            clearTimeout(t);
            const preview = out.match(/https:\/\/[a-z0-9.-]+\.pages\.dev\S*/i)?.[0]?.replace(/[.,)]+$/, '');
            const url = code !== 0 ? undefined : stage === 'live' ? `https://${project}.pages.dev` : (preview ?? `https://${branch}.${project}.pages.dev`);
            resolve({ ok: code === 0, url, detail: code === 0 ? `deployed ${stage} → ${url}` : `wrangler exit ${code}: ${out.slice(-600)}` });
          });
        });
      },
    };
  }
  return {
    mode: 'mock',
    async deploy(vault, { project, dir, idempotencyKey, stage }) {
      const target = vault.abs(`.cubicle/mock/deploy/${slugify(project)}-${stage}-${Date.now().toString(36)}`);
      mkdirSync(path.dirname(target), { recursive: true });
      if (existsSync(dir)) cpSync(dir, target, { recursive: true });
      const url = stage === 'live' ? `https://${slugify(project)}.pages.dev` : `https://${stage}.${slugify(project)}.pages.dev`;
      mockLog(vault, 'deploy', { key: idempotencyKey, project, dir, stage, copy: vault.rel(target), url });
      return { ok: true, url, detail: `MOCK (no CLOUDFLARE_API_TOKEN): ${stage} copied to ${vault.rel(target)}; pretend URL ${url}` };
    },
  };
}
