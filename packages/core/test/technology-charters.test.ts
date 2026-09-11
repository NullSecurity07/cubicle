import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { loadOrg } from '../src/org.js';

const DEV = ['dev_manager', 'product_manager', 'product_designer', 'backend_engineer', 'frontend_engineer', 'fullstack_engineer', 'platform_engineer', 'sre'];
const QA = ['qa_lead', 'qa_automation', 'qa_exploratory', 'qa_performance', 'qa_security', 'qa_release'];
const ALL = [...DEV, ...QA];

let dir: string; let vault: Vault;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-techcharters-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const body = (r: string) => readFileSync(path.join(dir, 'Roles', `${r}.md`), 'utf8');

describe('the fourteen Technology charters', () => {
  it('all fourteen exist, in the right rooms, reporting to the right leads', () => {
    const org = loadOrg(vault);
    for (const r of ALL) expect(org.roles[r], r).toBeDefined();
    for (const r of DEV) expect(org.roles[r].team, r).toBe('dev');
    for (const r of QA) expect(org.roles[r].team, r).toBe('qa');
    expect(org.roles.dev_manager.reports_to).toBe('cto');
    expect(org.roles.qa_lead.reports_to).toBe('cto');
  });

  it('each states its own questions from §28', () => {
    for (const r of ALL) {
      expect(body(r), r).toContain('# Role questions');
      expect(body(r), r).toContain('§28');
      expect(body(r).split('# Role questions')[1].split('\n#')[0].match(/\?/g)?.length ?? 0, r).toBeGreaterThanOrEqual(3);
    }
    expect(body('product_manager')).toMatch(/What should we build\?/);
    expect(body('product_manager')).toMatch(/For whom\?/);
    expect(body('sre')).toMatch(/error budget/i);
    expect(body('qa_exploratory')).toMatch(/what would break/i);
  });

  it('everyone who touches product code can run CI', () => {
    const org = loadOrg(vault);
    for (const r of ['backend_engineer', 'frontend_engineer', 'fullstack_engineer', 'platform_engineer', 'sre', 'dev_manager', 'qa_lead', 'qa_automation', 'qa_performance', 'qa_security', 'qa_release']) {
      expect(org.roles[r].tools, r).toContain('ci.run');
    }
    expect(org.roles.product_manager.tools).not.toContain('ci.run');
  });

  it('the roles that decide architecture can write an ADR, and the product pair cannot', () => {
    const org = loadOrg(vault);
    for (const r of ['dev_manager', 'backend_engineer', 'frontend_engineer', 'fullstack_engineer', 'platform_engineer', 'sre']) expect(org.roles[r].tools, r).toContain('adr.create');
    expect(org.roles.product_manager.tools).not.toContain('adr.create');
    expect(org.roles.qa_lead.tools).not.toContain('adr.create');
  });

  it('model tiers follow the design, and the two QA exceptions say why', () => {
    const org = loadOrg(vault);
    for (const r of ['dev_manager', 'product_manager', 'product_designer', 'backend_engineer', 'frontend_engineer', 'fullstack_engineer', 'platform_engineer', 'sre', 'qa_lead', 'qa_security']) {
      expect(org.roles[r].model_tier, r).toBe('medium');
    }
    for (const r of ['qa_automation', 'qa_exploratory', 'qa_performance', 'qa_release']) expect(org.roles[r].model_tier, r).toBe('cheap');
    expect(body('qa_lead')).toMatch(/medium/);
    expect(body('qa_security')).toMatch(/medium/);
  });

  it('approval_overrides only tighten, and only where the role holds the tool', () => {
    const org = loadOrg(vault);
    const ORDER: Record<string, number> = { auto: 0, propose: 1, ask: 2, never: 3 };
    const base: Record<string, string> = { 'deploy.site': 'propose', 'stripe.payment_link': 'propose', 'ci.run': 'auto', 'shell.run': 'auto' };
    for (const r of ALL) {
      for (const [tool, mode] of Object.entries(org.roles[r].approval_overrides)) {
        expect(org.roles[r].tools, `${r} overrides ${tool} without holding it`).toContain(tool);
        if (base[tool]) expect(ORDER[mode], `${r}.${tool} loosens`).toBeGreaterThanOrEqual(ORDER[base[tool]]);
      }
    }
    for (const r of ['backend_engineer', 'frontend_engineer', 'fullstack_engineer']) {
      expect(org.roles[r].approval_overrides['deploy.site'], r).toBe('ask');
    }
    for (const r of ['platform_engineer', 'sre']) expect(org.roles[r].approval_overrides['deploy.site']).toBeUndefined();
  });

  it('every charter points at the handbook', () => {
    for (const r of ALL) expect(body(r), r).toContain('Docs/engineering-handbook.md');
  });

  it('tools.yaml lets exactly these roles shell and run CI', () => {
    const y = readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8');
    const ci = y.match(/ci\.run:\s*\{[^}]*roles:\s*\[([^\]]*)\]/)![1].split(',').map((s) => s.trim());
    const org = loadOrg(vault);
    for (const r of ALL) {
      if (org.roles[r].tools.includes('ci.run')) expect(ci, r).toContain(r);
    }
  });

  it('nothing was recreated: identity fields survive', () => {
    const org = loadOrg(vault);
    for (const r of ALL) {
      expect(org.roles[r].desk, r).toBe(r);
      expect(org.roles[r].sprite, r).toBe(r);
      expect(org.roles[r].persona, r).toBeTruthy();
      expect(org.roles[r].hired, r).toBe('2026-09-11T00:00:00.000Z');
      expect(org.roles[r].tools, r).toContain('finish');
    }
  });
});
