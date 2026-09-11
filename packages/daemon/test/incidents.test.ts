import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, updateJob, createStream, listJobs, setSection } from '@cubicle/core';
import { maybeOpenIncident, maybeCorrectiveActions, CORRECTIVE_MAX, postmortemPath } from '../src/evolution.js';
import { teamPlanGoal } from '../src/heartbeat.js';

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-incident-')); vault = (await scaffoldVault(dir)).vault;
  createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev', error_budget: 4 }, 'product_manager');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('an incident opens itself when a deploy is rolled back', () => {
  it('creates one high-risk incident for the SRE and emits incident.opened', () => {
    vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', stage: 'live', rolled_back: true, stream: 'checkout', url: 'https://acme.pages.dev' } });
    const id = maybeOpenIncident(vault)!;
    const j = readJob(vault, id)!.data;
    expect(j.type).toBe('incident');
    expect(j.assigned).toBe('sre');
    expect(j.risk).toBe('high');
    expect(j.stream).toBe('checkout');
    expect(j.priority).toBe(1);
    expect(vault.events.query({ types: ['incident.opened'] })).toHaveLength(1);
    expect(readJob(vault, id)!.body).toMatch(/Docs\/postmortems/);
  });

  it('is idempotent — a second tick over the same rollback opens nothing', () => {
    vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', stage: 'live', rolled_back: true, stream: 'checkout' } });
    expect(maybeOpenIncident(vault)).not.toBeNull();
    expect(maybeOpenIncident(vault)).toBeNull();
    expect(listJobs(vault).filter((j) => j.type === 'incident')).toHaveLength(1);
  });

  it('an ordinary deploy opens nothing', () => {
    vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', stage: 'live', rolled_back: false, stream: 'checkout' } });
    expect(maybeOpenIncident(vault)).toBeNull();
  });
});

describe('an incident opens itself when CI goes red on a live stream', () => {
  const liveDeploy = () => vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', stage: 'live', rolled_back: false, stream: 'checkout' } });
  const redCi = (record: string) => vault.events.emit({ type: 'ci.completed', agent: 'backend_engineer', job: null, payload: { stream: 'checkout', green: false, record, steps: [{ name: 'test', ok: false, code: 1 }] } });

  it('a red run on a stream that is serving opens one incident with trigger red_ci_live', () => {
    liveDeploy();
    redCi('Workspace/checkout/.cubicle-ci/2026-09-11-1200.json');
    const id = maybeOpenIncident(vault)!;
    const j = readJob(vault, id)!.data;
    expect(j.type).toBe('incident');
    expect(j.assigned).toBe('sre');
    expect(j.risk).toBe('high');
    expect(j.priority).toBe(1);
    expect(j.stream).toBe('checkout');
    const opened = vault.events.query({ types: ['incident.opened'] });
    expect(opened).toHaveLength(1);
    expect(opened[0].payload.trigger).toBe('red_ci_live');
    expect(readJob(vault, id)!.body).toMatch(/Docs\/postmortems/);
  });

  it('a deploy recorded before stages existed (no stage field) still counts as live', () => {
    vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', rolled_back: false, stream: 'checkout' } });
    redCi('Workspace/checkout/.cubicle-ci/2026-09-11-1201.json');
    expect(maybeOpenIncident(vault)).not.toBeNull();
    expect(vault.events.query({ types: ['incident.opened'] })[0].payload.trigger).toBe('red_ci_live');
  });

  it('a red run on a stream that never went live opens nothing', () => {
    redCi('Workspace/checkout/.cubicle-ci/2026-09-11-1200.json');
    expect(maybeOpenIncident(vault)).toBeNull();
    expect(listJobs(vault).filter((j) => j.type === 'incident')).toHaveLength(0);
  });

  it('a preview-only deploy is not production, so a red run still opens nothing', () => {
    vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', stage: 'preview', rolled_back: false, stream: 'checkout' } });
    redCi('Workspace/checkout/.cubicle-ci/2026-09-11-1200.json');
    expect(maybeOpenIncident(vault)).toBeNull();
  });

  it('a green run opens nothing', () => {
    liveDeploy();
    vault.events.emit({ type: 'ci.completed', agent: 'backend_engineer', job: null, payload: { stream: 'checkout', green: true, record: 'Workspace/checkout/.cubicle-ci/ok.json', steps: [] } });
    expect(maybeOpenIncident(vault)).toBeNull();
  });

  it('is idempotent per CI record, and a still-red build does not file one job a tick', () => {
    liveDeploy();
    redCi('Workspace/checkout/.cubicle-ci/one.json');
    const first = maybeOpenIncident(vault)!;
    expect(first).not.toBeNull();
    // same record again: the derived id already exists
    expect(maybeOpenIncident(vault)).toBeNull();
    // a different record while the first incident is still open: the room already knows
    redCi('Workspace/checkout/.cubicle-ci/two.json');
    expect(maybeOpenIncident(vault)).toBeNull();
    expect(listJobs(vault).filter((j) => j.type === 'incident')).toHaveLength(1);
    // once the first is closed, a genuinely new red record opens a second
    updateJob(vault, first, { status: 'done' }, 'daemon');
    const second = maybeOpenIncident(vault)!;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(listJobs(vault).filter((j) => j.type === 'incident')).toHaveLength(2);
  });

  it('a rollback is handled before a red build when both are waiting', () => {
    liveDeploy();
    redCi('Workspace/checkout/.cubicle-ci/one.json');
    vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', stage: 'live', rolled_back: true, stream: 'checkout' } });
    const id = maybeOpenIncident(vault)!;
    expect(vault.events.query({ types: ['incident.opened'], job: id })[0].payload.trigger).toBe('rollback');
  });
});

