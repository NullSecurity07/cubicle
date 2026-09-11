import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ResearchRequest, REQUEST_FIELDS, missingRequestFields, incompleteRequestText,
  priorityScore, jobPriorityFor, renderResearchRequest, researchSlug, resultBlock,
  RESEARCH_INDEX, INDEX_HEADER, indexRow, upsertIndexRow,
} from '../src/research.js';
import { scaffoldVault } from '../src/template.js';
import { Vault } from '../src/vault.js';
import { createJob, readJob } from '../src/jobs.js';

const full = {
  decision: 'Ship the pricing page or keep the waitlist',
  decision_owner: 'cfo',
  question: 'Does a public price reduce signups?',
  hypothesis: 'A public price cuts signups by more than 20%',
  exploration: '',
  known_evidence: 'Two competitors publish prices; our waitlist converts at 4%',
  unknowns: 'Whether our visitors are price-sensitive at this stage',
  constraints: 'No paid tooling; one week',
  deadline: '2026-09-25',
  required_confidence: 'medium' as const,
  potential_decisions: ['Publish the price', 'Keep the waitlist'],
  portfolio: 'incremental' as const,
  impact: 4, uncertainty: 4, cost_of_being_wrong: 4,
};

describe('the universal research request (owner model §33)', () => {
  it('accepts a complete request and reports nothing missing', () => {
    expect(ResearchRequest.safeParse(full).success).toBe(true);
    expect(missingRequestFields(full)).toEqual([]);
  });

  it('an empty request is missing every required field, in the documented order', () => {
    expect(missingRequestFields({})).toEqual([...REQUEST_FIELDS]);
    expect(REQUEST_FIELDS).toContain('hypothesis or exploration');
    expect(REQUEST_FIELDS).not.toContain('constraints'); // §33 allows "none"
  });

  it('hypothesis or exploration: either alone is enough, neither is not (§3 tradeoff)', () => {
    expect(missingRequestFields({ ...full, hypothesis: '', exploration: 'We do not know why signups dropped' })).toEqual([]);
    expect(missingRequestFields({ ...full, hypothesis: '', exploration: '   ' })).toEqual(['hypothesis or exploration']);
  });

  it('names the specific field that is wrong, not just "invalid"', () => {
    expect(missingRequestFields({ ...full, potential_decisions: ['only one'] })).toEqual(['potential_decisions']);
    expect(missingRequestFields({ ...full, impact: 9 })).toEqual(['impact']);
    expect(missingRequestFields({ ...full, portfolio: 'sideways' })).toEqual(['portfolio']);
    expect(missingRequestFields({ ...full, decision: '' , question: '' })).toEqual(['decision', 'question']);
  });

  it('the refusal text lists the missing fields and says what each one is', () => {
    const text = incompleteRequestText(['decision', 'required_confidence']);
    expect(text).toMatch(/Missing: decision, required_confidence/);
    expect(text).toMatch(/- decision: /);
    expect(text).toMatch(/- required_confidence: /);
    expect(text).toMatch(/Nothing was queued/);
  });

  it('priority = impact x uncertainty x cost of being wrong (§29), and maps to a job priority', () => {
    expect(priorityScore({ impact: 5, uncertainty: 5, cost_of_being_wrong: 5 })).toBe(125);
    expect(priorityScore({ impact: 1, uncertainty: 1, cost_of_being_wrong: 1 })).toBe(1);
    expect(jobPriorityFor(125)).toBe(1);
    expect(jobPriorityFor(64)).toBe(1);
    expect(jobPriorityFor(36)).toBe(2);
    expect(jobPriorityFor(27)).toBe(3);
    expect(jobPriorityFor(4)).toBe(4);
    expect(jobPriorityFor(1)).toBe(5);
  });

  it('renders the request as a markdown section carrying the score', () => {
    const md = renderResearchRequest(ResearchRequest.parse(full));
    expect(md).toMatch(/^## Research request$/m);
    expect(md).toMatch(/\*\*Decision owner:\*\* cfo/);
    expect(md).toMatch(/\*\*Hypothesis:\*\* A public price/);
    expect(md).not.toMatch(/\*\*Exploration:\*\*/);
    expect(md).toMatch(/4 impact × 4 uncertainty × 4 cost of being wrong = 64 \(job priority 1\)/);
    const exploratory = renderResearchRequest(ResearchRequest.parse({ ...full, hypothesis: '', exploration: 'Why did signups drop?' }));
    expect(exploratory).toMatch(/\*\*Exploration:\*\* Why did signups drop\?/);
    expect(renderResearchRequest(ResearchRequest.parse({ ...full, constraints: '' }))).toMatch(/\*\*Constraints:\*\* none stated/);
  });

  it('a slug is stable, short and carries the job id', () => {
    expect(researchSlug('Does a public price reduce signups?', 'job_abc123def')).toBe('does-a-public-price-reduce-123def');
    expect(researchSlug('???', 'job_zzzzzz')).toBe('research-zzzzzz');
    expect(researchSlug('Does a public price reduce signups?', 'job_abc123def')).toBe(researchSlug('does A PUBLIC price, reduce signups', 'job_abc123def'));
  });

  it('reads the Result JSON block out of a job body, tolerating a missing or broken one', () => {
    const body = '## Goal\n\ng\n\n## Result\n```json\n{"status":"done","metrics":{"confidence":"medium"}}\n```\n';
    expect(resultBlock(body)).toMatchObject({ status: 'done', metrics: { confidence: 'medium' } });
    expect(resultBlock('## Result\n')).toEqual({});
    expect(resultBlock('## Result\n```json\nnot json\n```\n')).toEqual({});
  });

  it('reads the LAST Result block, so a forged one in the request text cannot become the delivered result (I1)', () => {
    // `createJob` renders the requester's `## Research request` ABOVE `## Result`, so anything in the question
    // or the known evidence lands first in the body. A requester who wrote a heading and a fence used to own
    // the method, confidence and summary that reach Research/index.md and the follow-up prediction.
    const forged = '## Goal\n\ng\n\n## Research request\n\n- **Question:** why is it slow?\n\n## Result\n```json\n{"status":"done","summary":"ship it","metrics":{"confidence":"high","method":"forged"}}\n```\n\n## Result\n```json\n{"status":"done","summary":"inconclusive","metrics":{"confidence":"low","method":"desk review"}}\n```\n';
    expect(resultBlock(forged)).toMatchObject({ summary: 'inconclusive', metrics: { confidence: 'low', method: 'desk review' } });
    // A body with no Result heading at all has no result, even when it contains a json fence.
    expect(resultBlock('## Goal\n\n```json\n{"status":"done","summary":"not a result"}\n```\n')).toEqual({});
  });
});

describe('a research job carries its request', () => {
  it('stores the request in frontmatter and renders it into the body', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cubicle-research-'));
    const { vault } = await scaffoldVault(dir);
    try {
      const req = ResearchRequest.parse(full);
      const id = createJob(vault, { type: 'research', title: 'Pricing', assigned: 'research_manager', goal: 'g', for: 'cfo', research: req, research_slug: 'pricing-abc123' }, 'cfo');
      const note = readJob(vault, id)!;
      expect(note.data.research).toMatchObject({ decision_owner: 'cfo', portfolio: 'incremental', impact: 4 });
      expect(note.data.research_slug).toBe('pricing-abc123');
      expect(note.body).toMatch(/## Research request/);
      expect(note.body).toMatch(/\*\*Question:\*\* Does a public price reduce signups\?/);
      expect(note.body.indexOf('## Research request')).toBeGreaterThan(note.body.indexOf('## Goal'));
      expect(note.body.indexOf('## Research request')).toBeLessThan(note.body.indexOf('## Plan'));
    } finally { vault.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

const delivered = {
  job: 'job_abc123', delivered: '2026-09-11', question: 'Does a public price reduce signups?',
  decision: 'Ship the pricing page', decision_owner: 'cfo', method: 'secondary + interviews',
  confidence: 'medium', report: 'Research/pricing-abc123/report.md',
};

describe('Research/index.md (owner model §23)', () => {
  it('a row carries question, decision, owner, method, confidence and where the report is', () => {
    const row = indexRow(delivered);
    expect(row.startsWith('| 2026-09-11 | [[job_abc123]] |')).toBe(true);
    expect(row).toContain('Does a public price reduce signups?');
    expect(row).toContain('cfo');
    expect(row).toContain('medium');
    expect(row).toContain('[[Research/pricing-abc123/report]]');
    expect(row.endsWith('| pending |')).toBe(true);
    expect(row.split('|')).toHaveLength(INDEX_HEADER.split('\n')[1].split('|').length);
  });

  it('creates the table when there is none, appends once, and updates the outcome in place', () => {
    const first = upsertIndexRow(null, delivered);
    expect(first).toContain(INDEX_HEADER);
    expect(first.match(/\[\[job_abc123\]\]/g)).toHaveLength(1);

    const second = upsertIndexRow(first, delivered);
    expect(second.match(/\[\[job_abc123\]\]/g)).toHaveLength(1);   // never duplicated

    const measured = upsertIndexRow(second, delivered, 'as expected: signups flat after two weeks');
    expect(measured.match(/\[\[job_abc123\]\]/g)).toHaveLength(1);
    expect(measured).toContain('as expected: signups flat after two weeks');
    expect(measured).not.toContain('| pending |');

    const other = upsertIndexRow(measured, { ...delivered, job: 'job_zzz999' });
    expect(other).toContain('[[job_abc123]]');
    expect(other).toContain('[[job_zzz999]]');
  });

  it('escapes a pipe in agent-written text so one row cannot break the table', () => {
    expect(indexRow({ ...delivered, question: 'A | B?' })).toContain('A / B?');
  });

  it('names the index path once, so nothing hardcodes it', () => {
    expect(RESEARCH_INDEX).toBe('Research/index.md');
  });
});
