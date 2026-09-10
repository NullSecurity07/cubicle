import { type Vault, type Org, type NewJob, createJob, listJobs, listInbox, parseNote, resolveRole, researchLead, leadOf } from '@cubicle/core';

/**
 * The three jobs a company must leave its first heartbeat with (spec §12): something on the web, something to
 * sell, and somewhere to be found. The CEO's own plan usually asks for some of them, but "usually" is not a
 * first run: a vague owner idea, a thin plan or a lead that queued nothing at all would otherwise leave the
 * office idle on day one, which is the worst possible first impression.
 *
 * Titles are fixed so the seeds are recognisable to the owner and to this function's own de-duplication.
 */
export const FIRST_JOB_TITLES = [
  'Scaffold Site/ from Brand/ (first cut)',
  'Define the offer and price point',
  'Research the first organic channel',
] as const;

/** The words of a title, lowercased. */
function words(title: string): string[] {
  return title.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** The first three words of a title, lowercased — how a seed decides some job already covers it. */
function titleKey(title: string): string {
  return words(title).slice(0, 3).join(' ');
}

/**
 * True when an existing job is already the piece of work `seed` describes: its own first three words are the
 * seed's first three words. "Scaffold Site/ from Brand/ (v2)" covers the site seed; "Research competitors" does
 * not cover the channel seed.
 *
 * The match is one-directional on purpose. A title with fewer than three words has not said enough to claim a
 * seed's work — a job called "Research" would otherwise silently cancel the channel seed — so it never covers
 * one.
 */
function covers(existing: string, seed: string): boolean {
  if (words(existing).length < 3) return false;
  return titleKey(existing).startsWith(titleKey(seed));
}

function specs(org: Org): NewJob[] {
  const engineer = resolveRole(org, 'engineer');
  const growthLead = resolveRole(org, 'head_of_growth');
  const analyst = researchLead(org) ?? growthLead;
  const engineeringOwner = leadOf(org, engineer) ?? 'ceo';
  return [
    {
      type: 'engineer.ship', title: FIRST_JOB_TITLES[0], assigned: engineer, priority: 2,
      team: org.roles[engineer]?.team, owner_role: engineeringOwner === 'owner' ? 'ceo' : engineeringOwner,
      goal: 'The company has no site yet. Read Brand/name.md, Brand/palette.md and Brand/voice.md, then build the first cut of Site/: one page that says what the company does, who it is for, and how to get in touch. Keep it static and boring — no framework, no build step the owner has to learn. Do not invent claims the brand notes do not support.',
      done_when: 'Site/index.html exists, uses the name, palette and voice from Brand/, has no broken links, and says what the company sells and to whom.',
    },
    {
      type: 'research', title: FIRST_JOB_TITLES[1], assigned: analyst, priority: 2, for: growthLead,
      team: org.roles[analyst]?.team, owner_role: growthLead,
      goal: 'Nothing can be sold until there is an offer. From Brand/ and the owner\'s notes in 00 Inbox/, work out the single thing this company sells first, who buys it, and what it costs. Compare at least two plausible price points against what comparable products charge, and link your sources. Recommend one.',
      done_when: 'Docs/offer.md names one offer, one buyer and one price, each with the evidence behind it, and ends with a next step the lead can schedule.',
    },
    {
      type: 'growth.seo', title: FIRST_JOB_TITLES[2], assigned: growthLead, priority: 2,
      team: org.roles[growthLead]?.team, owner_role: growthLead,
      goal: 'Find the one organic channel worth trying first — search, a community, a directory, a newsletter — for the buyer the offer names. Judge each candidate on where that buyer already is and what it costs us in time, not on how large it is. Do not propose paid acquisition and do not propose anything the constitution bans.',
      done_when: 'Docs/channels.md names one channel, why it fits this buyer, what it costs us weekly, and the first three things to publish there.',
    },
  ];
}

/** Statuses that mean a job will never deliver anything. */
const DEAD = ['cancelled', 'failed'];

/** Stand-in date for evidence of an idea that carries no timestamp of its own. */
const EPOCH = new Date(0).toISOString();

/**
 * When the company got its idea — the ISO timestamp of the earliest evidence of one, or null when it has none.
 *
 * Spec §12: nothing happens until the owner types an idea, so neither the startup heartbeat nor these seeds may
 * fire before one exists — a nameless company that scaffolds a site and researches a channel is working on
 * nothing. An idea can arrive in three shapes and any one of them counts: the brand is already named (the owner
 * typed a name, or approved the CEO's proposal), a `brand_change` proposal is open (what the CEO files from an
 * idea it was given), or an owner message is sitting in `00 Inbox/` (what the cabin chat writes). Mirrors the
 * `isFirstIdea` test in heartbeat.ts, widened to any brand_change and any owner message.
 *
 * A named brand with no `vault.wrote` event behind it (the owner typed it in while the daemon was down, or the
 * log was trimmed) is dated to the epoch: the idea has been there as long as anything we can see, so every
 * heartbeat in the log counts as having had it.
 */
export function ideaAt(vault: Vault): string | null {
  const stamps: string[] = [];
  const name = parseNote(vault.readTextOrNull('Brand/name.md') ?? '').data.name;
  if (typeof name === 'string' && name.trim()) stamps.push(vault.events.query({ types: ['vault.wrote'] }).find((e) => e.payload.path === 'Brand/name.md')?.ts ?? EPOCH);
  for (const n of listInbox(vault)) {
    if (n.data.kind === 'brand_change' || (n.data.kind === 'message' && n.data.from === 'owner')) stamps.push(String(n.data.created ?? EPOCH));
  }
  return stamps.length ? stamps.sort()[0] : null;
}

/** True once the owner has given the company something to run on; see {@link ideaAt}. */
export function hasIdea(vault: Vault): boolean {
  return ideaAt(vault) !== null;
}

/**
 * Seed the first-run jobs on the first heartbeat that completes after the owner's idea. Returns the ids created
 * (possibly none).
 *
 * The guard used to be "no `heartbeat.completed` exists at all", which the startup heartbeat broke: that one
 * runs before the owner has typed anything, so all three seeds were spent on a nameless company and the
 * heartbeat that followed the idea then seeded nothing (C1). Anchoring the window to the idea instead keeps the
 * once-only guarantee — later cycles plan for themselves — while putting the seeds on the cycle they belong to.
 *
 * A seed whose work a live job already covers is skipped, so a lead who planned the scaffold does not get a
 * second one.
 */
export function seedFirstJobs(vault: Vault, org: Org): string[] {
  const since = ideaAt(vault);
  if (since === null) return [];
  if (vault.events.query({ types: ['heartbeat.completed'], from: since, limit: 1 }).length > 0) return [];
  // A cancelled or failed job is not going to produce anything, so it cannot stand in for a seed.
  const titles = listJobs(vault).filter((j) => !DEAD.includes(j.status)).map((j) => j.title);
  const out: string[] = [];
  for (const spec of specs(org)) {
    if (titles.some((t) => covers(t, spec.title))) continue;
    out.push(createJob(vault, spec, 'ceo'));
    titles.push(spec.title);
  }
  return out;
}
