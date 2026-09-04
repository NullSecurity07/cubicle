import { type Vault, type Org, type NewJob, createJob, listJobs } from '@cubicle/core';

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
  const pick = (preferred: string, team: string, fallback = 'ceo') => (org.roles[preferred] ? preferred : org.teams[team]?.lead ?? fallback);
  const engineer = pick('engineer', 'engineering');
  const growthLead = pick('head_of_growth', 'growth');
  const analyst = org.roles.research_analyst ? 'research_analyst' : growthLead;
  return [
    {
      type: 'engineer.ship', title: FIRST_JOB_TITLES[0], assigned: engineer, priority: 2,
      team: org.roles[engineer]?.team, owner_role: org.teams.engineering?.lead ?? 'ceo',
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

/**
 * Seed the first-run jobs, once, on the first cycle only. Returns the ids created (possibly none).
 *
 * Skipped entirely once any `heartbeat.completed` event exists — later cycles plan for themselves. A seed whose
 * work a live job already covers is skipped too, so a lead who planned the scaffold does not get a second one.
 */
export function seedFirstJobs(vault: Vault, org: Org): string[] {
  if (vault.events.count('heartbeat.completed') > 0) return [];
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
