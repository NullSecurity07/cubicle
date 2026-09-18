import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, loadOrg, readJob, listJobs, listStreams, createProposal,
  readCiConfig, ciConfigPath, ciStatus, latestCiRecord, JobResult, type JobFrontmatter,
} from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools, phase5Tools, hasDocker, hasSandboxImage, STATIC_TEMPLATE, templatesDir } from '@cubicle/tools';
import { runJob, vaultScheduler, shipRefusal, type Llm } from '@cubicle/harness';
import type { RoutedChatResult, RouteRequest, ChatMessage, ToolSchema } from '@cubicle/router';
import { seedFirstStream, seedFirstJobs } from '../src/first-run.js';
import { adoptFounderBrief } from './helpers/brief.js';
import { WorkerPool } from '../src/workers.js';

const root = path.resolve(__dirname, '../../..');
const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));

/** With no Docker image and no opted-in local shell, `ci.run` refuses before any step runs. */
const SANDBOXED = hasDocker() && hasSandboxImage();

let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-firstrun-')); vault = (await scaffoldVault(dir)).vault;
  // The owner types an idea: the one thing that starts a company (spec §12).
  createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'The idea', body: 'A tiny shop that sells one good notebook.' }, 'owner');
  // …and adopts the founder brief the company wrote from it: the first jobs are seeded on the heartbeat after
  // that, never off the idea alone (ruling P8-15).
  adoptFounderBrief(vault);
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

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

const base = () => ({ vault, toolsConfig: cfg, registry: new ToolRegistry().registerAll([...phase3Tools(), ...phase5Tools()]), scheduler: vaultScheduler(vault), env: {} });

/** Seed the first stream and the first jobs, the way the first heartbeat does, and hand back the site ship. */
function firstRun(): { slug: string; ship: JobFrontmatter } {
  const slug = seedFirstStream(vault)!;
  const ids = seedFirstJobs(vault, loadOrg(vault));
  const ship = ids.map((id) => readJob(vault, id)!.data).find((j) => j.type === 'engineer.ship')!;
  return { slug, ship };
}

describe('a fresh vault\'s first seeded job can finish (fix wave item 10 / I3)', () => {
  it('the first stream comes with a workspace and a pipeline that parses', () => {
    const slug = seedFirstStream(vault)!;
    expect(listStreams(vault).map((s) => s.slug)).toEqual([slug]);
    const cfgRead = readCiConfig(vault, slug);
    expect(cfgRead.ok).toBe(true);
    if (cfgRead.ok) {
      expect(cfgRead.config.steps.length).toBeGreaterThan(0);
      expect(cfgRead.config.network).toBe('none');
    }
    // The file tells the engineer it is a placeholder, where they will actually read it.
    const text = vault.readText(ciConfigPath(slug));
    expect(text).toMatch(/Replace the/i);
    expect(text).toMatch(/§17/);
  });

  it('seeds the stream once, and emits one vault.wrote for the stream note (item 13 / M4)', () => {
    const slug = seedFirstStream(vault)!;
    expect(seedFirstStream(vault)).toBeNull();
    const wrote = vault.events.query({ types: ['vault.wrote'] }).filter((e) => e.payload.path === `Streams/${slug}.md`);
    expect(wrote).toHaveLength(1);
    expect(typeof wrote[0].payload.sha).toBe('string');   // the sha-less duplicate is gone
  });

  it('the seeded ship names the stream, and its goal tells the engineer to run ci.run', () => {
    const { slug, ship } = firstRun();
    expect(ship.stream).toBe(slug);
    expect(ship.risk).toBe('low');
    const body = readJob(vault, ship.id)!.body;
    expect(body).toMatch(/ci\.run/);
    expect(body).toMatch(/cubicle-ci\.yaml/);
  });

  it('the seeded ship dispatches: nothing about the first run is at a WIP limit', () => {
    const { ship } = firstRun();
    const pool = new WorkerPool(vault, { harness: {} as never, heartbeat: {} as never, maxConcurrent: 8 });
    expect(pool.nextJob(ship.assigned)).toBe(ship.id);
    expect(vault.events.query({ types: ['daemon.warning'] }).some((e) => e.payload.where === 'wip')).toBe(false);
  });

  it('the ship gate is satisfiable on the seeded stream, and refuses before ci.run has run', () => {
    const { ship } = firstRun();
    // Before any run: refused, and the refusal names the tool that fixes it.
    const before = shipRefusal(vault, ship, JobResult.parse({ status: 'done', summary: 'built the site' }));
    expect(before).toMatch(/ci\.run/);
    expect(ciStatus(vault, ship.stream!).ok).toBe(false);
  });

  it.runIf(SANDBOXED)('end to end: the seeded engineer.ship builds the site, runs CI and finishes done', async () => {
    const { slug, ship } = firstRun();
    const out = await runJob({ ...base(), llm: scripted([
      { tool: 'vault.write', args: { path: 'Site/index.html', content: '<!doctype html><title>Notebook</title><h1>One good notebook</h1>\n' } },
      { tool: 'ci.run', args: { stream: slug } },
      { tool: 'finish', args: { status: 'done', summary: 'first cut of the site is up and CI is green' } },
    ]) }, ship.id);

    // The ship reported done and was not refused: the CI gate is satisfied.
    expect(out.status).toBe('done');
    expect(shipRefusal(vault, readJob(vault, ship.id)!.data, JobResult.parse({ status: 'done', summary: 's' }))).toBeNull();
    expect(vault.exists('Site/index.html')).toBe(true);
    // On a real, attested green record — not on the gate being absent.
    const rec = latestCiRecord(vault, slug);
    expect(rec).not.toBeNull();
    expect(rec!.record.green).toBe(true);
    expect(ciStatus(vault, slug).ok).toBe(true);

    // A finished ship hands off to its gate chain, so the job parks in in_review with a team:qa.review queued.
    expect(readJob(vault, ship.id)!.data.status).toBe('in_review');
    const gate = listJobs(vault).find((j) => j.type === 'team:qa.review' && j.parent === ship.id)!;
    expect(gate).toBeDefined();
    // And that gate dispatches: it carries the author's team (dev), which used to sit behind dev's WIP limit.
    const pool = new WorkerPool(vault, { harness: {} as never, heartbeat: {} as never, maxConcurrent: 8 });
    expect(pool.nextJob(gate.assigned)).toBe(gate.id);
  }, 120_000);

  it.runIf(!SANDBOXED)('with no sandbox the run is refused for the sandbox, never for a missing pipeline', async () => {
    const { slug, ship } = firstRun();
    expect(readCiConfig(vault, slug).ok).toBe(true);   // the config is there either way
    await runJob({ ...base(), llm: scripted([{ tool: 'ci.run', args: { stream: slug } }, { tool: 'finish', args: { status: 'failed', summary: 'no sandbox here' } }]) }, ship.id);
    const blocked = vault.events.query({ types: ['guardrail.blocked'] }).map((e) => String(e.payload.reason));
    expect(blocked.join(' ')).toMatch(/Docker|bubblewrap/i);
    expect(blocked.join(' ')).not.toMatch(/no CI config/);
  }, 60_000);
});

