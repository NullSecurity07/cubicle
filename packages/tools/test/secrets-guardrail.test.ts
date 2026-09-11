import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob } from '@cubicle/core';
import { parseToolsConfig, scanForSecrets, secretsGuardrail, SECRET_PATTERNS, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-secrets-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function ctxFor(roleId = 'backend_engineer'): ToolContext {
  const role = RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${roleId}.md`)).data);
  return { vault, events: vault.events, roleId, role, jobId: 'job_s', config: cfg, env: {}, workspace: '.cubicle/workspace/job_s', now: () => new Date(), scheduler: { enqueue: (j) => createJob(vault, j, roleId) } };
}

const AWS = 'AKIAIOSFODNN7EXAMPLE';
const STRIPE = 'sk_live_PLACEHOLDER';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIB...\n-----END RSA PRIVATE KEY-----';

describe('scanForSecrets', () => {
  it('catches the shapes the toolchain document names (§34 secret detection)', () => {
    expect(scanForSecrets(`export const k = "${AWS}";`)).toContain('AWS access key id');
    expect(scanForSecrets(`STRIPE=${STRIPE}`)).toContain('Stripe secret key');
    expect(scanForSecrets(PEM)).toContain('private key block');
    expect(scanForSecrets('ghp_0123456789abcdefghijklmnopqrstuvwxyz')).toContain('GitHub token');
    expect(scanForSecrets('api_key: "kR3s9QmZ1pL7vX2tYb8nW4cH6dF0gJ5a"')).toContain('generic secret assignment');
  });

  it('does not fire on ordinary code, placeholders or the env example', () => {
    expect(scanForSecrets('const apiKey = process.env.STRIPE_SECRET_KEY;')).toEqual([]);
    expect(scanForSecrets('STRIPE_SECRET_KEY=')).toEqual([]);
    expect(scanForSecrets('password: "changeme"')).toEqual([]);
    expect(scanForSecrets(readFileSync(path.join(dir, '.env.example'), 'utf8'))).toEqual([]);
  });

  it('reports each pattern once, however many times it matches', () => {
    expect(scanForSecrets(`${AWS}\n${AWS}\n${AWS}`)).toEqual(['AWS access key id']);
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(6);
  });
});

describe('secretsGuardrail', () => {
  const g = secretsGuardrail();

  it('lets an ordinary shell command and an ordinary commit through', async () => {
    expect(await g.check('shell.run', { command: 'npm run build' }, ctxFor())).toBeNull();
    expect(await g.check('git.commit', { message: 'ship the card form' }, ctxFor())).toBeNull();
    expect(await g.check('vault.write', { path: 'Site/x.md', content: AWS }, ctxFor())).toBeNull(); // not a publishing tool
  });

  it('refuses a commit whose working tree carries a secret, naming the file', async () => {
    vault.writeText('Site/config.js', `const key = "${AWS}";\n`, 'backend_engineer');
    const reason = await g.check('git.commit', { message: 'wip' }, ctxFor());
    expect(reason).toMatch(/AWS access key id/);
    expect(reason).toMatch(/Site\/config\.js/);
    expect(reason).toMatch(/\.env/);
  });

  it('refuses a shell.run that commits or pushes, and ignores one that only logs', async () => {
    vault.writeText('Site/config.js', `const key = "${AWS}";\n`, 'backend_engineer');
    expect(await g.check('shell.run', { command: 'git add -A && git commit -m wip' }, ctxFor())).toMatch(/AWS access key id/);
    expect(await g.check('shell.run', { command: 'git push origin main' }, ctxFor())).toMatch(/AWS access key id/);
    expect(await g.check('shell.run', { command: 'git log --oneline -5' }, ctxFor())).toBeNull();
  });

  it('refuses a deploy whose build directory carries a secret', async () => {
    // Site/dist is a cache path (guard.ts isCachePath): it is a real build output, written directly like the
    // engineer's build step would, not through vault.writeText (which refuses cache paths on purpose).
    mkdirSync(path.join(dir, 'Site/dist'), { recursive: true });
    writeFileSync(path.join(dir, 'Site/dist/app.js'), `fetch("https://api", { headers: { Authorization: "Bearer ${STRIPE}" } });\n`);
    const reason = await g.check('deploy.site', { dir: 'Site/dist' }, ctxFor());
    expect(reason).toMatch(/Stripe secret key/);
    expect(reason).toMatch(/Site\/dist\/app\.js/);
  });

  it('a clean deploy directory passes', async () => {
    mkdirSync(path.join(dir, 'Site/dist'), { recursive: true });
    writeFileSync(path.join(dir, 'Site/dist/app.js'), 'console.log("hello");\n');
    expect(await g.check('deploy.site', { dir: 'Site/dist' }, ctxFor())).toBeNull();
  });
});
