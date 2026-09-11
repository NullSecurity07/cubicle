import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, readLedger, moneyReport, loadOrg, officeHolder, RoleFrontmatter, type Vault } from '@cubicle/core';
import { parseToolsConfig, vaultWrite, type ToolContext } from '../src/index.js';
import { ledgerRecord, MAX_AGENT_ENTRY_CENTS } from '../src/tools/ledger.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string;
let vault: Vault;
const role = (id: string) => RoleFrontmatter.parse(vault.readNoteOrNull(`Roles/${id}.md`)!.data);
const ctxFor = (roleId: string): ToolContext => ({
  vault, events: vault.events, roleId,
  role: role(roleId),
  jobId: 'job_test', config: cfg, env: {}, workspace: '.cubicle/workspace/job_test',
  now: () => new Date('2026-09-12T10:00:00.000Z'),
  scheduler: { enqueue: () => 'job_x' },
} as ToolContext);
// Same shape as research-tools.test.ts's `ctx(roleId, jobId)`, for the vault.write refusal test below.
const ctx = (roleId: string, jobId: string | null): ToolContext => ({
  vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: {},
  workspace: `.cubicle/workspace/${jobId ?? 'x'}`,
  now: () => new Date('2026-09-12T10:00:00.000Z'),
  scheduler: { enqueue: () => 'job_x' },
} as ToolContext);

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-ledger-tool-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('ledger.record (spec §1, §7)', () => {
  it('records revenue and cost, and says what the position is afterwards', async () => {
    const r = await ledgerRecord.handler({ kind: 'revenue', amount: '40.00', mode: 'mock', why: 'Nursery order on the mock link', ref: '' }, ctxFor('cso'));
    expect(r.ok).toBe(true);
    expect(r.text).toContain('USD 40.00');
    expect(r.text).toContain('simulated');
    const entry = readLedger(vault).entries[0];
    expect(entry).toMatchObject({ kind: 'revenue', cents: 4000, mode: 'mock', who: 'cso' });
    expect(entry.why).toContain('Nursery order');
    expect(moneyReport(readLedger(vault), new Date()).cashCents).toBe(0);   // mock is not cash
  });

  it('refuses capital by name, and says who may add it', async () => {
    // `capital` is in the schema on purpose: a model that tries it must read a sentence explaining why not,
    // rather than a zod enum error it cannot act on.
    const r = await ledgerRecord.handler({ kind: 'capital', amount: '250.00', mode: 'live', why: 'Funding ourselves from nowhere', ref: '' }, ctxFor('cfo'));
    expect(r.ok).toBe(false);
    expect(r.text).toContain('only the owner');
    expect(readLedger(vault).entries).toHaveLength(0);
  });

  it('refuses an amount it cannot represent, and an amount big enough to matter', async () => {
    const bad = await ledgerRecord.handler({ kind: 'cost', amount: '12.345', mode: 'live', why: 'x', ref: '' }, ctxFor('cfo'));
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('two decimal places');
    const huge = await ledgerRecord.handler({ kind: 'cost', amount: '5000.00', mode: 'live', why: 'A year of hosting', ref: '' }, ctxFor('cfo'));
    expect(huge.ok).toBe(false);
    expect(huge.text).toContain('proposal.create');
    expect(MAX_AGENT_ENTRY_CENTS).toBe(100_000);
    expect(readLedger(vault).entries).toHaveLength(0);
  });

  it('refuses a `why` that explains nothing', async () => {
    const r = await ledgerRecord.handler({ kind: 'cost', amount: '1.00', mode: 'live', why: 'x', ref: '' }, ctxFor('cfo'));
    expect(r.ok).toBe(false);
    expect(r.text).toContain('one sentence');
  });

  it('is idempotent on a ref, so a retried job does not charge twice', async () => {
    const args = { kind: 'cost' as const, amount: '3.00', mode: 'live' as const, why: 'One month of the mock analytics plan', ref: 'job_test:analytics' };
    const a = await ledgerRecord.handler(args, ctxFor('cfo'));
    const b = await ledgerRecord.handler(args, ctxFor('cfo'));
    expect(a.ok && b.ok).toBe(true);
    expect(b.text).toContain('already in the book');
    expect(readLedger(vault).entries).toHaveLength(1);
  });
});

describe('Ledger/ is owner-owned for agent vault writes (spec §7)', () => {
  it('refuses vault.write to Ledger/ledger.md outright, naming the finance office, while ledger.record still appends', async () => {
    const holder = officeHolder(loadOrg(vault), 'finance');
    const w = await vaultWrite.handler({ path: 'Ledger/ledger.md', content: 'whatever an agent likes' }, ctx('cfo', 'job_test'));
    expect(w.ok).toBe(false);
    expect(w.text).toContain(holder);
    expect(w.text).toContain('ledger.record');
    expect(readLedger(vault).entries).toEqual([]);

    const r = await ledgerRecord.handler({ kind: 'cost', amount: '2.00', mode: 'live', why: 'One coffee for the office', ref: '' }, ctx('cfo', 'job_test'));
    expect(r.ok).toBe(true);
    expect(readLedger(vault).entries).toHaveLength(1);
  });
});