describe('corrective actions come out of the postmortem', () => {
  function finishedIncident(actions: string[]): string {
    const id = createJob(vault, { type: 'incident', title: 'Outage', assigned: 'sre', goal: 'g', team: 'dev', stream: 'checkout', risk: 'high' }, 'daemon');
    const pm = 'Docs/postmortems/2026-09-11-checkout.md';
    vault.writeText(pm, `---\nincident: ${id}\nstream: checkout\nowner: sre\n---\n# Postmortem\n\n## Root cause\n\nThe deploy had no smoke check.\n\n## Corrective actions\n\n${actions.map((a) => `- ${a}`).join('\n')}\n\n## What we learned\n\nx\n`, 'sre');
    vault.updateNote(`Jobs/${id}.md`, (n) => ({ data: n.data, body: setSection(n.body, '## Result', '```json\n' + JSON.stringify({ status: 'done', artifacts: [pm], summary: 's', metrics: {}, blockers: [], lessons: [], findings: [] }) + '\n```') }), 'sre');
    updateJob(vault, id, { status: 'done' }, 'daemon');
    return id;
  }

  it('makes one job per bullet, owned by the dev manager, linked back to the incident', () => {
    const id = finishedIncident(['Add a smoke check to the deploy — owner: platform_engineer', 'Alert on error rate over 2 % — owner: sre']);
    const made = maybeCorrectiveActions(vault);
    expect(made).toHaveLength(2);
    const jobs = made.map((m) => readJob(vault, m)!.data);
    expect(jobs.every((j) => j.owner_role === 'dev_manager')).toBe(true);
    expect(jobs.every((j) => j.stream === 'checkout')).toBe(true);
    expect(jobs.every((j) => j.links.includes(`[[${id}]]`))).toBe(true);
    expect(jobs.map((j) => j.title)).toEqual(expect.arrayContaining([expect.stringContaining('smoke check')]));
  });

  it('runs once per incident', () => {
    finishedIncident(['Add a smoke check — owner: sre']);
    expect(maybeCorrectiveActions(vault)).toHaveLength(1);
    expect(maybeCorrectiveActions(vault)).toHaveLength(0);
  });

  it('caps the fan-out so one postmortem cannot flood the queue', () => {
    finishedIncident(Array.from({ length: 8 }, (_, i) => `Action ${i} — owner: sre`));
    expect(maybeCorrectiveActions(vault).length).toBe(CORRECTIVE_MAX);
  });

  it('an incident whose postmortem has no corrective actions makes no jobs and is still marked done', () => {
    const id = createJob(vault, { type: 'incident', title: 'Outage', assigned: 'sre', goal: 'g', team: 'dev', stream: 'checkout', risk: 'high' }, 'daemon');
    updateJob(vault, id, { status: 'done' }, 'daemon');
    expect(postmortemPath(vault, id)).toBeNull();
    expect(maybeCorrectiveActions(vault)).toEqual([]);
    expect(maybeCorrectiveActions(vault)).toEqual([]);
  });
});

