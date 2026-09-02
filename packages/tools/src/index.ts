export * from './registry.js';
export * from './mcp.js';
export * from './tools/vault.js';
export * from './tools/http.js';
export * from './tools/colleague.js';
export * from './tools/proposal.js';
export * from './tools/scheduler.js';
export * from './tools/skills.js';
export * from './tools/finish.js';
export * from './tools/mock.js';

import type { AnyTool } from './registry.js';
import { vaultTools } from './tools/vault.js';
import { httpFetch } from './tools/http.js';
import { colleagueMessage } from './tools/colleague.js';
import { proposalCreate } from './tools/proposal.js';
import { schedulerRequest } from './tools/scheduler.js';
import { skillsTools } from './tools/skills.js';
import { finish } from './tools/finish.js';
import { mockOutbound } from './tools/mock.js';

/** Phase 3 tool set (Phases 5–6 append shell/browser/git/email/deploy/stripe/analytics/social/meeting). */
export function phase3Tools(opts: { includeMock?: boolean } = {}): AnyTool[] {
  const t: AnyTool[] = [...vaultTools, httpFetch, colleagueMessage, proposalCreate, schedulerRequest, ...skillsTools, finish];
  if (opts.includeMock) t.push(mockOutbound);
  return t;
}
