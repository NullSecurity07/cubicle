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
    expect(rows).toHaveLength(8);
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
    expect(HEARTBEAT_WAKE_AREAS).toEqual(['Jobs', '00 Inbox', 'Brand', 'Roles', 'Teams']);
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
