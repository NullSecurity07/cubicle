import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldVault, Vault, listStreams, readStream, createProposal, loadOrg, listJobs, findInboxById, nowIso, BRAND_NAME_PATH } from '@cubicle/core';
import { seedFirstStream, firstStreamSpec, seedFirstJobs } from '../src/first-run.js';
import { adoptFounderBrief } from './helpers/brief.js';

let dir: string; let vault: Vault;
beforeEach(async () => { dir = mkdtempSync(path.join(tmpdir(), 'cubicle-firststream-')); vault = (await scaffoldVault(dir)).vault; });
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

function idea(name: string, tagline: string, ownerNote: string): void {
  vault.writeText('Brand/name.md', `---\nname: ${name}\ntagline: ${tagline}\nurl: ""\n---\n# ${name}\n`, 'owner');
  createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'The idea', body: ownerNote }, 'owner');
  // The brief the owner adopted from that idea: what `seedFirstJobs` anchors its once-only window on (P8-15).
  adoptFounderBrief(vault);
}

describe('firstStreamSpec', () => {
  it('turns the brand and the owner note into a stream whose unanswered fields are questions, not TBD', () => {
    const s = firstStreamSpec({ name: 'Ledgerly', tagline: 'Books that close themselves' }, 'Small agencies waste two days a month reconciling invoices by hand.');
    expect(s.name).toBe('Ledgerly');
    expect(s.problem).toContain('reconciling invoices');
    expect(s.customers).toMatch(/\?/);
    expect(s.outcome_metric).toMatch(/\?/);
    expect(s.owner_team).toBe('dev');
    expect(`${s.problem} ${s.customers} ${s.outcome_metric}`).not.toMatch(/TBD|TODO|placeholder/i);
  });

  it('falls back to the tagline when the owner wrote no note, and never to an empty problem', () => {
    const s = firstStreamSpec({ name: 'Ledgerly', tagline: 'Books that close themselves' }, '');
    expect(s.problem).toContain('Books that close themselves');
    expect(s.problem.length).toBeGreaterThan(20);
  });
});

/**
 * Ruling W4-9. `Streams/speedaudit.md` in the 2026-09-14 dry run, verbatim in its `problem:` field: the owner's
 * two words, the CEO's whole reply to them, all three ideas, and a cut mid-word at 600 characters —
 * "surprise me I filed three ideas as a proposal in 00 Inbox/. Pick one with `chosen:` … a simple static
 * submission f". Everything after the note's `## CEO` heading is the company talking to itself.
 */
describe('firstStreamSpec: the owner\'s own words, and the idea they picked (W4-9)', () => {
  /** The owner note exactly as the cabin writes it, reply section and all. */
  const LIVE_NOTE = `# surprise me\n\nsurprise me\n\n## CEO\n\nI filed three ideas as a proposal in 00 Inbox/. Pick one with \`chosen:\` and \`approved: true\`.\n\n1. SponsorDeck — A curated matchmaking service connecting niche newsletter creators with relevant software sponsors.\n2. SpeedAudit — A free performance diagnostic service delivering three manual, actionable website speed fixes to founders' inboxes.\n3. Ghostwriter Hunt — A weekly email digest matching busy executive founders with vetted ghostwriters.\n`;
  const PICK = "SpeedAudit — A free performance diagnostic service delivering three manual, actionable website speed fixes to founders' inboxes.";

  it('the CEO reply is not the problem, and neither is "surprise me": the picked idea is', () => {
    const s = firstStreamSpec({ name: 'SpeedAudit', tagline: 'Three fixes, free' }, LIVE_NOTE, PICK);
    expect(s.problem).toBe(PICK);
    expect(s.problem).not.toContain('I filed three ideas');
    expect(s.problem).not.toContain('SponsorDeck');
    expect(s.problem).not.toContain('Ghostwriter Hunt');
    expect(s.problem).not.toContain('chosen:');
    expect(s.problem).not.toMatch(/surprise me/i);
  });

  it('an owner who wrote a real problem keeps it, and still loses the reply section', () => {
    const note = "# the idea\n\nSmall agencies waste two days a month reconciling invoices by hand.\n\n## CEO\n\nNoted. I will plan against that.\n";
    const s = firstStreamSpec({ name: 'Ledgerly', tagline: 't' }, note, PICK);
    expect(s.problem).toBe('Small agencies waste two days a month reconciling invoices by hand.');
    expect(s.problem).not.toContain('Noted');
  });

  it('with neither words nor a pick it falls back to the tagline, never to the chat log', () => {
    expect(firstStreamSpec({ name: 'Ledgerly', tagline: 'Books that close themselves' }, LIVE_NOTE, null).problem).toContain('Books that close themselves');
  });
});

