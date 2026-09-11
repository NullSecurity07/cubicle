import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, RoleFrontmatter, parseNote, createJob, loadGates, criteriaFor } from '@cubicle/core';
import { parseToolsConfig, adrCreate, listAdrs, nextAdrNumber, adrPath, ToolRegistry, phase3Tools, type ToolContext } from '../src/index.js';

const root = path.resolve(__dirname, '../../..');
const cfg = parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-adr-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function ctxFor(roleId = 'dev_manager'): ToolContext {
  const role = RoleFrontmatter.parse(parseNote(vault.readText(`Roles/${roleId}.md`)).data);
  return { vault, events: vault.events, roleId, role, jobId: 'job_a', config: cfg, env: {}, workspace: '.cubicle/workspace/job_a', now: () => new Date(), scheduler: { enqueue: (j) => createJob(vault, j, roleId) } };
}

const adr = (over: Record<string, unknown> = {}) => ({
  title: 'Use PostgreSQL for the checkout store',
  context: 'Orders need transactions across three tables and the reporting query joins all of them.',
  decision: 'Use one PostgreSQL instance for the checkout stream.',
  alternatives: ['SQLite — no concurrent writers under the expected load', 'A document store — the reporting join would be done in the application'],
  consequences: 'One more thing to back up; Restic takes the dump nightly. The team learns one database, not two.',
  status: 'accepted' as const, ...over,
});

describe('adr.create (toolchain document §8)', () => {
  it('numbers ADRs from 1 and keeps the number in the filename and the id', async () => {
    expect(nextAdrNumber(vault)).toBe(1);
    const r = await adrCreate.handler(adr(), ctxFor());
    expect(r.ok).toBe(true);
    expect((r.data as { path: string }).path).toBe('Docs/adr/ADR-0001-use-postgresql-for-the-checkout-store.md');
    expect(adrPath(2, 'Use NATS')).toBe('Docs/adr/ADR-0002-use-nats.md');
    expect(nextAdrNumber(vault)).toBe(2);
  });

  it('writes the six sections the document names: context, decision, alternatives, consequences, date, owner', async () => {
    await adrCreate.handler(adr(), ctxFor());
    const note = parseNote(vault.readText('Docs/adr/ADR-0001-use-postgresql-for-the-checkout-store.md'));
    expect(note.data).toMatchObject({ id: 'ADR-0001', status: 'accepted', owner: 'dev_manager' });
    expect(String(note.data.date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const h of ['## Context', '## Decision', '## Alternatives', '## Consequences']) expect(note.body).toContain(h);
    expect(note.body).toContain('SQLite');
  });

  it('refuses an ADR with no alternatives — that is the half organisations forget', async () => {
    const r = await adrCreate.handler(adr({ alternatives: [] }), ctxFor());
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/alternative/i);
  });

  it('listAdrs returns what QA needs to check a ship against', async () => {
    await adrCreate.handler(adr(), ctxFor());
    await adrCreate.handler(adr({ title: 'Keep the monolith modular' }), ctxFor());
    const list = listAdrs(vault);
    expect(list.map((a) => a.id)).toEqual(['ADR-0001', 'ADR-0002']);
    expect(list[1].title).toBe('Keep the monolith modular');
    expect(list[0].path).toMatch(/^Docs\/adr\//);
  });

  it('_template.md is a template, never an ADR', () => {
    expect(vault.exists('Docs/adr/_template.md')).toBe(true);
    expect(listAdrs(vault)).toEqual([]);
    expect(nextAdrNumber(vault)).toBe(1);
  });

  it('is registered and reaches the dev manager', () => {
    const reg = new ToolRegistry().registerAll(phase3Tools());
    expect(reg.names()).toContain('adr.create');
    const role = RoleFrontmatter.parse(parseNote(vault.readText('Roles/dev_manager.md')).data);
    expect(reg.forRole({ ...role, tools: ['adr.create'] }, cfg).map((t) => t.name)).toEqual(['adr.create']);
  });
});

describe('the QA gate knows about ADRs', () => {
  it('qa.review criteria requires an ADR for an architecture change', () => {
    const c = criteriaFor(loadGates(path.join(root, 'config/gates.yaml')), 'qa.review');
    expect(c).toMatch(/ADR/);
    expect(c).toMatch(/Docs\/adr/);
  });
});

describe('the postmortem template', () => {
  it('exists with the sections §33 names', () => {
    const t = readFileSync(path.join(dir, 'Docs/postmortems/_template.md'), 'utf8');
    for (const h of ['## Timeline', '## Impact', '## Root cause', '## Corrective actions', '## What we learned']) expect(t).toContain(h);
    expect(t).toMatch(/blameless/i);
  });
});
