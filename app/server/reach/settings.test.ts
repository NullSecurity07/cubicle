import { mkdtempSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIES, createReach, newCode } from './settings.ts';

const where = () => mkdtempSync(join(tmpdir(), 'reach-set-'));

describe('what is kept about reaching the founder', () => {
  it('starts off, with nothing set up', async () => {
    const reach = createReach(where(), {});
    expect(await reach.read()).toEqual({ on: false, voice: false, cloudSpeech: false, paired: [], hooks: [] });
    expect(await reach.token()).toBeNull();
  });

  it('writes the file for this user alone, because everything in it is a key to something', async () => {
    const dir = where();
    const reach = createReach(dir, {});
    await reach.save((held) => { held.token = 'secret-bot-token'; held.on = true; });
    await reach.settled();
    expect(statSync(join(dir, 'reach.json')).mode & 0o777).toBe(0o600);
    expect(await readFile(join(dir, 'reach.json'), 'utf8')).toContain('secret-bot-token');
  });

  it('takes the token from the environment over the one that was pasted in', async () => {
    const dir = where();
    const reach = createReach(dir, { TELEGRAM_BOT_TOKEN: 'from-env' });
    await reach.save((held) => { held.token = 'pasted'; });
    await reach.settled();
    expect(await reach.token()).toBe('from-env');
    expect(reach.fromEnv()).toBe(true);
    expect(await createReach(dir, {}).token()).toBe('pasted');
  });

  it('reads back what was saved, from a new start', async () => {
    const dir = where();
    const first = createReach(dir, {});
    await first.save((held) => { held.paired = [{ chatId: 42, name: 'Phone', at: 1 }]; });
    await first.settled();
    const again = createReach(dir, {});
    expect(await again.paired(42)).toBe(true);
    expect(await again.paired(43)).toBe(false);
  });

  it('gives a code that is eight readable letters, good for an hour', () => {
    let now = 1_000_000;
    const reach = createReach(where(), {}, () => now);
    const code = reach.newPairing();
    expect(code.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(reach.pairing()?.code).toBe(code.code);
    now += 3_600_001;
    expect(reach.pairing()).toBeNull();
  });

  it('burns the code after five wrong tries, and a new one puts the old one out of use', () => {
    const reach = createReach(where(), {}, () => 0);
    reach.newPairing();
    for (let guess = 0; guess < TRIES; guess += 1) reach.missed();
    expect(reach.pairing()).toBeNull();
    const fresh = reach.newPairing();
    expect(reach.pairing()?.code).toBe(fresh.code);
    reach.clearPairing();
    expect(reach.pairing()).toBeNull();
  });

  it('makes a different code every time', () => {
    const codes = new Set(Array.from({ length: 50 }, () => newCode()));
    expect(codes.size).toBeGreaterThan(45);
  });
});
