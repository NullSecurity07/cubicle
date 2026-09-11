import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, createJob, readJob, updateJob, createProposal, findInboxById, createStream,
  writeCiRecord, ciConfigPath, JobResult, loadGates, gatesForRisk, stringifyNote, type JobFrontmatter,
} from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools, adrPath } from '@cubicle/tools';
import { readFileSync } from 'node:fs';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { shipRefusal, approvedThreatModel, rejectedThreatModel, runJob, vaultScheduler, type Llm } from '../src/loop.js';

const root = path.resolve(__dirname, '../../..');
const gates = loadGates(path.join(root, 'config/gates.yaml'));
let dir: string; let vault: Vault;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-shipgate-')); vault = (await scaffoldVault(dir)).vault;
  createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: '72 % to 82 %', owner_team: 'dev' }, 'product_manager');
  vault.writeText(ciConfigPath('checkout'), 'steps:\n  - { name: test, run: "true" }\n', 'daemon');
  vault.writeText('Workspace/checkout/src/app.js', 'export const v = 1;\n', 'backend_engineer');
  // Every source file in the workspace is back-dated, cubicle-ci.yaml included: `newestSourceMtime` walks the
  // whole workspace, so a file left at the wall clock overtakes the fixed `finished` below and the suite starts
  // failing at a time of day rather than on a change.
  const early = new Date('2026-09-11T09:00:00.000Z');
  for (const rel of ['Workspace/checkout/src/app.js', ciConfigPath('checkout')]) utimesSync(path.join(dir, rel), early, early);
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function ship(over: Partial<JobFrontmatter> = {}): JobFrontmatter {
  const id = createJob(vault, { type: 'engineer.ship', title: 'Card form', assigned: 'backend_engineer', goal: 'g', team: 'dev', stream: 'checkout', risk: over.risk ?? 'low' }, 'dev_manager');
  if (Object.keys(over).length) updateJob(vault, id, over, 'daemon');
  return readJob(vault, id)!.data;
}

function green(): void {
  writeCiRecord(vault, 'checkout', { stream: 'checkout', started: '2026-09-11T09:59:00.000Z', finished: '2026-09-11T10:00:00.000Z', green: true, commit: null, steps: [{ name: 'test', code: 0, ok: true, duration_ms: 5, output: 'ok' }] }, 'backend_engineer');
}

const done = JobResult.parse({ status: 'done', summary: 'shipped' });

describe('shipRefusal — the CI gate (operating model §17)', () => {
  it('refuses a ship with no CI record and names ci.run', () => {
    const r = shipRefusal(vault, ship(), done);
    expect(r).toMatch(/ci\.run/);
    expect(r).toMatch(/checkout/);
  });

  it('accepts a ship with a green record newer than the source', () => {
    green();
    expect(shipRefusal(vault, ship(), done)).toBeNull();
  });

  it('refuses again once a source file is touched after the green run', () => {
    green();
    const later = new Date('2026-09-11T11:00:00.000Z');
    utimesSync(path.join(dir, 'Workspace/checkout/src/app.js'), later, later);
    expect(shipRefusal(vault, ship(), done)).toMatch(/app\.js/);
  });

  it('a ship with no stream is told to name one rather than skipping the gate', () => {
    const j = ship();
    const noStream = { ...j, stream: undefined };
    expect(shipRefusal(vault, noStream, done)).toMatch(/stream/i);
  });

  it('only applies to a successful ship — a failed or blocked one may always finish', () => {
    expect(shipRefusal(vault, ship(), JobResult.parse({ status: 'failed', summary: 'could not build' }))).toBeNull();
    expect(shipRefusal(vault, ship(), JobResult.parse({ status: 'blocked', summary: 'need a key' }))).toBeNull();
  });

  it('only applies to engineering job types', () => {
    const id = createJob(vault, { type: 'custom', title: 'Write the pack', assigned: 'coo', goal: 'g' }, 'ceo');
    expect(shipRefusal(vault, readJob(vault, id)!.data, done)).toBeNull();
  });
});

