import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, loadOrg, loadGates } from '@cubicle/core';
import { assembleContext, readRole, type Observation } from '../src/index.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-turn-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

async function ctx(observations: Observation[]) {
  const id = createJob(vault, { type: 'engineer.ship', title: 'Build', assigned: 'backend_engineer', goal: 'g', team: 'dev', owner_role: 'cto' }, 'cto');
  const role = readRole(vault, 'backend_engineer')!;
  return assembleContext({ vault, role: role.data, roleBody: role.body, job: readJob(vault, id)!.data, jobBody: readJob(vault, id)!.body, observations, maxPromptTokens: 6000, org: loadOrg(vault), gates: loadGates(), maxSteps: 25 });
}

/**
 * Gemini's OpenAI endpoint rejects a request whose last message is the assistant's ("Requests ending with a model
 * turn are not supported", 400). A live day (2026-09-10) paid 22 such 400s across three flash models — every one
 * after a text-only or empty reply, which the transcript stored as an assistant observation and rendered last.
 */
describe('the prompt never ends on the model\'s own turn', () => {
  it('an empty or text-only reply is followed by a user turn that asks for a tool call', async () => {
    const msgs = await ctx([
      { step: 1, kind: 'tool', tool: 'vault.read', args: { path: 'Plans/plan.md' }, result: '# Plan', ok: true, ts: '2026-09-10T00:00:00Z' },
      { step: 1, kind: 'assistant', text: '(empty reply)', ts: '2026-09-10T00:00:01Z' },
    ]);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe('user');
    expect(String(last.content)).toMatch(/tool|finish/i);
    // The assistant text itself is still there, so the model sees what it said.
    expect(msgs.some((m) => m.role === 'assistant' && m.content === '(empty reply)')).toBe(true);
  });

  it('two assistant observations in a row are still separated by a user turn (no consecutive model turns)', async () => {
    const msgs = await ctx([
      { step: 0, kind: 'assistant', text: 'Thinking about it.', ts: '2026-09-10T00:00:00Z' },
      { step: 0, kind: 'assistant', text: '(empty reply)', ts: '2026-09-10T00:00:01Z' },
    ]);
    for (let i = 1; i < msgs.length; i++) expect(!(msgs[i - 1].role === 'assistant' && msgs[i].role === 'assistant')).toBe(true);
    expect(msgs[msgs.length - 1].role).toBe('user');
  });
});