describe('the division plan reads the budgets', () => {
  it('a spent budget reaches the lead in the goal text', () => {
    const goal = teamPlanGoal({ id: 'dev', name: 'Dev', lead: 'dev_manager', members: ['backend_engineer'], mission: 'm', processes: [], wip: { in_progress: 3, review: 2, testing: 2 } }, '- Raise checkout completion', 'none', 'research_manager', ['checkout: 6.0 h of 4 h error budget SPENT — this plan prioritises reliability work over new features (§23)']);
    expect(goal).toMatch(/SPENT/);
    expect(goal).toMatch(/reliability/);
  });

  it('no budgets means no extra noise in the goal', () => {
    const goal = teamPlanGoal({ id: 'qa', name: 'QA', lead: 'qa_lead', members: [], mission: 'm', processes: [], wip: { in_progress: 3, review: 2, testing: 3 } }, '- Test', 'none', 'research_manager', []);
    expect(goal).not.toMatch(/error budget/);
  });
});

describe('a model-supplied stream cannot stop the sweep (fix wave item 4 / C2)', () => {
  // Every one of these used to reach `vault.abs` through `readStream` and throw UnsafePathError out of
  // `maybeOpenIncident`, which the tick's single try/catch turned into a permanent heartbeat stall: the event
  // stays in the log, so every later tick threw at the same place.
  const HOSTILE = ['../../etc', '..', 'a/../../b', 'check,out', ''];

  it('a rolled-back deploy carrying a hostile stream is skipped, not thrown on', () => {
    for (const bad of HOSTILE) vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', stage: 'live', rolled_back: true, stream: bad } });
    expect(() => maybeOpenIncident(vault)).not.toThrow();
    expect(maybeOpenIncident(vault)).toBeNull();
    expect(listJobs(vault).filter((j) => j.type === 'incident')).toHaveLength(0);
  });

  it('a red CI run carrying a hostile stream is skipped, not thrown on', () => {
    vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', stage: 'live', rolled_back: false, stream: 'checkout' } });
    for (const bad of HOSTILE) vault.events.emit({ type: 'ci.completed', agent: 'backend_engineer', job: null, payload: { stream: bad, green: false, record: `Workspace/${bad}/.cubicle-ci/x.json` } });
    expect(() => maybeOpenIncident(vault)).not.toThrow();
    expect(maybeOpenIncident(vault)).toBeNull();
  });

  it('a poisoned event does not hide the good one behind it', () => {
    vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', stage: 'live', rolled_back: true, stream: 'checkout' } });
    for (const bad of HOSTILE) vault.events.emit({ type: 'deploy.done', agent: 'sre', job: null, payload: { project: 'acme', stage: 'live', rolled_back: true, stream: bad } });
    const id = maybeOpenIncident(vault);
    expect(id).not.toBeNull();
    expect(readJob(vault, id!)!.data.stream).toBe('checkout');
  });
});
