import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault } from '@cubicle/core';
import { buildSnapshot } from '../src/ws.js';

describe('buildSnapshot teams', () => {
  it('passes room, floor and parent through from Teams/*.md', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-snap-'));
    const { vault } = await scaffoldVault(dir);
    try {
      vault.writeText('Teams/zz_test.md', '---\nid: zz_test\nname: Test team\nlead: ceo\nmembers: []\nmission: m\nroom: pantry\nfloor: 1\nparent: executive\n---\n# Test\n', 'daemon');
      const snap = buildSnapshot(vault);
      const t = snap.teams.find((x) => x.id === 'zz_test')!;
      expect(t).toMatchObject({ id: 'zz_test', name: 'Test team', lead: 'ceo', room: 'pantry', floor: 1, parent: 'executive' });
      expect(snap.offices?.chief_executive).toBe('ceo');
      expect(snap.offices?.operations).toBe('coo');
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
