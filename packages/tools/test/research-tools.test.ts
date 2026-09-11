import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, createJob, readJob, RoleFrontmatter, ResearchRequest } from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools, researchProjectFiles, type ToolContext } from '../src/index.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string; let vault: Vault; let reg: ToolRegistry;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-rtools-')); vault = (await scaffoldVault(dir)).vault; reg = new ToolRegistry().registerAll(phase3Tools()); });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

const role = (id: string) => RoleFrontmatter.parse(vault.readNoteOrNull(`Roles/${id}.md`)!.data);
const ctx = (roleId: string, jobId: string | null): ToolContext => ({ vault, events: vault.events, roleId, role: role(roleId), jobId, config: cfg, env: {}, workspace: `.cubicle/workspace/${jobId ?? 'x'}`, now: () => new Date('2026-09-11T09:00:00.000Z'), scheduler: { enqueue: (j) => createJob(vault, j, roleId) } });
const call = (tool: string, roleId: string, jobId: string | null, args: Record<string, unknown>) => reg.get(tool)!.handler(args as never, ctx(roleId, jobId));

const request = ResearchRequest.parse({
  decision: 'Ship the pricing page or keep the waitlist',
  decision_owner: 'cfo',
  question: 'Does a public price reduce signups?',
  hypothesis: 'A public price cuts signups by more than 20%',
  known_evidence: 'Two competitors publish prices',
  unknowns: 'Whether our visitors are price-sensitive',
  constraints: 'No paid tooling',
  deadline: '2026-09-25',
  required_confidence: 'medium',
  potential_decisions: ['Publish the price', 'Keep the waitlist'],
  portfolio: 'incremental',
  impact: 4, uncertainty: 4, cost_of_being_wrong: 4,
});

describe('researchProjectFiles (owner tool stack §63/§64)', () => {
  it('produces the predictable directory, with the stopping criterion and the universal output headings', () => {
    const files = researchProjectFiles({ slug: 'pricing-abc123', jobId: 'job_abc123', title: 'Pricing', request, today: '2026-09-11' });
    const names = files.map((f) => f.path);
    expect(names).toEqual([
      'Research/pricing-abc123/README.md',
      'Research/pricing-abc123/question.md',
      'Research/pricing-abc123/protocol.md',
      'Research/pricing-abc123/sources.bib',
      'Research/pricing-abc123/evidence/.gitkeep',
      'Research/pricing-abc123/analysis/.gitkeep',
      'Research/pricing-abc123/results/.gitkeep',
      'Research/pricing-abc123/report.md',
    ]);
    const by = (n: string) => files.find((f) => f.path.endsWith(n))!.content;
    expect(by('protocol.md')).toMatch(/^## Stopping criteria$/m);
    expect(by('protocol.md')).toMatch(/medium confidence/);
    expect(by('protocol.md')).toMatch(/would additional research materially change the decision/i);
    for (const h of ['Executive summary', 'Decision required', 'Contradictory evidence', 'Limitations', 'Confidence', 'Follow-up measurements']) {
      expect(by('report.md'), h).toMatch(new RegExp(`^## ${h}$`, 'm'));
    }
    expect(by('report.md')).toMatch(/confidence: unstated/);
    expect(by('question.md')).toMatch(/Does a public price reduce signups\?/);
    expect(by('README.md')).toMatch(/\[\[job_abc123\]\]/);
    expect(by('sources.bib')).toMatch(/^% Sources for Pricing/m);
  });

  it('works without a request, saying so instead of inventing one', () => {
    const files = researchProjectFiles({ slug: 's', jobId: 'job_x', title: 'Postmortem', request: null, today: '2026-09-11' });
    const q = files.find((f) => f.path.endsWith('question.md'))!.content;
    expect(q).toMatch(/no research request/i);
    expect(q).toMatch(/Postmortem/);
  });
});

describe('research.start', () => {
  it('creates the directory once, records the slug on the job, and is idempotent', async () => {
    const id = createJob(vault, { type: 'research', title: 'Pricing', assigned: 'research_manager', goal: 'g', for: 'cfo', research: request }, 'cfo');
    const r = await call('research.start', 'research_manager', id, {});
    expect(r.ok).toBe(true);
    const slug = (r.data as { slug: string }).slug;
    expect(slug).toMatch(/^does-a-public-price-reduce-/);
    expect(vault.exists(`Research/${slug}/report.md`)).toBe(true);
    expect(vault.exists(`Research/${slug}/evidence/.gitkeep`)).toBe(true);
    expect(readJob(vault, id)!.data.research_slug).toBe(slug);
    expect(r.text).toMatch(/protocol\.md/);

    // an agent's own work is never clobbered by a second call
    vault.writeText(`Research/${slug}/report.md`, 'my findings so far\n', 'research_manager');
    const again = await call('research.start', 'research_manager', id, {});
    expect(again.ok).toBe(true);
    expect((again.data as { created: string[] }).created).toEqual([]);
    expect(vault.readText(`Research/${slug}/report.md`)).toBe('my findings so far\n');
  });

  it('refuses outside a job, and accepts an explicit slug', async () => {
    expect((await call('research.start', 'research_manager', null, {})).ok).toBe(false);
    const id = createJob(vault, { type: 'custom', title: 'Ad hoc look', assigned: 'researcher', goal: 'g' }, 'research_manager');
    const r = await call('research.start', 'researcher', id, { slug: 'Ad Hoc Look!' });
    expect(r.ok).toBe(true);
    expect((r.data as { slug: string }).slug).toBe('ad-hoc-look');
    expect(vault.exists('Research/ad-hoc-look/question.md')).toBe(true);
  });
});
