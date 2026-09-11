import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';

let dir: string; let vault: Vault;
beforeAll(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-tpldocs-')); vault = (await scaffoldVault(dir)).vault; });
afterAll(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const read = (rel: string) => readFileSync(path.join(dir, rel), 'utf8');
const lines = (rel: string) => read(rel).split('\n').length;

describe('Docs/engineering-handbook.md', () => {
  it('is a condensation an agent can hold, not the whole document', () => {
    expect(lines('Docs/engineering-handbook.md')).toBeGreaterThan(110);
    expect(lines('Docs/engineering-handbook.md')).toBeLessThan(190);
  });

  it('covers every part of the operating model the division runs on', () => {
    const h = read('Docs/engineering-handbook.md');
    for (const topic of ['Kanban', 'WIP', 'Trunk-based', 'CI', 'Feature flags', 'canary', 'risk', 'Incidents', 'error budget', 'ADR', 'Lead time', 'decision']) {
      expect(h, topic).toContain(topic);
    }
  });

  it('cites the owner document sections, so a rule can be checked against its source', () => {
    const h = read('Docs/engineering-handbook.md');
    for (const s of ['§7', '§16', '§17', '§18', '§20', '§21', '§26', '§27', '§31', '§33', '§34', '§35']) expect(h, s).toContain(s);
  });

  it('names the tools that enforce each rule, so a rule is actionable rather than aspirational', () => {
    const h = read('Docs/engineering-handbook.md');
    for (const t of ['ci.run', 'adr.create', 'deploy.site', 'scheduler.request', 'Streams/', 'Workspace/']) expect(h, t).toContain(t);
  });
});

describe('Docs/tech-radar.md', () => {
  it('is the reference stack plus the ten selection criteria, in an agent-sized document', () => {
    const r = read('Docs/tech-radar.md');
    expect(lines('Docs/tech-radar.md')).toBeGreaterThan(110);
    expect(lines('Docs/tech-radar.md')).toBeLessThan(190);
    expect(r).toContain('## Adopt');
    expect(r).toContain('## Trial');
    expect(r).toContain('## Hold');
  });

  it('carries the reference stack from the toolchain document §3', () => {
    const r = read('Docs/tech-radar.md');
    for (const tool of ['PostgreSQL', 'Forgejo', 'Woodpecker', 'OpenTofu', 'Caddy', 'Docker', 'Prometheus', 'Grafana', 'Restic', 'Valkey', 'NATS', 'OpenTelemetry', 'Semgrep', 'Trivy', 'Gitleaks', 'Renovate']) {
      expect(r, tool).toContain(tool);
    }
  });

  it('carries all ten selection criteria as questions, numbered', () => {
    const r = read('Docs/tech-radar.md');
    for (let i = 1; i <= 10; i++) expect(r, `criterion ${i}`).toMatch(new RegExp(`^${i}\\. `, 'm'));
    expect(r).toContain('§53');
    expect(r).toContain('§54');
    expect(r).toMatch(/migration strategy/i);
  });

  it('says what the minimum stack is and that the company itself runs vault-native for now', () => {
    const r = read('Docs/tech-radar.md');
    expect(r).toMatch(/Minimum Viable Company Stack|minimum stack/i);
    expect(r).toContain('config/integrations.yaml');
  });
});

describe('Docs/money-handbook.md', () => {
  it('covers every rule an agent can get wrong about money', () => {
    const h = read('Docs/money-handbook.md');
    for (const topic of ['append-only', 'mock', 'capital', 'ledger.record', 'runway', 'model quota', 'cheapest tier', 'dormant']) {
      expect(h, topic).toContain(topic);
    }
  });

  it('says plainly that an unfunded company is not a broken one', () => {
    // The single most likely misreading, and the one that would have an agent filing alarmed proposals about a
    // company that is working exactly as designed.
    const h = read('Docs/money-handbook.md');
    expect(h).toContain('not** dormant');
    expect(h).toContain('normal state');
  });

  it('tells the CFO never to calculate a figure, in the charter as well as the handbook', () => {
    const c = read('Roles/cfo.md');
    expect(c).toContain('Never calculate cash, burn or runway');
    // The new clause added beside the pre-existing willingness-to-pay rule, not in place of it: this checks the
    // standing-rule sentence itself, not just that `ledger.record` appears somewhere (it also appears in `tools:`).
    expect(c).toContain('Record money with `ledger.record`');
    expect(c).toContain('Ask Research for a willingness-to-pay read before changing a price.');
  });
});
