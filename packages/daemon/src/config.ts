import path from 'node:path';
import { repoRoot } from '@cubicle/core';

export interface DaemonConfig {
  vaultPath: string;
  port: number;
  providersPath: string;
  toolsPath: string;
  env: NodeJS.ProcessEnv;
  /** Heartbeat triggers (spec §8). */
  heartbeat: { maxElapsedHours: number; jobsCompletedN: number; startupAwayHours: number };
  tickMs: number;
  /** Graceful shutdown budget. */
  shutdownMs: number;
  /** Max concurrent LLM jobs across all workers (free tiers are small). */
  maxConcurrentJobs: number;
}

export function defaultConfig(vaultPath: string, env: NodeJS.ProcessEnv = process.env, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    vaultPath: path.resolve(vaultPath),
    port: Number(env.CUBICLE_PORT ?? 7411),
    providersPath: env.CUBICLE_PROVIDERS ?? path.join(repoRoot(), 'config', 'providers.yaml'),
    toolsPath: env.CUBICLE_TOOLS ?? path.join(repoRoot(), 'config', 'tools.yaml'),
    env,
    heartbeat: { maxElapsedHours: 6, jobsCompletedN: 5, startupAwayHours: 1 },
    tickMs: 30_000,
    shutdownMs: 5_000,
    maxConcurrentJobs: 2,
    ...overrides,
  };
}
