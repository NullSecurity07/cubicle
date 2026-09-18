/**
 * Ruling W4-8: the site scaffold no longer contradicts its own goal.
 *
 * `job_20260914_b88c4b` was given the goal "Keep it static and boring — no framework, no build step the owner
 * has to learn". The only template the sandbox offered was `/opt/templates/minimal`, which is Astro with an npm
 * build, so the engineer ran `cp -a /opt/templates/minimal/. .` — the sensible thing to do with the only
 * template there is — and the job cost five CI failures, a step_limit, three attempts and 25 steps. It then
 * shipped default Astro placeholder content through a green build.
 *
 * These cases run the template's own pipeline, with bash, against the template's own files: no Docker, no npm,
 * no network. Every step reads `$SITE`, which is `/work/Site` in the sandbox and a temporary directory here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { CiConfig, repoRoot } from '@cubicle/core';
import { STATIC_TEMPLATE, TEMPLATES_MOUNT, templatesDir } from '../src/index.js';

const templateSrc = path.join(templatesDir(), 'static');
const pipeline = CiConfig.parse(YAML.parse(readFileSync(path.join(templateSrc, 'cubicle-ci.yaml'), 'utf8')));

/** Run one named step of the template's pipeline against `site`, exactly as `ci.run` would in the sandbox. */
function step(name: string, site: string): { ok: boolean; output: string } {
  const s = pipeline.steps.find((x) => x.name === name);
  if (!s) throw new Error(`no step "${name}" in the template pipeline (has: ${pipeline.steps.map((x) => x.name).join(', ')})`);
  try {
    return { ok: true, output: execFileSync('bash', ['-c', s.run], { env: { ...process.env, SITE: site }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const runAll = (site: string) => pipeline.steps.map((s) => ({ name: s.name, ...step(s.name, site) }));

let site: string;
beforeAll(() => {
  site = mkdtempSync(path.join(tmpdir(), 'cubicle-static-'));
  cpSync(templateSrc, site, { recursive: true });
  rmSync(path.join(site, 'cubicle-ci.yaml'));       // the pipeline lives in the workspace, not in Site/
});
afterAll(() => rmSync(site, { recursive: true, force: true }));

describe('the static template ships what the seed asks for (W4-8)', () => {
  it('is three files and nothing to install', () => {
    const files = readFileSync(path.join(templateSrc, 'index.html'), 'utf8');
    expect(files).toContain('<!doctype html>');
    expect(files).toContain('styles.css');
    // Not a framework, not a build step, not a dependency: the three things the goal rules out.
    for (const f of ['index.html', 'styles.css']) {
      const text = readFileSync(path.join(templateSrc, f), 'utf8');
      expect(text).not.toMatch(/\bnpm\b/);
      expect(text).not.toMatch(/\bnode_modules\b/);
      expect(text).not.toMatch(/\bastro\b/i);
    }
    // …and the pipeline runs none of it either. It names Astro only as a phrase it refuses to ship.
    for (const s of pipeline.steps) {
      expect(s.run).not.toMatch(/\bnpm (install|run|ci|test|exec)\b/);
      expect(s.run).not.toMatch(/\bnpx\b/);
    }
    expect(pipeline.network).toBe('none');
  });

  it('the pipeline is reachable at the path the seed names', () => {
    expect(STATIC_TEMPLATE).toBe(`${TEMPLATES_MOUNT}/static`);
    expect(templatesDir()).toBe(path.join(repoRoot(), 'config', 'templates'));
  });
});

describe('the pipeline validates the page with bash alone (W4-8)', () => {
  it('refuses the template as it ships — a page still full of REPLACE is not a site', () => {
    const results = runAll(site);
    const placeholders = results.find((r) => r.name === 'no-placeholders')!;
    expect(placeholders.ok).toBe(false);
    expect(placeholders.output).toContain('REPLACE');
    // …and the structural checks pass even so, because the template IS well-formed HTML.
    expect(results.find((r) => r.name === 'html-exists')!.ok).toBe(true);
    expect(results.find((r) => r.name === 'html-valid')!.ok).toBe(true);
  });

  it('goes green once the copy is written', () => {
    const filled = mkdtempSync(path.join(tmpdir(), 'cubicle-static-done-'));
    try {
      cpSync(site, filled, { recursive: true });
      // What an engineer does to this file: drop the instruction comment, write the copy over every REPLACE.
      const page = readFileSync(path.join(filled, 'index.html'), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/REPLACE@example\.com/g, 'hello@speedaudit.test')
        .replace(/REPLACE: [^<"]*/g, 'Three free website speed fixes, by email');
      writeFileSync(path.join(filled, 'index.html'), page);
      for (const r of runAll(filled)) expect(r, `${r.name}: ${r.output}`).toMatchObject({ ok: true });
    } finally { rmSync(filled, { recursive: true, force: true }); }
  });

  it('catches a broken local link, a missing title and a half-written page', () => {
    const broken = mkdtempSync(path.join(tmpdir(), 'cubicle-static-broken-'));
    try {
      writeFileSync(path.join(broken, 'index.html'), '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SpeedAudit</title><link rel="stylesheet" href="styles.css"></head><body><main><h1>Speed audits</h1></main></body></html>\n');
      // styles.css was never written: the page references a file that is not there.
      expect(step('links-resolve', broken).output).toContain('broken link: styles.css');
      expect(step('html-valid', broken).ok).toBe(true);

      writeFileSync(path.join(broken, 'index.html'), '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="x"></head><body><main><h1>Hi</h1></main></body>\n');
      const half = step('html-valid', broken);
      expect(half.ok).toBe(false);
      expect(half.output).toMatch(/no <title>|<html> opened/);
    } finally { rmSync(broken, { recursive: true, force: true }); }
  });

  it('catches the exact failure of the live run: an Astro scaffold shipped as the company site', () => {
    const astro = mkdtempSync(path.join(tmpdir(), 'cubicle-static-astro-'));
    try {
      writeFileSync(path.join(astro, 'index.html'), '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="x"><title>Astro Basics</title></head><body><main><h1>Welcome to Astro</h1></main></body></html>\n');
      const r = step('no-placeholders', astro);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('placeholder or scaffold text left in the site');
    } finally { rmSync(astro, { recursive: true, force: true }); }
  });
});
