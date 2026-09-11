import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob } from '@cubicle/core';
import { parseToolsConfig, deploySite, DEPLOY_STAGES, DEPLOY_SNAPSHOTS_KEPT, previousLiveSnapshot, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-deploy-')); vault = (await scaffoldVault(dir)).vault;
  vault.writeText('Brand/name.md', '---\nname: Acme\ntagline: t\nurl: ""\n---\n# Acme\n', 'owner');
  // Site/dist is a cache path (core/src/guard.ts:isCachePath): a build writes it, never the vault API.
  mkdirSync(path.join(dir, 'Site/dist'), { recursive: true });
  writeFileSync(path.join(dir, 'Site/dist/index.html'), '<!doctype html><title>v1</title>\n');
  writeFileSync(path.join(dir, 'Site/dist/only-in-v1.js'), 'fine()\n');
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

let step = 0;
function ctxFor(roleId = 'sre'): ToolContext {
  const role = RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${roleId}.md`)).data);
  return { vault, events: vault.events, roleId, role, jobId: 'job_d', config: cfg, env: {}, workspace: '.cubicle/workspace/job_d', now: () => new Date(), idempotencyKey: `job_d:1:${++step}`, scheduler: { enqueue: (j) => createJob(vault, j, roleId) } };
}

const args = (over: Record<string, unknown> = {}) => ({ dir: 'Site/dist', stage: 'preview' as const, canary_percent: 5, metrics: [] as string[], rollback: false, ...over });

describe('deploy.site stages (owner operating model §20)', () => {
  it('the three stages are preview, canary, live', () => {
    expect(DEPLOY_STAGES).toEqual(['preview', 'canary', 'live']);
  });

  it('a preview deploy needs nothing before it and records its stage', async () => {
    const r = await deploySite.handler(args(), ctxFor());
    expect(r.ok).toBe(true);
    const ev = vault.events.query({ types: ['deploy.done'] });
    expect(ev[0].payload).toMatchObject({ stage: 'preview' });
  });

  it('canary is refused until a preview of the same project has gone out', async () => {
    const refused = await deploySite.handler(args({ stage: 'canary' }), ctxFor());
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/preview/);

    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    const ok = await deploySite.handler(args({ stage: 'canary', metrics: ['error rate', 'checkout completion'] }), ctxFor());
    expect(ok.ok).toBe(true);
    const last = vault.events.query({ types: ['deploy.done'] }).at(-1)!;
    expect(last.payload).toMatchObject({ stage: 'canary', canary_percent: 5 });
    expect(last.payload.metrics).toEqual(['error rate', 'checkout completion']);
  });

  it('live is refused until a canary has gone out, and demands the metrics it will watch', async () => {
    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    const noCanary = await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());
    expect(noCanary.ok).toBe(false);
    expect(noCanary.text).toMatch(/canary/);

    await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
    const noMetrics = await deploySite.handler(args({ stage: 'live', metrics: [] }), ctxFor());
    expect(noMetrics.ok).toBe(false);
    expect(noMetrics.text).toMatch(/metrics/);

    const live = await deploySite.handler(args({ stage: 'live', metrics: ['error rate', 'latency'] }), ctxFor());
    expect(live.ok).toBe(true);
    expect(vault.events.query({ types: ['deploy.done'] }).at(-1)!.payload).toMatchObject({ stage: 'live', metrics: ['error rate', 'latency'] });
  });

  it('every deploy keeps a snapshot, and rollback republishes the previous live one', async () => {
    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
    await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());

    writeFileSync(path.join(dir, 'Site/dist/index.html'), '<!doctype html><title>v2 broken</title>\n');
    writeFileSync(path.join(dir, 'Site/dist/only-in-v2.js'), 'boom()\n'); // v1 never had this file
    rmSync(path.join(dir, 'Site/dist/only-in-v1.js')); // and v2 deleted one v1 had
    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
    await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());

    expect(previousLiveSnapshot(vault, 'acme')).not.toBeNull();
    const back = await deploySite.handler(args({ rollback: true, stage: 'live', metrics: ['error rate'] }), ctxFor());
    expect(back.ok).toBe(true);
    expect(back.text).toMatch(/rolled back/i);
    const ev = vault.events.query({ types: ['deploy.done'] }).at(-1)!;
    expect(ev.payload).toMatchObject({ rolled_back: true, stage: 'live' });
    expect(readFileSync(path.join(dir, 'Site/dist/index.html'), 'utf8')).toContain('v1');
    // A rollback replaces the build directory: the bad build's added file is gone, its deletion is undone.
    expect(existsSync(path.join(dir, 'Site/dist/only-in-v2.js'))).toBe(false);
    expect(existsSync(path.join(dir, 'Site/dist/only-in-v1.js'))).toBe(true);
    // The snapshot the event points at really holds the bytes that went out — not just a path.
    const snap = path.join(dir, String(ev.payload.snapshot));
    expect(readFileSync(path.join(snap, 'index.html'), 'utf8')).toContain('v1');
    expect(existsSync(path.join(snap, 'only-in-v2.js'))).toBe(false);
    expect(readFileSync(path.join(previousLiveSnapshot(vault, 'acme')!, 'index.html'), 'utf8')).toContain('v1');
    // …and so does what the deployer published: the newest live copy the mock adapter wrote.
    const copies = readdirSync(path.join(dir, '.cubicle/mock/deploy')).filter((n) => n.startsWith('acme-live-')).sort();
    expect(readFileSync(path.join(dir, '.cubicle/mock/deploy', copies.at(-1)!, 'index.html'), 'utf8')).toContain('v1');
  });

  it('a second change cannot skip the stages just because the project once went through them', async () => {
    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
    expect((await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor())).ok).toBe(true);

    writeFileSync(path.join(dir, 'Site/dist/index.html'), '<!doctype html><title>v2</title>\n');
    const straightToLive = await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());
    expect(straightToLive.ok).toBe(false);
    expect(straightToLive.text).toMatch(/canary/);
    const straightToCanary = await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
    expect(straightToCanary.ok).toBe(false);
    expect(straightToCanary.text).toMatch(/preview/);

    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
    expect((await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor())).ok).toBe(true);
  });

  it('the recorded event admits the canary percentage is not enforced', async () => {
    await deploySite.handler(args({ stage: 'preview' }), ctxFor());
    await deploySite.handler(args({ stage: 'canary', canary_percent: 25, metrics: ['error rate'] }), ctxFor());
    const ev = vault.events.query({ types: ['deploy.done'] }).at(-1)!;
    expect(ev.payload).toMatchObject({ stage: 'canary', canary_percent: 25, canary_enforced: false });
    expect(typeof ev.payload.build_hash).toBe('string');
    expect(String(ev.payload.build_hash).length).toBeGreaterThan(0);
  });

  it('a rollback with nothing to roll back to says so instead of pretending', async () => {
    const r = await deploySite.handler(args({ rollback: true }), ctxFor());
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/no previous live deploy/i);
  });

  it('snapshots do not pile up forever, but the one a rollback needs is never pruned', async () => {
    for (let i = 0; i < DEPLOY_SNAPSHOTS_KEPT + 4; i++) {
      writeFileSync(path.join(dir, 'Site/dist/index.html'), `<!doctype html><title>build ${i}</title>\n`);
      await deploySite.handler(args({ stage: 'preview' }), ctxFor());
      await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
      await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());
    }
    const snaps = readdirSync(path.join(dir, '.cubicle/deploys/acme'));
    expect(snaps.length).toBeLessThanOrEqual(DEPLOY_SNAPSHOTS_KEPT + 2); // + the two live snapshots held back
    const prev = previousLiveSnapshot(vault, 'acme');
    expect(prev).not.toBeNull();
    expect(readFileSync(path.join(prev!, 'index.html'), 'utf8')).toContain(`build ${DEPLOY_SNAPSHOTS_KEPT + 2}`);
  });

  it('the description says the canary percentage is a mock until real infrastructure exists', () => {
    expect(deploySite.description).toMatch(/mock/i);
    expect(deploySite.description).toMatch(/preview.*canary.*live/i);
  });
});

describe('the deploy history window is the newest one (fix wave item 2 / I2)', () => {
  // 600 old deploy.done events, more than deploysOf's limit of 500. An ascending window would stop at the
  // 500th and never see the preview/canary this build actually did, so live would be refused for ever.
  const floodOld = (n = 600) => {
    for (let i = 0; i < n; i++) {
      vault.events.emit({
        type: 'deploy.done', agent: 'sre', job: 'job_old',
        payload: { url: 'https://old.example', project: 'acme', mode: 'mock', key: `old:${i}`, stage: 'preview', canary_percent: null, canary_enforced: false, metrics: [], rolled_back: false, snapshot: null, build_hash: 'ancientbuildhash', stream: null },
      });
    }
  };

  it('a preview and a canary past the 500-event mark still let the live deploy through', async () => {
    floodOld();
    writeFileSync(path.join(dir, 'Site/dist/index.html'), '<!doctype html><title>brand new build</title>\n');
    expect((await deploySite.handler(args({ stage: 'preview' }), ctxFor())).ok).toBe(true);
    expect((await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor())).ok).toBe(true);
    const live = await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());
    expect(live.ok).toBe(true);
    expect(vault.events.query({ types: ['deploy.done'] }).at(-1)!.payload).toMatchObject({ stage: 'live' });
  });

  it('the stage order is still enforced past the 500-event mark', async () => {
    floodOld();
    writeFileSync(path.join(dir, 'Site/dist/index.html'), '<!doctype html><title>unvouched build</title>\n');
    const straightToLive = await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());
    expect(straightToLive.ok).toBe(false);
    expect(straightToLive.text).toMatch(/canary/);
  });

  it('previousLiveSnapshot still walks back exactly one live deploy past the window', async () => {
    floodOld();
    for (const tag of ['one', 'two']) {
      writeFileSync(path.join(dir, 'Site/dist/index.html'), `<!doctype html><title>${tag}</title>\n`);
      await deploySite.handler(args({ stage: 'preview' }), ctxFor());
      await deploySite.handler(args({ stage: 'canary', metrics: ['error rate'] }), ctxFor());
      await deploySite.handler(args({ stage: 'live', metrics: ['error rate'] }), ctxFor());
    }
    const prev = previousLiveSnapshot(vault, 'acme');
    expect(prev).not.toBeNull();
    expect(readFileSync(path.join(prev!, 'index.html'), 'utf8')).toContain('one');
  });
});
