import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listJobs, createStream } from '@cubicle/core';
import { CAPABILITIES, loadIntegrations, parseIntegrations, vaultNativeAdapters, adapterFor } from '../src/index.js';

const root = path.resolve(__dirname, '../../..');
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-integ-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('config/integrations.yaml', () => {
  const cfg = loadIntegrations(path.join(root, 'config/integrations.yaml'));

  it('covers every capability the program design names, each vault-native today', () => {
    expect([...CAPABILITIES]).toEqual(['work', 'docs', 'git', 'ci', 'chat', 'secrets', 'metrics', 'errors', 'automation']);
    for (const c of CAPABILITIES) {
      expect(cfg.integrations[c], c).toBeDefined();
      expect(cfg.integrations[c].note.length, c).toBeGreaterThan(5);
    }
  });

  it('names the self-hosted candidate for each capability without requiring it', () => {
    expect(cfg.integrations.work.candidate).toBe('Plane');
    expect(cfg.integrations.git.candidate).toBe('Forgejo');
    expect(cfg.integrations.ci.candidate).toBe('Woodpecker CI');
    expect(cfg.integrations.docs.candidate).toBe('BookStack');
    expect(cfg.integrations.chat.candidate).toBe('Mattermost');
    expect(cfg.integrations.errors.candidate).toBe('Sentry');
    expect(cfg.integrations.automation.candidate).toBe('n8n');
    const raw = readFileSync(path.join(root, 'config/integrations.yaml'), 'utf8');
    expect(raw).toMatch(/vault-native/i);
  });

  it('rejects a file that leaves a capability out', () => {
    expect(() => parseIntegrations('integrations:\n  work: { adapter: vault, note: n, candidate: Plane }\n')).toThrow();
  });
});

describe('vault-native adapters', () => {
  it('work creates a job and lists open ones', async () => {
    const a = vaultNativeAdapters({ vault, env: {} });
    const id = await a.work.create({ title: 'Card form', type: 'engineer.ship', assigned: 'frontend_engineer', goal: 'g', risk: 'low', stream: 'checkout' });
    expect(listJobs(vault).map((j) => j.id)).toContain(id);
    expect((await a.work.listOpen()).map((w) => w.id)).toContain(id);
  });

  it('docs writes and reads a page under Docs/', async () => {
    const a = vaultNativeAdapters({ vault, env: {} });
    await a.docs.write('handbook/flow', '# Flow\n\nPull, do not push.\n');
    expect(await a.docs.read('handbook/flow')).toContain('Pull, do not push');
  });

  it('chat posts to a role inbox under Messages/', async () => {
    const a = vaultNativeAdapters({ vault, env: {} });
    await a.chat.post('qa_lead', 'ship is on the queue');
    expect(vault.readText('Messages/qa_lead.md')).toContain('ship is on the queue');
  });

  it('secrets reads the environment and never returns a value it does not have', async () => {
    const a = vaultNativeAdapters({ vault, env: { CLOUDFLARE_API_TOKEN: 'x' } });
    expect(await a.secrets.get('CLOUDFLARE_API_TOKEN')).toBe('x');
    expect(await a.secrets.get('NOPE')).toBeNull();
    expect(await a.secrets.has('CLOUDFLARE_API_TOKEN')).toBe(true);
  });

  it('metrics appends a row to a Metrics/ table', async () => {
    const a = vaultNativeAdapters({ vault, env: {} });
    await a.metrics.record('engineering', { lead_time_h: 4, deploys: 3 });
    expect(vault.readText('Metrics/engineering.md')).toMatch(/lead_time_h/);
  });

  it('errors opens an incident job', async () => {
    createStream(vault, { name: 'Checkout', problem: 'p', customers: 'c', outcome_metric: 'm', owner_team: 'dev' }, 'product_manager');
    const a = vaultNativeAdapters({ vault, env: {} });
    const id = await a.errors.report({ stream: 'checkout', title: 'Deploy rolled back', detail: 'error rate tripled' });
    expect(listJobs(vault).find((j) => j.id === id)?.type).toBe('incident');
  });

  it('ci points at the stream config and git at the vault repo', async () => {
    const a = vaultNativeAdapters({ vault, env: {} });
    expect(a.ci.configPath('checkout')).toBe('Workspace/checkout/cubicle-ci.yaml');
    expect(a.git.repoRoot('checkout')).toBe('Workspace/checkout');
  });

  it('automation lists the Processes/ a team may run', async () => {
    const a = vaultNativeAdapters({ vault, env: {} });
    expect(await a.automation.list()).toEqual(expect.arrayContaining(['feature', 'weekly_review']));
  });

  it('adapterFor hands back the vault-native adapter and refuses anything not built yet', () => {
    const cfg = loadIntegrations(path.join(root, 'config/integrations.yaml'));
    expect(adapterFor(cfg, 'work', { vault, env: {} })).toBeDefined();
    const swapped = parseIntegrations(readFileSync(path.join(root, 'config/integrations.yaml'), 'utf8').replace('work:       { adapter: vault', 'work:       { adapter: plane'));
    expect(() => adapterFor(swapped, 'work', { vault, env: {} })).toThrow(/plane/i);
  });
});