describe('shipRefusal — the high-risk threat model (§27)', () => {
  it('a high-risk ship with green CI is still refused until the owner approves a threat model', () => {
    green();
    const j = ship({ risk: 'high' });
    const r = shipRefusal(vault, j, done);
    expect(r).toMatch(/threat_model/);
    expect(r).toMatch(/proposal\.create/);
    expect(approvedThreatModel(vault, j.id)).toBe(false);
  });

  it('an approved threat model for this job clears it', () => {
    green();
    const j = ship({ risk: 'high' });
    const { id } = createProposal(vault, { kind: 'threat_model', from: 'backend_engineer', title: 'Threat model: session keys', body: 'Assets, entry points, what an attacker would try, what stops them.', job: j.id }, 'backend_engineer');
    vault.updateNote(findInboxById(vault, id)!.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
    expect(approvedThreatModel(vault, j.id)).toBe(true);
    expect(shipRefusal(vault, j, done)).toBeNull();
  });

  it('a threat model approved for a different job does not count', () => {
    green();
    const other = ship({ risk: 'high' });
    const mine = ship({ risk: 'high' });
    const { id } = createProposal(vault, { kind: 'threat_model', from: 'backend_engineer', title: 'Threat model', body: 'b', job: other.id }, 'backend_engineer');
    vault.updateNote(findInboxById(vault, id)!.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');
    expect(approvedThreatModel(vault, mine.id)).toBe(false);
  });

  it('medium risk needs no threat model — the security gate is the control there', () => {
    green();
    expect(shipRefusal(vault, ship({ risk: 'medium' }), done)).toBeNull();
    expect(gatesForRisk(gates, 'engineer.ship', 'medium')).toEqual(['office:security.review', 'team:qa.review', 'office:operations.verify']);
  });

  // Fix round 1 / Important 3 & Minor 6: once the owner has answered "no", repeating "call proposal.create"
  // is a lie — the job already asked and was told no. The refusal after a rejection must say that instead.
  it('a rejected threat model refuses ship permanently, and stops telling the author to ask again', () => {
    green();
    const j = ship({ risk: 'high' });
    const { id } = createProposal(vault, { kind: 'threat_model', from: 'backend_engineer', title: 'Threat model', body: 'b', job: j.id }, 'backend_engineer');
    vault.updateNote(findInboxById(vault, id)!.path, (n) => ({ data: { ...n.data, approved: false }, body: n.body }), 'owner');
    expect(rejectedThreatModel(vault, j.id)).toBe(true);
    expect(approvedThreatModel(vault, j.id)).toBe(false);
    const r = shipRefusal(vault, j, done);
    expect(r).toMatch(/rejected/i);
    expect(r).not.toMatch(/proposal\.create/);
  });
});

describe('shipRefusal — the architecture ADR (toolchain §8)', () => {
  it('a ship that changed the architecture is refused without an ADR dated on or after its creation', () => {
    green();
    const j = ship();
    const withArch = JobResult.parse({ status: 'done', summary: 'shipped', architecture_change: true });
    const r = shipRefusal(vault, j, withArch);
    expect(r).toMatch(/adr\.create/);
  });

  it('an ADR dated before the job was created does not count', () => {
    green();
    const j = ship();
    const rel = adrPath(1, 'Use a queue');
    vault.writeText(rel, stringifyNote({ id: 'ADR-0001', title: 'Use a queue', status: 'accepted', date: '2026-09-10' }, '# ADR-0001: Use a queue\n'), 'backend_engineer');
    const withArch = JobResult.parse({ status: 'done', summary: 'shipped', architecture_change: true });
    expect(shipRefusal(vault, j, withArch)).toMatch(/adr\.create/);
  });

  it('an ADR dated on or after the job was created clears it', () => {
    green();
    const j = ship();
    const rel = adrPath(1, 'Use a queue');
    vault.writeText(rel, stringifyNote({ id: 'ADR-0001', title: 'Use a queue', status: 'accepted', date: j.created.slice(0, 10) }, '# ADR-0001: Use a queue\n'), 'backend_engineer');
    const withArch = JobResult.parse({ status: 'done', summary: 'shipped', architecture_change: true });
    expect(shipRefusal(vault, j, withArch)).toBeNull();
  });

  it('a ship that did not touch the architecture needs no ADR', () => {
    green();
    expect(shipRefusal(vault, ship(), done)).toBeNull(); // `done` sets no architecture_change
  });
});

describe('the ship gate end to end, through runJob', () => {
  const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
  type Step = { tool: string; args: Record<string, unknown> };
  function scripted(steps: Step[]): Llm {
    let i = 0;
    return {
      async chat(_r: RouteRequest, _c: { messages: ChatMessage[]; tools?: ToolSchema[] }): Promise<RoutedChatResult> {
        const s = steps[Math.min(i++, steps.length - 1)];
        return { content: '', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 }, provider: 'f', model: 'f', tier: 'medium', downgraded: false, parsedToolCalls: [{ name: s.tool, args: s.args }] };
      },
      promptBudget: () => 6000,
    };
  }
  function base() {
    return { vault, toolsConfig: cfg, registry: new ToolRegistry().registerAll(phase3Tools()), scheduler: vaultScheduler(vault), env: {} };
  }

  it('refuse -> proposal.create(threat_model) -> owner approves -> resume -> finish done', async () => {
    green();
    const j = ship({ risk: 'high' });
    const blocked = await runJob({ ...base(), llm: scripted([
      { tool: 'finish', args: { status: 'done', summary: 'shipped it' } },
      { tool: 'proposal.create', args: { kind: 'threat_model', title: 'Threat model: card form', body: 'Assets, entry points, what an attacker would try, what stops them, what we accept.' } },
    ]) }, j.id);
    expect(blocked.status).toBe('blocked');
    expect(readJob(vault, j.id)!.data.status).toBe('blocked');
    // The refusal was announced, not just recorded in the job's own transcript (docs/events.md's
    // guardrail.blocked contract: "every refused call, never silent").
    expect(vault.events.query({ types: ['guardrail.blocked'] }).some((e) => /threat_model/.test(String((e.payload as { reason?: string }).reason)))).toBe(true);

    const propId = (blocked as { on?: { id: string } }).on!.id;
    vault.updateNote(findInboxById(vault, propId)!.path, (n) => ({ data: { ...n.data, approved: true }, body: n.body }), 'owner');

    const finished = await runJob({ ...base(), llm: scripted([{ tool: 'finish', args: { status: 'done', summary: 'shipped it' } }]) }, j.id);
    expect(finished.status).toBe('done');
    expect(readJob(vault, j.id)!.data.status).not.toBe('blocked');
  });

  it('refuse -> proposal.create(threat_model) -> owner rejects -> the job ends failed, refusing to ask again', async () => {
    green();
    const j = ship({ risk: 'high' });
    const blocked = await runJob({ ...base(), llm: scripted([
      { tool: 'finish', args: { status: 'done', summary: 'shipped it' } },
      { tool: 'proposal.create', args: { kind: 'threat_model', title: 'Threat model: card form', body: 'Assets, entry points, what an attacker would try, what stops them, what we accept.' } },
    ]) }, j.id);
    expect(blocked.status).toBe('blocked');
    const propId = (blocked as { on?: { id: string } }).on!.id;
    vault.updateNote(findInboxById(vault, propId)!.path, (n) => ({ data: { ...n.data, approved: false }, body: n.body }), 'owner');

    // On resume the author sees the refusal names the rejection, and gives up rather than asking again.
    const done2 = await runJob({ ...base(), llm: scripted([
      { tool: 'finish', args: { status: 'done', summary: 'shipped it' } },
      { tool: 'finish', args: { status: 'failed', summary: 'cannot ship: the owner rejected the threat model and this change cannot be reduced to a lower risk' } },
    ]) }, j.id);
    expect(done2.status).toBe('failed');
    const reasons = vault.events.query({ types: ['guardrail.blocked'] }).map((e) => String((e.payload as { reason?: string }).reason));
    expect(reasons.some((r) => /rejected/i.test(r))).toBe(true);
    expect(reasons.some((r) => /rejected/i.test(r) && /proposal\.create/.test(r))).toBe(false);
  });
});
