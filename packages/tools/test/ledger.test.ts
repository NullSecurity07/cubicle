import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, readLedger, moneyReport, loadOrg, officeHolder, formatMoney, LEDGER_PATH, ledgerTemplate,
  RoleFrontmatter, type Vault, type CubicleEvent,
} from '@cubicle/core';
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
    const afterMock = moneyReport(readLedger(vault), new Date());
    expect(afterMock.cashCents).toBe(0);   // mock is not cash

    // A live entry actually moves cash, is never called "simulated", and lands with mode: 'live' in the row —
    // a handler that hardcoded 'mock' regardless of the argument would still pass every other test in this file.
    const live = await ledgerRecord.handler({ kind: 'cost', amount: '5.00', mode: 'live', why: 'A real card charge for hosting', ref: '' }, ctxFor('cfo'));
    expect(live.ok).toBe(true);
    expect(live.text).not.toContain('simulated');
    const liveEntry = readLedger(vault).entries[1];
    expect(liveEntry).toMatchObject({ kind: 'cost', cents: 500, mode: 'live', who: 'cfo' });
    const afterLive = moneyReport(readLedger(vault), new Date());
    expect(afterLive.cashCents).toBe(afterMock.cashCents - 500);
  });

  it('refuses capital by name, and says who may add it', async () => {
    // `capital` is in the schema on purpose: a model that tries it must read a sentence explaining why not,
    // rather than a zod enum error it cannot act on.
    const r = await ledgerRecord.handler({ kind: 'capital', amount: '250.00', mode: 'live', why: 'Funding ourselves from nowhere', ref: '' }, ctxFor('cfo'));
    expect(r.ok).toBe(false);
    expect(r.text).toContain('only the owner');
    expect(readLedger(vault).entries).toHaveLength(0);
  });

  it('refuses an amount it cannot represent, a zero amount, and an amount big enough to matter', async () => {
    const bad = await ledgerRecord.handler({ kind: 'cost', amount: '12.345', mode: 'live', why: 'x', ref: '' }, ctxFor('cfo'));
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('two decimal places');

    // A zero row is one nobody can act on — refused the same way an unparseable amount is.
    const zero = await ledgerRecord.handler({ kind: 'cost', amount: '0.00', mode: 'live', why: 'Nothing at all really happened here', ref: '' }, ctxFor('cfo'));
    expect(zero.ok).toBe(false);
    expect(zero.text).toContain('not an amount');

    const huge = await ledgerRecord.handler({ kind: 'cost', amount: '5000.00', mode: 'live', why: 'A year of hosting', ref: '' }, ctxFor('cfo'));
    expect(huge.ok).toBe(false);
    expect(huge.text).toContain('proposal.create');
    expect(MAX_AGENT_ENTRY_CENTS).toBe(100_000);
    expect(readLedger(vault).entries).toHaveLength(0);
  });

  it('accepts exactly the cap, and refuses one cent over it', async () => {
    const atCap = await ledgerRecord.handler({ kind: 'cost', amount: formatMoney(MAX_AGENT_ENTRY_CENTS), mode: 'live', why: 'Exactly at the one-entry cap for an agent', ref: '' }, ctxFor('cfo'));
    expect(atCap.ok).toBe(true);
    expect(readLedger(vault).entries).toHaveLength(1);

    const overCap = await ledgerRecord.handler({ kind: 'cost', amount: formatMoney(MAX_AGENT_ENTRY_CENTS + 1), mode: 'live', why: 'One cent over the one-entry cap', ref: '' }, ctxFor('cfo'));
    expect(overCap.ok).toBe(false);
    expect(overCap.text).toContain('proposal.create');
    expect(readLedger(vault).entries).toHaveLength(1);   // the over-cap attempt recorded nothing
  });

  it('reads an amount against the book\'s own currency, not a hardcoded default', async () => {
    vault.writeText(LEDGER_PATH, ledgerTemplate('GBP'), 'owner');
    // The tool's own schema tells the model "the currency is the ledger's own" — so in a GBP book, a model that
    // does as it is told and writes "GBP 5.00" must be accepted, not refused as if it had typed junk.
    const r = await ledgerRecord.handler({ kind: 'cost', amount: 'GBP 5.00', mode: 'live', why: 'A real card charge in the book\'s own currency', ref: '' }, ctxFor('cfo'));
    expect(r.ok).toBe(true);
    expect(r.text).toContain('GBP 5.00');
    expect(readLedger(vault).entries[0]).toMatchObject({ cents: 500, mode: 'live' });
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

  it('writing as the privileged actor still produces exactly one vault.wrote, and never reads back as an owner edit', async () => {
    const seen: CubicleEvent[] = [];
    const off = vault.events.on('vault.wrote', (e) => { if ((e.payload as { path?: string }).path === LEDGER_PATH) seen.push(e); });
    const r = await ledgerRecord.handler({ kind: 'cost', amount: '4.00', mode: 'live', why: 'One round of mock analytics for the team', ref: '' }, ctx('cfo', 'job_test'));
    off();
    expect(r.ok).toBe(true);
    // Exactly one vault.wrote for the book: the compare-and-write loop in appendEntry does not double-emit on
    // its happy path, and the daemon-actor write is not a raw fs write that would skip the event entirely (the
    // Ledger wake area in HEARTBEAT_WAKE_AREAS depends on this event existing at all, if it is ever added there).
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({ path: LEDGER_PATH, by: 'daemon' });
    // And the append does not read back as an owner edit — the watcher would otherwise wake the heartbeat on
    // the company's own bookkeeping.
    expect(vault.isOwnerChanged(LEDGER_PATH)).toBe(false);
  });
});

describe('the owner\'s never_modify veto still holds for the book (spec §7)', () => {
  it('refuses to record when the owner has named the ledger in never_modify, even though appendEntry writes as the privileged daemon actor', async () => {
    vault.writeText('Memory/constitution.md', '# Constitution\n\n```yaml\nnever_modify:\n  - Ledger/ledger.md\n```\n', 'owner');
    const r = await ledgerRecord.handler({ kind: 'cost', amount: '2.00', mode: 'live', why: 'A charge nobody should be able to book right now', ref: '' }, ctxFor('cfo'));
    expect(r.ok).toBe(false);
    expect(r.text).toContain('never_modify');
    expect(readLedger(vault).entries).toHaveLength(0);
  });
});
