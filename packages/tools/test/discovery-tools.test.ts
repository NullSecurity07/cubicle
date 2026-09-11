import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, RoleFrontmatter, readIdea, DISCOVERY_INBOX, INTERVIEW_PATH,
  renderInterviewAsked, closeInterview, loadOrg,
} from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools, type ToolContext } from '../src/index.js';
import { discoveryInputs, ideaCard, fairShare, inOffice } from '../src/tools/discovery.js';

const cfg = parseToolsConfig(readFileSync(path.resolve(__dirname, '../../../config/tools.yaml'), 'utf8'));
let dir: string;
let vault: Vault;
const role = (id: string) => RoleFrontmatter.parse(vault.readNoteOrNull(`Roles/${id}.md`)!.data);
// Same shape as research-tools.test.ts's helper, real parsed config included: only jobId is pinned, since
// these two tools never schedule.
const ctx = (roleId: string): ToolContext => ({
  vault, events: vault.events, roleId, role: role(roleId), jobId: 'job_d1', config: cfg, env: {},
  workspace: '.cubicle/workspace/job_d1', now: () => new Date('2026-09-11T10:00:00.000Z'),
  scheduler: { enqueue: () => 'job_x' },
} as ToolContext);

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'cubicle-sp3-tools-'));
  vault = (await scaffoldVault(dir)).vault;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

describe('fairShare', () => {
  it('never truncates a short file to make room for a long one', () => {
    expect(fairShare([10, 10, 10], 100)).toEqual([10, 10, 10]);
    expect(fairShare([5, 5, 1000], 90)).toEqual([5, 5, 80]);
    expect(fairShare([], 100)).toEqual([]);
    expect(fairShare([1000, 1000], 100)).toEqual([50, 50]);
    expect(fairShare([1000], 0)).toEqual([0]);
  });

  it('never hands out more than the budget', () => {
    const sizes = [3, 7, 900, 40, 1];
    expect(fairShare(sizes, 200).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(200);
    fairShare(sizes, 200).forEach((take, i) => expect(take).toBeLessThanOrEqual(sizes[i]));
  });
});

describe('discovery.inputs (spec §1)', () => {
  it('returns the files, the interview and the cabin messages in one call', async () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We sell meal kits to nurseries.', 'owner');
    vault.writeText(`${DISCOVERY_INBOX}/deck.pdf`, '%PDF', 'owner');
    vault.writeText(INTERVIEW_PATH, closeInterview(renderInterviewAsked('2026-09-11T09:00:00.000Z'), 'Two nurseries already pay us.'), 'ceo');
    vault.writeText('00 Inbox/2026-09-11-1000-message-abc.md', '---\nid: msg_1\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-11T10:00:00.000Z\n---\n# Meal kits\n\nMeal kits for nurseries.\n\n## CEO\n\nGot it.\n', 'owner');
    const r = await discoveryInputs.handler({ max_chars: 60000 }, ctx('research_manager'));
    expect(r.ok).toBe(true);
    expect(r.text).toContain('We sell meal kits to nurseries.');
    expect(r.text).toContain('Two nurseries already pay us.');
    expect(r.text).toContain('Meal kits for nurseries.');
    expect(r.text).not.toContain('Got it.');                       // the CEO's own reply is not owner material
    expect(r.text).toContain('Present but unreadable');
    expect(r.text).toContain('deck.pdf');
    const d = r.data as { sources: string[]; interview: string; long_prompt: boolean; messages: number };
    expect(d.sources).toContain(`${DISCOVERY_INBOX}/pitch.md`);
    expect(d.sources).toContain(INTERVIEW_PATH);
    expect(d.interview).toBe('answered');
    expect(d.messages).toBe(1);
    expect(d.long_prompt).toBe(false);
  });

  it('says plainly when there is nothing, and when the owner skipped', async () => {
    vault.writeText(INTERVIEW_PATH, closeInterview(renderInterviewAsked('2026-09-11T09:00:00.000Z'), 'skip'), 'ceo');
    const r = await discoveryInputs.handler({ max_chars: 60000 }, ctx('research_manager'));
    expect(r.text).toContain('skipped the interview');
    expect(r.text).toContain('## What the owner has typed in the cabin\n_Nothing._');
    expect((r.data as { sources: string[] }).sources).toEqual([]);
  });

  it('marks a truncation rather than hiding it', async () => {
    vault.writeText(`${DISCOVERY_INBOX}/long.md`, 'x'.repeat(5000), 'owner');
    const r = await discoveryInputs.handler({ max_chars: 1000 }, ctx('research_manager'));
    expect(r.text).toContain('truncated: 4000 more characters');
  });

  // Review T4 finding 3: the interview and the owner's messages used to be appended whole, unbounded by
  // max_chars, and silently clipped later by the harness — the two things a founder brief is written from were
  // the first to disappear. Now every part shares the one budget and every cut is marked.
  it('shares max_chars across the inbox files, the interview and every message, and marks every cut', async () => {
    vault.writeText(`${DISCOVERY_INBOX}/a.md`, 'a'.repeat(2000), 'owner');
    vault.writeText(INTERVIEW_PATH, closeInterview(renderInterviewAsked('2026-09-11T09:00:00.000Z'), 'i'.repeat(2000)), 'ceo');
    for (let n = 0; n < 5; n++) {
      vault.writeText(`00 Inbox/2026-09-11-100${n}-message-${n}.md`, `---\nid: msg_${n}\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-11T10:0${n}:00.000Z\n---\n# Update\n\n${'m'.repeat(2000)}\n`, 'owner');
    }
    const r = await discoveryInputs.handler({ max_chars: 1000 }, ctx('research_manager'));
    expect(r.ok).toBe(true);
    expect(r.text.length).toBeLessThan(4000);                       // nowhere near the ~14000 raw characters
    expect((r.text.match(/truncated:/g) ?? []).length).toBeGreaterThan(1);   // more than one part was cut, and each cut is marked
  });

  it('keeps a multi-line owner message intact rather than breaking it out of a list (finding 9)', async () => {
    vault.writeText('00 Inbox/2026-09-11-1000-message-ml.md', '---\nid: msg_ml\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-11T10:00:00.000Z\n---\n# Update\n\nLine one.\nLine two.\n', 'owner');
    const r = await discoveryInputs.handler({ max_chars: 60000 }, ctx('research_manager'));
    expect(r.text).toContain('Line one.\nLine two.');
  });

  it('says "nothing readable", not "nothing in", when something unreadable is present (finding 5)', async () => {
    vault.writeText(`${DISCOVERY_INBOX}/deck.pdf`, '%PDF', 'owner');
    const r = await discoveryInputs.handler({ max_chars: 60000 }, ctx('research_manager'));
    expect(r.text).not.toContain('The owner dropped nothing in.');
    expect(r.text).toContain('Present but unreadable');
  });
});