/**
 * Ruling W4-8: the site seed no longer contradicts its own goal.
 *
 * `job_20260914_b88c4b` was told "Keep it static and boring — no framework, no build step the owner has to
 * learn", and the only template the sandbox offered was `/opt/templates/minimal`: Astro with an npm build. The
 * engineer copied it — the sensible thing to do with the only template there is — and the job cost five CI
 * failures, a step_limit, three attempts and 25 steps before shipping default Astro placeholder content.
 */
describe('the site seed points at a template that matches it (W4-8)', () => {
  const siteSeed = (): JobFrontmatter => {
    seedFirstStream(vault);
    const ids = seedFirstJobs(vault, loadOrg(vault));
    return listJobs(vault).find((j) => ids.includes(j.id) && j.type === 'engineer.ship')!;
  };

  it('names the static template by path, says to copy it, and rules the Astro one out', () => {
    const goal = readJob(vault, siteSeed().id)!.body;
    expect(goal).toContain(STATIC_TEMPLATE);
    expect(goal).toContain('Copy these, then edit');
    expect(goal).toContain('index.html, styles.css and cubicle-ci.yaml');
    // The goal still says what it always said…
    expect(goal).toContain('no framework, no build step');
    // …and now says which template that rules out, by name, where the engineer reads it.
    expect(goal).toContain('Do NOT copy /opt/templates/minimal');
  });

  it('tells the engineer to put the template\'s own pipeline in place of the placeholder one', () => {
    const goal = readJob(vault, siteSeed().id)!.body;
    expect(goal).toContain(`${STATIC_TEMPLATE}/cubicle-ci.yaml`);
    expect(goal).toContain(ciConfigPath("<the job's stream>"));
    expect(goal).toMatch(/no npm/);
  });

  it('the template that goal names is actually in the repo, and is those three files', () => {
    const dirOnDisk = path.join(templatesDir(), 'static');
    for (const f of ['index.html', 'styles.css', 'cubicle-ci.yaml']) expect(readFileSync(path.join(dirOnDisk, f), 'utf8').length).toBeGreaterThan(100);
  });
});
