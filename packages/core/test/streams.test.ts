import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { StreamFrontmatter, streamPath, workspacePath, streamSlug, readStream, listStreams, createStream } from '../src/streams.js';
import { createJob, readJob } from '../src/jobs.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-streams-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const sample = {
  name: 'Checkout', problem: 'Buyers abandon the cart at the payment step.',
  customers: 'First-time buyers on mobile.', outcome_metric: 'Checkout completion from 72 % to 82 %',
  owner_team: 'dev',
};

describe('Streams/<slug>.md', () => {
  it('slugifies the name and writes every field the spec names', () => {
    expect(streamSlug('Checkout & Payments!')).toBe('checkout-payments');
    const slug = createStream(vault, sample, 'product_manager');
    expect(slug).toBe('checkout');
    expect(streamPath(slug)).toBe('Streams/checkout.md');
    expect(workspacePath(slug)).toBe('Workspace/checkout');

    const s = readStream(vault, slug)!;
    expect(s.data).toMatchObject({
      slug: 'checkout', name: 'Checkout', problem: sample.problem, customers: sample.customers,
      outcome_metric: sample.outcome_metric, owner_team: 'dev', repo_path: 'Workspace/checkout', status: 'active',
    });
    expect(s.data.error_budget).toBe(4);
    for (const h of ['## Problem', '## Customers', '## Outcome metric', '## Runbook', '## Error budget']) expect(s.body).toContain(h);
  });

  it('a second stream with the same name gets a distinct slug rather than overwriting the first', () => {
    const a = createStream(vault, sample, 'product_manager');
    const b = createStream(vault, { ...sample, problem: 'A different bet on the same name.' }, 'product_manager');
    expect(b).not.toBe(a);
    expect(listStreams(vault).map((s) => s.slug).sort()).toEqual([a, b].sort());
    expect(readStream(vault, a)!.data.problem).toBe(sample.problem);
  });

  it('_template.md is not a stream and never appears in listStreams', () => {
    createStream(vault, sample, 'product_manager');
    expect(vault.exists('Streams/_template.md')).toBe(true);
    expect(listStreams(vault).map((s) => s.slug)).toEqual(['checkout']);
  });

  it('an outcome metric with no number is still stored — the PM is told by the gate, not by a parse failure', () => {
    const parsed = StreamFrontmatter.safeParse({ slug: 's', name: 'S', problem: 'p', customers: 'c', outcome_metric: 'be better', owner_team: 'dev', repo_path: 'Workspace/s', created: '2026-09-11T00:00:00.000Z' });
    expect(parsed.success).toBe(true);
  });
});

describe('jobs belong to a stream', () => {
  it('createJob stores stream and readJob returns it', () => {
    const slug = createStream(vault, sample, 'product_manager');
    const id = createJob(vault, { type: 'engineer.ship', title: 'Card form', assigned: 'frontend_engineer', goal: 'g', team: 'dev', stream: slug }, 'dev_manager');
    expect(readJob(vault, id)?.data.stream).toBe('checkout');
  });
});
