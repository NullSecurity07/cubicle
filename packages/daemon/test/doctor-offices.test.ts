import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, loadOrg, HEARTBEAT_WAKE_AREAS } from '@cubicle/core';
import { officeRows } from '../src/index.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-doctor-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('cubicle doctor reads the office map (spec item 5)', () => {
  it('every office in the shipped vault resolves to an active role', () => {
    const rows = officeRows(loadOrg(vault));
    expect(rows.filter((r) => r.item.startsWith('office '))).toHaveLength(8);
    expect(rows.every((r) => r.ok === true)).toBe(true);
    expect(rows.find((r) => r.item === 'office engineering')!.detail).toBe('cto');
  });

  it('an office whose role is missing or inactive is reported with the fix', () => {
    const org = loadOrg(vault);
    const gone = { ...org, roles: Object.fromEntries(Object.entries(org.roles).filter(([r]) => r !== 'clo')) };
    const row = officeRows(gone).find((r) => r.item === 'office compliance')!;
    expect(row.ok).toBe(false);
    expect(row.detail).toContain('clo');
    expect(row.fix).toContain('Memory/constitution.md');
  });

  it('Teams edits wake the heartbeat', () => {
    expect(HEARTBEAT_WAKE_AREAS).toEqual(expect.arrayContaining(['Jobs', '00 Inbox', 'Brand', 'Roles', 'Teams', 'Discovery', 'Ideas']));
  });

  // Two mapping gaps the per-office rows cannot see: a key that is not an office at all (merged into the map at
  // org.ts and then never looked up, so a typo is silently inert), and a tree with no division left to plan.
  it('a key under `offices:` that is not an office is reported, with the real list as the fix', () => {
    const shipped = officeRows(loadOrg(vault)).find((r) => r.item === 'offices: keys')!;
    expect(shipped.ok).toBe(true);
    expect(shipped.detail).toContain('known offices');
    const c = vault.readText('Memory/constitution.md');
    vault.writeText('Memory/constitution.md', c.replace(/^  security: \w+$/m, '  securty: ciso'), 'owner');
    const row = officeRows(loadOrg(vault)).find((r) => r.item === 'offices: keys')!;
    expect(row.ok).toBe(false);
    expect(row.detail).toContain('securty');
    expect(row.fix).toContain('compliance');
  });

  it('a tree where no team holds a planning round is reported: the heartbeat would fan out nothing, for ever', () => {
    const org = loadOrg(vault);
    const shipped = officeRows(org).find((r) => r.item === 'planning rounds')!;
    expect(shipped.ok).toBe(true);
    expect(shipped.detail).toContain('technology (lead cto)');
    // An owner edit that strips every `parent:` leaves no team with a room under it, so `divisionTeams` is empty.
    const flat = { ...org, teams: Object.fromEntries(Object.entries(org.teams).map(([id, t]) => [id, { ...t, parent: undefined }])) };
    const row = officeRows(flat).find((r) => r.item === 'planning rounds')!;
    expect(row.ok).toBe(false);
    expect(row.detail).toContain('no team holds a planning round');
    expect(row.fix).toContain('parent:');
  });

  it('an office absent from the map resolves through the default and the row names the real role', () => {
    const c = vault.readText('Memory/constitution.md');
    vault.writeText('Memory/constitution.md', c.replace(/^  engineering: \w+\n/m, ''), 'owner');
    const eng = officeRows(loadOrg(vault)).find((r) => r.item === 'office engineering')!;
    expect(eng.ok).toBe(true);
    expect(eng.detail).not.toMatch(/unset/);
    expect(eng.detail).toMatch(/cto/);
  });
});
