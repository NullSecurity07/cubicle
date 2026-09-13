import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  scaffoldVault, Vault, RoleFrontmatter, readIdea, DISCOVERY_INBOX, INTERVIEW_PATH, FOUNDER_BRIEF,
  renderInterviewAsked, renderInterviewCovered, closeInterview, loadOrg, hasFounderBrief, isDiscoveryMaterial, asksForSurprise,
} from '@cubicle/core';
import { parseToolsConfig, ToolRegistry, phase3Tools, vaultWrite, vaultAppend, type ToolContext } from '../src/index.js';
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

  // Ruling FR-3b. The first live run's job read the note that said "surprise me" and wrote a founder brief
  // about a company nobody had described. The words "surprise me" are not material; the idea the owner picked
  // out of the CEO's three is, and it is the only sentence that says what the company is for.
  it('opens on the idea the owner picked, and never hands the job "surprise me"', async () => {
    vault.writeText('00 Inbox/2026-09-13-msg-surprise.md', '---\nid: msg_sur\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-13T09:00:00.000Z\nanswered: true\n---\n# surprise me\n\nsurprise me\n\n## CEO\n\nI filed three ideas as a proposal in 00 Inbox/.\n', 'owner');
    vault.writeText('00 Inbox/2026-09-13-msg-thanks.md', '---\nid: msg_th\nkind: message\nfrom: owner\nto: ceo\ncreated: 2026-09-13T09:02:00.000Z\n---\n# thanks\n\nthanks!\n', 'owner');
    vault.writeText('00 Inbox/2026-09-13-prop-ideas.md', '---\nid: prop_ideas\nkind: brand_change\nfrom: ceo\ntarget: Brand/name.md\ncreated: 2026-09-13T09:00:01.000Z\napproved: true\nchosen: 2\n---\n# Three company ideas — pick one\n\n1. GreenCrate — meal kits for nurseries.\n2. Deskless — shift scheduling for cafes.\n3. Tinyletter Co — a newsletter for allotment holders.\n', 'ceo');

    const r = await discoveryInputs.handler({ max_chars: 60000 }, ctx('research_manager'));
    expect(r.text).toContain('The owner picked this idea from the CEO\'s three:');
    expect(r.text).toContain('2. Deskless — shift scheduling for cafes.');
    expect(r.text).not.toContain('GreenCrate');                    // the options they did not pick
    expect(r.text).not.toMatch(/surprise me/i);                    // nor the words that asked for them
    expect(r.text).not.toContain('thanks!');                       // nor two words of thanks
    const d = r.data as { sources: string[]; messages: number; pick: string | null };
    expect(d.pick).toBe('2. Deskless — shift scheduling for cafes.');
    expect(d.sources).toContain('00 Inbox/2026-09-13-prop-ideas.md');
    expect(d.messages).toBe(0);
  });

  it('says plainly when there is nothing, and when the owner skipped', async () => {
    vault.writeText(INTERVIEW_PATH, closeInterview(renderInterviewAsked('2026-09-11T09:00:00.000Z'), 'skip'), 'ceo');
    const r = await discoveryInputs.handler({ max_chars: 60000 }, ctx('research_manager'));
    expect(r.text).toContain('skipped the interview');
    expect(r.text).toContain('## What the owner has typed in the cabin\n_Nothing._');
    expect((r.data as { sources: string[] }).sources).toEqual([]);
  });

  // SP5b §5: nobody was asked, because the owner had already said all six in their own material. Reported as
  // "not answered yet" — which is what the old ternary's else arm said — the brief would go looking for words
  // that are sitting in the very files and messages either side of that line.
  it('says the interview was not needed, not that it is unanswered, when the material covered it', async () => {
    vault.writeText(`${DISCOVERY_INBOX}/pitch.md`, 'We are building a weekly meal-kit box for nurseries.', 'owner');
    vault.writeText(INTERVIEW_PATH, renderInterviewCovered('2026-09-12T09:00:00.000Z'), 'daemon');

    const r = await discoveryInputs.handler({ max_chars: 60000 }, ctx('research_manager'));
    expect(r.ok).toBe(true);
    expect((r.data as { interview: string }).interview).toBe('covered');
    expect(r.text).toContain('Not asked: the owner\'s own material already answered all 6 questions');
    expect(r.text).not.toContain('Not answered yet');
    expect(r.text).not.toContain('skipped the interview');
    // The material it was taken from is still handed over, and the transcript is not itself a source: it holds
    // the questions, never the owner's words.
    expect(r.text).toContain('We are building a weekly meal-kit box');
    expect((r.data as { sources: string[] }).sources).not.toContain(INTERVIEW_PATH);
    // No brief adopted, so there is nothing else to point at: everything is in this call.
    expect(r.text).not.toContain(FOUNDER_BRIEF);
  });

  // Review T4, minor 3: when coverage came through the brief's sections, the answers are in a file this call
  // does not return, so "the files and messages here" sent the agent to the wrong document.
  it('names the founder brief in that sentence when there is one, because this call does not return it', async () => {
    vault.writeText(FOUNDER_BRIEF, '## What the company is\n\nA weekly meal-kit box delivered to nurseries.\n', 'owner');
    vault.writeText(INTERVIEW_PATH, renderInterviewCovered('2026-09-12T09:00:00.000Z'), 'daemon');

    const r = await discoveryInputs.handler({ max_chars: 60000 }, ctx('research_manager'));
    expect(r.text).toContain(FOUNDER_BRIEF);
    expect(r.text).toContain('which this call does not return');
    expect(r.text).not.toContain('Not answered yet');
    // It is still not a source: this call did not hand the brief over, it only said where it is.
    expect((r.data as { sources: string[] }).sources).not.toContain(FOUNDER_BRIEF);
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
    expect(inOffice(org, 'backend_engineer', 'research')).toBe(false);
    const refused = await ideaCard.handler({ title: 'Meal kits', evidence: [], research: { report: 'Research/x/report.md', confidence: 'medium', summary: 's', evidence: 4, fit: 3 } }, ctx('backend_engineer'));
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('research_manager');
    expect(vault.exists('Ideas/meal-kits.md')).toBe(false);        // a refused call writes nothing
  });

  // Whole-branch review I5: the chief executive held a blanket exemption from both halves — and it is the one
  // role that also writes `company.plan`, whose only permitted subject is kept ideas. It could set all four
  // numbers and score a card into `keep` on its own, which is the exact thing §2.5's split exists to prevent.
  it('does not let the chief executive answer for either desk', async () => {
    const org = loadOrg(vault);
    expect(inOffice(org, 'ceo', 'research')).toBe(false);
    expect(inOffice(org, 'ceo', 'finance')).toBe(false);
    const research = await ideaCard.handler({ title: 'Meal kits', evidence: [], research: { report: 'Research/x/report.md', confidence: 'medium', summary: 's', evidence: 5, fit: 5 } }, ctx('ceo'));
    expect(research.ok).toBe(false);
    expect(research.text).toContain('research_manager');
    const estimate = await ideaCard.handler({ title: 'Meal kits', evidence: [], estimate: { text: 'a week', value: 5, effort: 5 } }, ctx('ceo'));
    expect(estimate.ok).toBe(false);
    expect(estimate.text).toContain('cfo');
    expect(vault.exists('Ideas/meal-kits.md')).toBe(false);
    // It may still file a card — it just cannot score one.
    const bare = await ideaCard.handler({ title: 'Meal kits', evidence: [] }, ctx('ceo'));
    expect(bare.ok).toBe(true);
    expect(readIdea(vault, 'meal-kits')!.data.score).toBeNull();
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
    expect(first.text).toContain('Still waiting on value and effort from the finance office');
    expect(readIdea(vault, (first.data as { slug: string }).slug)!.body).toContain('value and effort from the finance office');
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

  // T13-5: an office asked to fill in its half of `Ideas/<slug>` knows the slug, not the title — and a required
  // `title` meant the pure half-fill each office's own job goal asks for was refused for a field it may not set.
  it('lets each office fill its half by slug alone, with no title', async () => {
    const filed = await ideaCard.handler({ title: 'Meal kits for nurseries', evidence: [] }, ctx('intelligence_analyst'));
    const slug = (filed.data as { slug: string }).slug;

    const research = await ideaCard.handler({ slug, evidence: [], research: { report: 'Research/meal-kits/report.md', confidence: 'high', summary: 'Two nurseries already pay a competitor.', evidence: 4, fit: 3 } }, ctx('research_manager'));
    expect(research.ok).toBe(true);
    const finance = await ideaCard.handler({ slug, evidence: [], estimate: { text: 'Two weeks of one engineer.', value: 4, effort: 4 } }, ctx('cfo'));
    expect(finance.ok).toBe(true);

    const card = readIdea(vault, slug)!;
    expect(card.data.title).toBe('Meal kits for nurseries');     // never retitled by a half-fill
    expect(card.data.score).toBe(46);
    expect(vault.list('Ideas', { ext: '.md' }).filter((r) => !r.endsWith('_template.md'))).toHaveLength(1);
  });

  it('says so plainly when there is neither a title nor a card to fill in', async () => {
    const nothing = await ideaCard.handler({ evidence: [] }, ctx('research_manager'));
    expect(nothing.ok).toBe(false);
    expect(nothing.text).toContain('needs a title');
    const missing = await ideaCard.handler({ slug: 'no-such-card', evidence: [], estimate: { text: 'a week', value: 3, effort: 3 } }, ctx('cfo'));
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain('Ideas/no-such-card.md');
    expect(vault.exists('Ideas/no-such-card.md')).toBe(false);
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
    // Two different ideas whose titles only diverge past the 48-character slug cut, so they collide.
    const weekly = 'Weekly meal kits for nurseries in the south of the county';
    const daily = 'Weekly meal kits for nurseries in the south of the city';
    const first = await ideaCard.handler({ title: weekly, evidence: [] }, ctx('research_manager'));
    expect(first.ok).toBe(true);
    const firstSlug = (first.data as { slug: string }).slug;

    const second = await ideaCard.handler({ title: daily, evidence: [], why_it_matters: 'A different idea entirely.' }, ctx('intelligence_analyst'));
    expect(second.ok).toBe(true);
    const secondSlug = (second.data as { slug: string }).slug;
    expect(secondSlug).not.toBe(firstSlug);
    expect(secondSlug).toMatch(/-2$/);
    expect(readIdea(vault, firstSlug)!.data.title).toBe(weekly);                // the first card is untouched
    expect(readIdea(vault, firstSlug)!.body).not.toContain('A different idea entirely.');
    expect(readIdea(vault, secondSlug)!.body).toContain('A different idea entirely.');
  });

  // Minor 8, the other half: the same idea typed with different punctuation is one idea, not two dossiers each
  // scored, judged and decided on its own. And `slug: ""` is not naming a card.
  it('folds a punctuation variant into the card that already covers it', async () => {
    const first = await ideaCard.handler({ title: 'Meal kits', evidence: [] }, ctx('research_manager'));
    const firstSlug = (first.data as { slug: string }).slug;
    expect(firstSlug).toBe('meal-kits');
    const again = await ideaCard.handler({ title: 'Meal Kits!', evidence: [] }, ctx('intelligence_analyst'));
    expect((again.data as { slug: string }).slug).toBe(firstSlug);
    const empty = await ideaCard.handler({ title: 'Meal kits.', slug: '', evidence: [] }, ctx('intelligence_analyst'));
    expect((empty.data as { slug: string }).slug).toBe(firstSlug);
    expect(vault.list('Ideas', { ext: '.md' }).filter((r) => !r.endsWith('_template.md'))).toHaveLength(1);
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

describe('the founder brief is adopted, never written (ruling FR-4, review Important 4)', () => {
  // What the live run actually did: the discovery job wrote `Memory/founder-brief.md` directly 49 seconds
  // before it filed the proposal, so an unchecked brief carrying three fabricated claims was in the vault
  // whatever the owner then decided — and `hasFounderBrief` told every later plan the company had one.
  const brief = '## What the company is\n\nMeal kits for nurseries, invented on the spot.\n';

  it('refuses vault.write and vault.append to it, writes nothing, and names the road that is checked', async () => {
    for (const [tool, name] of [[vaultWrite, 'vault.write'], [vaultAppend, 'vault.append']] as const) {
      const r = await (tool.handler as (a: { path: string; content: string }, c: ToolContext) => Promise<{ ok: boolean; text: string }>)({ path: FOUNDER_BRIEF, content: brief }, ctx('research_manager'));
      expect(r.ok, name).toBe(false);
      expect(r.text).toContain('proposal.create kind=founder_brief');
      expect(vault.readTextOrNull(FOUNDER_BRIEF)).toBeNull();
      expect(hasFounderBrief(vault)).toBe(false);
    }
    // Refused where the owner can see it, like every other blocked write. (The dispatcher's own write on the
    // owner's approval goes through `vault.writeText` as the daemon, not through this tool, and is covered by
    // `packages/daemon/test/sp3-proposals.test.ts`.)
    expect(vault.events.query({ types: ['guardrail.blocked'] }).length).toBe(2);
  });
});

describe('one predicate for "surprise me", and a document is always material (review Important 3)', () => {
  const brief = ['We are building a gift shop for people who hate choosing gifts.',
    'The product is a short quiz and a box; the quiz has a "surprise me" button that picks a gift at random.',
    'Today they stand in a card shop for twenty minutes and leave with a candle.',
    'Two shops have said they would stock it. We have no name and no site yet.',
    'We tried a pop-up in November and sold eleven boxes, which was not enough.',
    'What we do not know is whether anyone buys a second one.'].join('\n');

  it('reads a long brief that merely mentions the phrase as material, and does not take it as the ask', () => {
    expect(asksForSurprise(brief)).toBe(false);
    expect(isDiscoveryMaterial(brief)).toBe(true);
  });

  it('reads it as material even where the anchored test does fire: a document is never only a reply', () => {
    // The phrase inside the last three lines of a document — the anchor cannot tell this from the ask, so the
    // material filter must not depend on it. `isLongPrompt` decides first, and a brief is always read.
    const late = `${brief}\nThe quiz ends on a "surprise me" button, which is the whole charm of it.`;
    expect(asksForSurprise(late)).toBe(true);
    expect(isDiscoveryMaterial(late)).toBe(true);
  });

  it("still takes the owner's own request for three ideas as the ask, and never as material", () => {
    expect(asksForSurprise('surprise me')).toBe(true);
    expect(asksForSurprise('# surprise me\n\nsurprise me')).toBe(true);
    expect(asksForSurprise('I have thought about it all week.\nsurprise me')).toBe(true);
    expect(isDiscoveryMaterial('surprise me')).toBe(false);
  });
});
