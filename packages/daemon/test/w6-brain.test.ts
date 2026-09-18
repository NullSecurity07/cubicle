/**
 * The third dry-run's board-and-ideas defects (W6).
 *
 * Every case here is something the owner actually read on 2026-09-18: a card that never recorded the idea they
 * picked, a board that judged two different customers ten minutes apart, an audience segment filed as an idea,
 * frontmatter instructions beside the buttons that replaced them, and a founding document titled "Proposed
 * content".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createProposal, ownerDecide, readIdea, listIdeas, keptIdeas, BRAND_NAME_PATH } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools } from '@cubicle/tools';
import { vaultScheduler } from '@cubicle/harness';
import { dispatchProposals } from '../src/index.js';

const root = path.resolve(__dirname, '../../..');

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-w6-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const deps = () => ({
  vault,
  registry: new ToolRegistry().registerAll(phase3Tools({ includeMock: true })),
  toolsConfig: parseToolsConfig(readFileSync(path.join(root, 'config/tools.yaml'), 'utf8')),
  scheduler: vaultScheduler(vault, 'daemon'),
  env: {} as NodeJS.ProcessEnv,
});

/** The three the CEO filed after "surprise me", in the shape the dry-run's note had. */
const THREE = [
  '1. SponsorMatch — A curated directory matching indie newsletter creators with niche software sponsors.',
  '2. PageSpeedAudit — A free weekly performance audit for three landing pages, driving leads to a premium service.',
  '3. RemoteJunior — A hand-curated weekly newsletter showcasing entry-level remote developer roles.',
].join('\n');

describe('W6-5: the owner’s pick is kept, on the surprise path too', () => {
  it('files and keeps the card when the pick resolves, before any discovery job has run', async () => {
    const { id } = createProposal(vault, {
      kind: 'brand_change', from: 'ceo', target: BRAND_NAME_PATH, title: 'Three company ideas — pick one', body: THREE,
    }, 'ceo');
    ownerDecide(vault, id, { approved: true, chosen: 2 });

    expect(await dispatchProposals(deps())).toBe(1);

    expect(vault.readText(BRAND_NAME_PATH)).toContain('PageSpeedAudit');
    const card = readIdea(vault, 'pagespeedaudit')!;
    expect(card.data.decision).toBe('keep');
    expect(card.data.decided_by).toBe('owner');
    expect(card.data.decided_at).not.toBe('');
    expect(keptIdeas(vault).map((i) => i.id)).toEqual(['pagespeedaudit']);
    expect(vault.events.query({ types: ['guardrail.blocked'] })).toHaveLength(0);
  });

  it('is idempotent across a second dispatch: one card, one decision', async () => {
    const { id } = createProposal(vault, {
      kind: 'brand_change', from: 'ceo', target: BRAND_NAME_PATH, title: 'Three company ideas — pick one', body: THREE,
    }, 'ceo');
    ownerDecide(vault, id, { approved: true, chosen: 2 });
    await dispatchProposals(deps());
    const at = readIdea(vault, 'pagespeedaudit')!.data.decided_at;
    await dispatchProposals(deps());
    expect(listIdeas(vault).map((i) => i.id)).toEqual(['pagespeedaudit']);
    expect(readIdea(vault, 'pagespeedaudit')!.data.decided_at).toBe(at);
  });
});

