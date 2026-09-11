import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob } from '@cubicle/core';
import { parseToolsConfig, scanForSecrets, secretsGuardrail, commandPublishes, SECRET_PATTERNS, type ToolContext } from '../src/index.js';

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

  // Fix round 1 (review-T7 IMPORTANT 3, MINORS): bare JWTs, unquoted KEY=value, and the extra token prefixes.
  it('catches a bare JWT, an unquoted KEY=value secret, an encrypted key block, glpat- and npm_ tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(scanForSecrets(`Authorization: Bearer ${jwt}`)).toContain('JWT');
    expect(scanForSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toContain('unquoted secret assignment');
    expect(scanForSecrets('Authorization: Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toContain('Bearer token');
    expect(scanForSecrets('-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIB...\n-----END ENCRYPTED PRIVATE KEY-----')).toContain('private key block');
    expect(scanForSecrets('glpat-aBcDeFgHiJkLmNoPqRsT')).toContain('GitLab token');
    expect(scanForSecrets('npm_0123456789abcdefghijklmnopqrstuvwxyz')).toContain('npm token');
  });

  it('the unquoted key=value pattern does not fire on hex ids, lockfile hashes or data URIs', () => {
    expect(scanForSecrets('COMMIT_SHA=1234567890abcdef1234567890abcdef12345678')).toEqual([]); // pure hex: a commit sha, not a secret
    expect(scanForSecrets('resolution: {integrity: sha512-KJs8fFqXk2M9nq0Z8p9y3s6t7u8v9w0x1y2z3A4B5C6D7E8F9g0H1i2J3k4L5m6N==}')).toEqual([]); // lockfile-style, colon not =
    expect(scanForSecrets('background: url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB)')).toEqual([]); // data URI
  });
});

describe('commandPublishes', () => {
  // review-T7 IMPORTANT 2: a flag's own value token (dir, k=v) does not start with "-" and used to defeat the
  // flags-only lookahead, so `git -C dir push` and `git -c k=v commit` were never recognised as publishing.
  it('recognises publishing subcommands past a global flag that takes a value', () => {
    expect(commandPublishes('git -C dir push')).toBe(true);
    expect(commandPublishes('git -c user.name=x commit -m y')).toBe(true);
    expect(commandPublishes('cd x && git push')).toBe(true);
  });

  it('still ignores git invocations that never commit or push', () => {
    expect(commandPublishes('git log --oneline -5')).toBe(false);
    expect(commandPublishes('git -C dir status')).toBe(false);
    expect(commandPublishes('npm run build')).toBe(false);
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

  // review-T7 CRITICAL: an agent-controlled `dir` must never let the guardrail walk or read outside the vault.
  // Proven concretely, not just by message shape: plant a real secret at the escaped location and confirm the
  // guardrail still passes (defers to the tool's own `outbound.ts` confinement check, which will refuse the
  // call anyway) — if the old `path.join(root, dirRel)` walk still ran, this would come back a refusal instead.
  it('never walks or reads outside the vault for a `..`-escaping or absolute deploy dir', async () => {
    const traversal = await g.check('deploy.site', { dir: '../../..' }, ctxFor());
    expect(traversal).toBeNull();

    const escaped = mkdtempSync(path.join(tmpdir(), 'cubicle-escape-'));
    try {
      writeFileSync(path.join(escaped, 'secret.js'), `const key = "${AWS}";\n`);
      const absolute = await g.check('deploy.site', { dir: escaped }, ctxFor());
      expect(absolute).toBeNull(); // the secret sitting right there is never seen — the path never gets walked
    } finally {
      rmSync(escaped, { recursive: true, force: true });
    }
  });

  it('skips node_modules, .git and .cubicle while walking a deploy directory', async () => {
    mkdirSync(path.join(dir, 'Site/dist/node_modules/evil'), { recursive: true });
    writeFileSync(path.join(dir, 'Site/dist/node_modules/evil/index.js'), `const key = "${AWS}";\n`);
    writeFileSync(path.join(dir, 'Site/dist/app.js'), 'console.log("hello");\n');
    expect(await g.check('deploy.site', { dir: 'Site/dist' }, ctxFor())).toBeNull();
  });

  it('refuses a deploy directory with more scannable-tree files than the cap, rather than reporting it clean', async () => {
    const big = path.join(dir, 'Site/dist');
    mkdirSync(big, { recursive: true });
    for (let i = 0; i < 5001; i++) writeFileSync(path.join(big, `f${i}.txt`), 'x');
    const reason = await g.check('deploy.site', { dir: 'Site/dist' }, ctxFor());
    expect(reason).toMatch(/more than 5000 files/);
  });

  // review-T7 MINOR: exercise the no-git-repo fallback (scanVaultDir over Site/Workspace) directly.
  it('falls back to scanning Site/Workspace when there is no git repo to diff', async () => {
    rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    vault.writeText('Site/config.js', `const key = "${AWS}";\n`, 'backend_engineer');
    const reason = await g.check('git.commit', { message: 'wip' }, ctxFor());
    expect(reason).toMatch(/AWS access key id/);
    expect(reason).toMatch(/Site\/config\.js/);
  });

  it('the no-git-repo fallback passes a clean vault', async () => {
    rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    vault.writeText('Site/config.js', 'console.log("hello");\n', 'backend_engineer');
    expect(await g.check('git.commit', { message: 'wip' }, ctxFor())).toBeNull();
  });
});