describe('seedFirstStream', () => {
  it('does nothing before the owner has an idea', () => {
    expect(seedFirstStream(vault)).toBeNull();
    expect(listStreams(vault)).toEqual([]);
  });

  it('creates exactly one stream from the idea, owned by the dev room', () => {
    idea('Ledgerly', 'Books that close themselves', 'Small agencies waste two days a month reconciling invoices by hand.');
    const slug = seedFirstStream(vault)!;
    expect(slug).toBe('ledgerly');
    const s = readStream(vault, slug)!;
    expect(s.data.owner_team).toBe('dev');
    expect(s.data.repo_path).toBe('Workspace/ledgerly');
    expect(s.data.problem).toContain('reconciling invoices');
  });

  it('an owner who said "surprise me" gets the idea they picked as the problem, not the chat log (W4-9)', () => {
    vault.writeText(BRAND_NAME_PATH, '---\nname: SpeedAudit\ntagline: Three fixes, free\nurl: ""\n---\n# SpeedAudit\n', 'owner');
    createProposal(vault, { kind: 'message', from: 'owner', to: 'ceo', title: 'surprise me', body: "# surprise me\n\nsurprise me\n\n## CEO\n\nI filed three ideas as a proposal in 00 Inbox/. Pick one with `chosen:` and `approved: true`.\n\n1. SponsorDeck — matchmaking for newsletters.\n2. SpeedAudit — A free performance diagnostic service delivering three manual website speed fixes.\n3. Ghostwriter Hunt — a weekly digest.\n" }, 'owner');
    const trio = createProposal(vault, { kind: 'brand_change', from: 'ceo', to: 'owner', target: BRAND_NAME_PATH, title: 'Three company ideas — pick one', body: '1. SponsorDeck — matchmaking for newsletters.\n2. SpeedAudit — A free performance diagnostic service delivering three manual website speed fixes.\n3. Ghostwriter Hunt — a weekly digest.\n' }, 'ceo');
    const note = findInboxById(vault, trio.id)!;
    vault.updateNote(note.path, (n) => ({ data: { ...n.data, approved: true, chosen: 2, resolved_at: nowIso() }, body: n.body }), 'owner');
    adoptFounderBrief(vault);

    const s = readStream(vault, seedFirstStream(vault)!)!;
    expect(s.data.problem).toBe('SpeedAudit — A free performance diagnostic service delivering three manual website speed fixes.');
    expect(s.data.problem).not.toContain('I filed three ideas');
    expect(s.data.problem).not.toContain('SponsorDeck');
  });

  it('is once-only: a second call with a stream already there adds nothing', () => {
    idea('Ledgerly', 't', 'the problem sentence');
    seedFirstStream(vault);
    expect(seedFirstStream(vault)).toBeNull();
    expect(listStreams(vault)).toHaveLength(1);
  });

  it('the three first-run jobs point at the stream', () => {
    idea('Ledgerly', 't', 'the problem sentence');
    const slug = seedFirstStream(vault)!;
    const ids = seedFirstJobs(vault, loadOrg(vault));
    expect(ids.length).toBeGreaterThan(0);
    const jobs = listJobs(vault).filter((j) => ids.includes(j.id));
    expect(jobs.every((j) => j.stream === slug)).toBe(true);
    const ship = jobs.find((j) => j.type === 'engineer.ship')!;
    expect(ship.risk).toBe('low');
  });
});

describe('the company plan names streams', () => {
  it('the CEO is told to attach a stream to every objective', async () => {
    const { HEARTBEAT_STEPS } = await import('../src/heartbeat.js');
    expect(HEARTBEAT_STEPS).toContain('company_plan');
    const src = (await import('node:fs')).readFileSync(path.resolve(__dirname, '../src/heartbeat.ts'), 'utf8');
    expect(src).toMatch(/stream: <slug>/);
    expect(src).toMatch(/Streams\//);
  });
});
