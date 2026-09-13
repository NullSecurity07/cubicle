import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, readJob, createStream, listJobs, GATE_JOB_TYPES } from '@cubicle/core';
import { parseToolsConfig, schedulerRequest, missingRiskText, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-risk-sched-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function ctxFor(roleId: string): ToolContext {
  const role = RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${roleId}.md`)).data);
  return {
    vault, events: vault.events, roleId, role, jobId: 'job_parent', config: cfg, env: {},
    workspace: '.cubicle/workspace/job_parent', now: () => new Date(),
    scheduler: { enqueue: (j) => createJob(vault, j, roleId) },
  };
}

const ship = (over: Record<string, unknown> = {}) => ({
  type: 'engineer.ship', title: 'Add the card form', assigned: 'frontend_engineer',
  goal: 'Build it', priority: 3, depends_on: [], done_when: 'The form submits and the test passes.', ...over,
});

describe('scheduler.request and risk', () => {
  it('refuses an engineering job with no risk class, naming the three levels', async () => {
    const r = await schedulerRequest.handler(ship(), ctxFor('dev_manager'));
    expect(r.ok).toBe(false);
    expect(r.text).toBe(missingRiskText('engineer.ship'));
    expect(r.text).toMatch(/low/);
    expect(r.text).toMatch(/medium/);
    expect(r.text).toMatch(/high/);
  });

  it('accepts an engineering job that states its risk and stores both risk and stream', async () => {
    const r = await schedulerRequest.handler(ship({ risk: 'medium', stream: 'checkout' }), ctxFor('dev_manager'));
    expect(r.ok).toBe(true);
    const id = (r.data as { id: string }).id;
    expect(readJob(vault, id)?.data.risk).toBe('medium');
    expect(readJob(vault, id)?.data.stream).toBe('checkout');
  });

  it('a non-engineering job needs no risk and defaults to low', async () => {
    const r = await schedulerRequest.handler({ type: 'custom', title: 'Write the weekly pack', assigned: 'frontend_engineer', goal: 'g', priority: 3, depends_on: [], done_when: 'It is written.' }, ctxFor('dev_manager'));
    expect(r.ok).toBe(true);
    expect(readJob(vault, (r.data as { id: string }).id)?.data.risk).toBe('low');
  });

  it('the tool description tells the model when each level applies', () => {
    expect(schedulerRequest.description).toMatch(/destructive migrations/);
    expect(schedulerRequest.description).toMatch(/engineer\.ship/);
  });
});

describe('scheduler.request validates the stream slug (fix wave item 4 / C2)', () => {
  // `stream` is free text a model writes, and it becomes a path segment and a Docker mount source downstream.
  const HOSTILE = ['../../etc', '..', 'Workspace/x', 'check out', 'check,out', 'Checkout', '-checkout'];

  it('refuses a stream that is not a slug, and names the streams that exist', async () => {
    createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev', error_budget: 4 }, 'product_manager');
    for (const bad of HOSTILE) {
      const r = await schedulerRequest.handler(ship({ risk: 'low', stream: bad }), ctxFor('dev_manager'));
      expect(r.ok, bad).toBe(false);
      expect(r.text, bad).toMatch(/is not a stream slug/);
      expect(r.text, bad).toMatch(/checkout/);
    }
    expect(listJobs(vault).filter((j) => j.type === 'engineer.ship')).toHaveLength(0);
  });

  it('says there are no streams yet rather than naming none', async () => {
    const r = await schedulerRequest.handler(ship({ risk: 'low', stream: '../../etc' }), ctxFor('dev_manager'));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/No streams exist yet/);
  });

  it('a well-formed slug is still accepted, and a non-engineering job still needs no stream', async () => {
    const ok = await schedulerRequest.handler(ship({ risk: 'low', stream: 'checkout' }), ctxFor('dev_manager'));
    expect(ok.ok).toBe(true);
    const none = await schedulerRequest.handler({ type: 'custom', title: 'Another thing', assigned: 'frontend_engineer', goal: 'g', priority: 3, depends_on: [], done_when: 'It is done.' }, ctxFor('dev_manager'));
    expect(none.ok).toBe(true);
    expect(readJob(vault, (none.data as { id: string }).id)?.data.stream ?? null).toBeNull();
  });
});

// Ruling S-6. The second live run queued an `engineer.ship` with no stream; the engineer did the whole change and
// only then failed the CI gate, which reads `Workspace/<stream>/.cubicle-ci/`. The question is settled at the
// queue now, where it costs nothing.
describe('scheduler.request defaults the stream for engineering work (S-6)', () => {
  const mkStream = (name: string) => createStream(vault, { name, problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev', error_budget: 4 }, 'product_manager');

  it('with exactly one stream it defaults to it and says so', async () => {
    mkStream('Checkout');
    const r = await schedulerRequest.handler(ship({ risk: 'low' }), ctxFor('dev_manager'));
    expect(r.ok).toBe(true);
    expect(r.text).toContain('on the only stream, checkout');
    expect(readJob(vault, (r.data as { id: string }).id)?.data.stream).toBe('checkout');
  });

  it('with several streams it refuses and names them', async () => {
    mkStream('Checkout'); mkStream('Onboarding');
    const r = await schedulerRequest.handler(ship({ risk: 'low' }), ctxFor('dev_manager'));
    expect(r.ok).toBe(false);
    expect(r.text).toContain('checkout');
    expect(r.text).toContain('onboarding');
    expect(r.text).toMatch(/must name the stream/);
    expect(listJobs(vault).filter((j) => j.type === 'engineer.ship')).toHaveLength(0);
  });

  it('with no stream at all it refuses and says who creates one', async () => {
    const r = await schedulerRequest.handler(ship({ risk: 'low' }), ctxFor('dev_manager'));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/the product manager creates Streams\/<slug>\.md first/);
    expect(listJobs(vault).filter((j) => j.type === 'engineer.ship')).toHaveLength(0);
  });

  it('an explicit stream still wins, and a non-engineering type is untouched by all of this', async () => {
    mkStream('Checkout'); mkStream('Onboarding');
    const r = await schedulerRequest.handler(ship({ risk: 'low', stream: 'onboarding' }), ctxFor('dev_manager'));
    expect(r.ok).toBe(true);
    expect(readJob(vault, (r.data as { id: string }).id)?.data.stream).toBe('onboarding');
    const custom = await schedulerRequest.handler({ type: 'growth.post', title: 'Write the launch post', assigned: 'cmo', goal: 'g', priority: 3, depends_on: [], done_when: 'It is posted.' }, ctxFor('cfo'));
    expect(custom.ok, custom.text).toBe(true);
    expect(readJob(vault, (custom.data as { id: string }).id)?.data.stream ?? null).toBeNull();
  });
});

describe('the reserved job types match the ones nothing counts (fix wave item 7 / I7)', () => {
  // These three are skipped by wipLoad and ignored by the heartbeat's open-work count. An agent that could
  // schedule them would have a lane invisible to both the WIP limit and the re-planning gate.
  const HIDDEN = ['requester.review', 'research.review', 'incident'];

  it('an engineer cannot schedule one', async () => {
    for (const type of HIDDEN) {
      const r = await schedulerRequest.handler(ship({ risk: 'low', type, assigned: 'backend_engineer' }), ctxFor('frontend_engineer'));
      expect(r.ok, type).toBe(false);
      expect(r.text, type).toMatch(/reserved for the daemon/);
    }
  });

  it('nor can a lead, nor the CEO — these are the daemon\'s own', async () => {
    for (const type of HIDDEN) {
      expect((await schedulerRequest.handler(ship({ risk: 'low', type, assigned: 'backend_engineer' }), ctxFor('dev_manager'))).ok, type).toBe(false);
      expect((await schedulerRequest.handler(ship({ risk: 'low', type, assigned: 'backend_engineer', done_when: 'x' }), ctxFor('ceo'))).ok, type).toBe(false);
    }
    expect(listJobs(vault).filter((j) => HIDDEN.includes(j.type))).toHaveLength(0);
  });

  it('every type wipLoad skips is reserved, so the two lists cannot drift apart', async () => {
    for (const type of GATE_JOB_TYPES) {
      const r = await schedulerRequest.handler(ship({ risk: 'low', type, assigned: 'backend_engineer' }), ctxFor('frontend_engineer'));
      expect(r.ok, type).toBe(false);
      expect(r.text, type).toMatch(/reserved for the daemon/);
    }
  });
});