describe('idea.card (spec §2.5)', () => {
  it('lets the research office fill its half and nobody else', async () => {
    const org = loadOrg(vault);
    expect(inOffice(org, 'researcher', 'research')).toBe(true);
    expect(inOffice(org, 'ceo', 'research')).toBe(true);
    expect(inOffice(org, 'backend_engineer', 'research')).toBe(false);
    const refused = await ideaCard.handler({ title: 'Meal kits', evidence: [], research: { report: 'Research/x/report.md', confidence: 'medium', summary: 's', evidence: 4, fit: 3 } }, ctx('backend_engineer'));
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('research_manager');
    expect(vault.exists('Ideas/meal-kits.md')).toBe(false);        // a refused call writes nothing
  });

  it('lets the finance office fill its half and nobody else', async () => {
    const org = loadOrg(vault);
    expect(inOffice(org, 'cmo', 'finance')).toBe(true);
    expect(inOffice(org, 'researcher', 'finance')).toBe(false);
    const refused = await ideaCard.handler({ title: 'Meal kits', evidence: [], estimate: { text: 'two weeks', value: 4, effort: 4 } }, ctx('researcher'));
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('cfo');
  });

  it('files a card, then scores it once both offices have answered', async () => {
    const first = await ideaCard.handler({
      title: 'Meal kits for nurseries', evidence: [`${DISCOVERY_INBOX}/pitch.md`], what_changed: 'Two nurseries already pay.',
      research: { report: 'Research/meal-kits/report.md', confidence: 'medium', summary: 'Two nurseries already pay a competitor.', evidence: 4, fit: 3 },
    }, ctx('research_manager'));
    expect(first.ok).toBe(true);
    expect(first.text).toContain('Still waiting on value, effort');
    const slug = (first.data as { slug: string }).slug;
    expect(slug).toBe('meal-kits-for-nurseries');
    expect(readIdea(vault, slug)!.data.score).toBeNull();
    expect(readIdea(vault, slug)!.data.evidence).toContain('Research/meal-kits/report.md');
    expect(readIdea(vault, slug)!.body).toContain('Two nurseries already pay a competitor.');

    const second = await ideaCard.handler({
      title: 'Meal kits for nurseries', slug, evidence: [],
      estimate: { text: 'Two weeks of one engineer; no money out of pocket.', value: 4, effort: 4 },
    }, ctx('cfo'));
    expect(second.ok).toBe(true);
    expect(second.text).toContain('updated');
    expect(second.text).toContain('Score 46');
    const card = readIdea(vault, slug)!;
    expect(card.data.score).toBe(46);
    expect(card.data.status).toBe('triaged');
    expect(card.body).toContain('**Recommendation:** keep');
    expect(card.body).toContain('Two weeks of one engineer');
  });

  it('files a bare card with no office half at all', async () => {
    const r = await ideaCard.handler({ title: 'A hunch', evidence: [], why_it_matters: 'It might be nothing.' }, ctx('intelligence_analyst'));
    expect(r.ok).toBe(true);
    expect((r.data as { missing: string[] }).missing).toEqual(['value', 'evidence', 'effort', 'fit']);
    expect(readIdea(vault, 'a-hunch')!.data.source).toBe('job_d1');   // provenance defaults to the job that filed it
  });

  // Review T4 finding 1 / coordinator ruling 1: a slug collision from a genuinely different idea must never
  // merge into the first card — `writeIdeaCard`'s own `-2` suffix is what resolves it.
  it('a slug collision from a different title never merges — the second idea gets its own card', async () => {
    const first = await ideaCard.handler({ title: 'Meal kits', evidence: [] }, ctx('research_manager'));
    expect(first.ok).toBe(true);
    const firstSlug = (first.data as { slug: string }).slug;
    expect(firstSlug).toBe('meal-kits');

    // "Meal Kits!" slugifies to the same 'meal-kits' as "Meal kits", but it is a different idea.
    const second = await ideaCard.handler({ title: 'Meal Kits!', evidence: [], why_it_matters: 'A different idea entirely.' }, ctx('intelligence_analyst'));
    expect(second.ok).toBe(true);
    const secondSlug = (second.data as { slug: string }).slug;
    expect(secondSlug).toBe('meal-kits-2');
    expect(readIdea(vault, firstSlug)!.data.title).toBe('Meal kits');           // the first card is untouched
    expect(readIdea(vault, firstSlug)!.body).not.toContain('A different idea entirely.');
    expect(readIdea(vault, secondSlug)!.body).toContain('A different idea entirely.');
  });

  // Review T4 finding 2 / coordinator ruling 2: an update by explicit slug merges new evidence and text rather
  // than dropping them, and re-renders `## Evidence` so the body and the frontmatter agree (finding 4).
  it('an update by explicit slug merges new evidence and text instead of dropping them', async () => {
    const first = await ideaCard.handler({ title: 'Meal kits', evidence: ['a.md'] }, ctx('research_manager'));
    const slug = (first.data as { slug: string }).slug;
    const second = await ideaCard.handler({ title: 'Meal kits', slug, evidence: ['b.md'], what_changed: 'new info' }, ctx('research_manager'));
    expect(second.ok).toBe(true);
    expect(second.text).toContain('updated');
    const card = readIdea(vault, slug)!;
    expect(card.data.evidence).toEqual(['a.md', 'b.md']);                       // appended, deduped, order kept
    expect(card.body).toContain('- a.md');
    expect(card.body).toContain('- b.md');
    expect(card.body).toContain('new info');
  });

  it('says nothing changed rather than claiming an update that did not happen', async () => {
    const first = await ideaCard.handler({ title: 'Meal kits', evidence: ['a.md'] }, ctx('research_manager'));
    const slug = (first.data as { slug: string }).slug;
    const second = await ideaCard.handler({ title: 'Meal kits', slug, evidence: [] }, ctx('research_manager'));
    expect(second.ok).toBe(true);
    expect(second.text).not.toContain('updated');
  });
});

// Review T4 finding 7 / coordinator ruling 6: the handler tests never went through a charter or `phase3Tools`,
// so a typo in a charter's `tools:` list, a missing `config/tools.yaml` entry, or a dropped registration would
// have shipped green.
describe('registration reaches the five charters (spec review finding 7)', () => {
  it('phase3Tools carries both tools, and each charter that needs one can reach it', () => {
    const names = phase3Tools().map((t) => t.name);
    expect(names).toContain('discovery.inputs');
    expect(names).toContain('idea.card');

    const reg = new ToolRegistry().registerAll(phase3Tools());
    for (const r of ['research_manager', 'researcher']) {
      expect(reg.forRole(role(r), cfg).map((t) => t.name), r).toContain('discovery.inputs');
    }
    for (const r of ['research_manager', 'researcher', 'intelligence_analyst', 'cfo', 'ceo']) {
      expect(reg.forRole(role(r), cfg).map((t) => t.name), r).toContain('idea.card');
    }
    const backendNames = reg.forRole(role('backend_engineer'), cfg).map((t) => t.name);
    expect(backendNames).not.toContain('idea.card');
    expect(backendNames).not.toContain('discovery.inputs');
  });
});
