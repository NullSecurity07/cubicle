import { STATIC_TEMPLATE } from '@cubicle/tools';
import { type Vault, type Org, type NewJob, createJob, listJobs, listInbox, listDiscoveryInputs, parseNote, officeHolder, roleWithTool, researchLead, teamOf, leadOf, createStream, listStreams, streamSlug, ciConfigPath, hasFounderBrief, ownerSaid, ownerPick, isDiscoveryMaterial, coversTitle, FOUNDER_BRIEF, type NewStream } from '@cubicle/core';

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

/**
 * True when an existing job is already the piece of work `seed` describes. Core's, because the queue asks the
 * same question of every job a lead schedules (ruling W4-10) and the two must not drift: a seed skipped here
 * and a division plan refused there have to mean the same thing by "already covered".
 */
const covers = coversTitle;

function specs(org: Org, stream?: string): NewJob[] {
  // Who builds and who sells is a capability question, not a name: the first active charter in the division that
  // carries the tool. An empty division falls back to its own office holder, who can delegate.
  const engOffice = officeHolder(org, 'engineering');
  const revOffice = officeHolder(org, 'finance');
  const engineer = roleWithTool(org, teamOf(org, engOffice)?.id, 'deploy.site') ?? engOffice;
  const growthLead = roleWithTool(org, teamOf(org, revOffice)?.id, 'email.send') ?? revOffice;
  const analyst = researchLead(org) ?? growthLead;
  const engineeringOwner = leadOf(org, engineer) ?? engOffice;
  return [
    {
      type: 'engineer.ship', title: FIRST_JOB_TITLES[0], assigned: engineer, priority: 2,
      team: org.roles[engineer]?.team, owner_role: engineeringOwner === 'owner' ? engOffice : engineeringOwner,
      goal: `The company has no site yet. Read Brand/name.md, Brand/palette.md and Brand/voice.md, then build the first cut of Site/: one page that says what the company does, who it is for, and how to get in touch. Keep it static and boring — no framework, no build step the owner has to learn. Do not invent claims the brand notes do not support.\n\nStart from the static template, which is exactly that page with nothing to install: \`${STATIC_TEMPLATE}/\` in the sandbox holds index.html, styles.css and cubicle-ci.yaml. Copy these, then edit — \`shell.run({ command: "cp -a ${STATIC_TEMPLATE}/. .", cwd: "Site" })\` and write the real copy over every REPLACE in index.html and the real colours over the tokens at the top of styles.css. Do NOT copy /opt/templates/minimal: that is Astro and npm, which is the build step this job is told not to have.\n\nBefore you finish: this is an engineer.ship, so it cannot report success without a green CI run newer than every source file in its stream (operating model §17). Put the template's pipeline in place of the stream's placeholder one — read \`${STATIC_TEMPLATE}/cubicle-ci.yaml\` with shell.run and vault.write it to Workspace/<the job's stream>/cubicle-ci.yaml — then call ci.run({ stream: "<the job's stream>" }) and finish on green. It checks the HTML with no npm and fails while any REPLACE is left in the page.`,
      done_when: 'Site/index.html exists, uses the name, palette and voice from Brand/, has no broken links, says what the company sells and to whom, and ci.run on the job\'s stream is green.',
      stream, risk: 'low',
    },
    {
      type: 'research', title: FIRST_JOB_TITLES[1], assigned: analyst, priority: 2, for: growthLead,
      team: org.roles[analyst]?.team, owner_role: growthLead,
      goal: 'Nothing can be sold until there is an offer. From Brand/ and the owner\'s notes in 00 Inbox/, work out the single thing this company sells first, who buys it, and what it costs. Compare at least two plausible price points against what comparable products charge, and link your sources. Recommend one.',
      done_when: 'Docs/offer.md names one offer, one buyer and one price, each with the evidence behind it, and ends with a next step the lead can schedule.',
      stream,
    },
    {
      type: 'growth.seo', title: FIRST_JOB_TITLES[2], assigned: growthLead, priority: 2,
      team: org.roles[growthLead]?.team, owner_role: growthLead,
      goal: 'Find the one organic channel worth trying first — search, a community, a directory, a newsletter — for the buyer the offer names. Judge each candidate on where that buyer already is and what it costs us in time, not on how large it is. Do not propose paid acquisition and do not propose anything the constitution bans.',
      done_when: 'Docs/channels.md names one channel, why it fits this buyer, what it costs us weekly, and the first three things to publish there.',
      stream,
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
 * idea it was given), an owner message is sitting in `00 Inbox/` (what the cabin chat writes), or the owner
 * dropped a file in `Discovery/inbox/` (SP3: an owner with a startup already written down never types a line).
 * Mirrors the `isFirstIdea` test in heartbeat.ts, widened to any brand_change and any owner message.
 *
 * A named brand with no `vault.wrote` event behind it (the owner typed it in while the daemon was down, or the
 * log was trimmed) is dated to the epoch: the idea has been there as long as anything we can see, so every
 * heartbeat in the log counts as having had it.
 */
export function ideaAt(vault: Vault): string | null {
  const stamps: string[] = [];
  const name = parseNote(vault.readTextOrNull('Brand/name.md') ?? '').data.name;
  const named = typeof name === 'string' && name.trim() !== '';
  const inputs = listDiscoveryInputs(vault);
  // One pass over the log, indexed by path, rather than one query per file: `vault.wrote` is the most common
  // event there is, and the query inside the loop re-read the whole log for every dropped file.
  const firstWrite = new Map<string, string>();
  if (named || inputs.length) {
    const want = new Set([...(named ? ['Brand/name.md'] : []), ...inputs.map((f) => f.path)]);
    for (const e of vault.events.query({ types: ['owner.edited', 'vault.wrote'] })) {
      const p = String((e.payload as { path?: string }).path ?? '');
      if (want.has(p) && !firstWrite.has(p)) firstWrite.set(p, e.ts);
    }
  }
  if (named) stamps.push(firstWrite.get('Brand/name.md') ?? EPOCH);
  for (const n of listInbox(vault)) {
    if (n.data.kind === 'brand_change' || (n.data.kind === 'message' && n.data.from === 'owner')) stamps.push(String(n.data.created ?? EPOCH));
  }
  // A file the owner dropped in Discovery/inbox/ is an idea in its own right: it is how an owner with an
  // existing startup starts, and without this the company would sit idle waiting to be typed at. The README
  // the template ships is not one, which is why `listDiscoveryInputs` skips it.
  for (const f of inputs) stamps.push(firstWrite.get(f.path) ?? EPOCH);
  return stamps.length ? stamps.sort()[0] : null;
}

/** True once the owner has given the company something to run on; see {@link ideaAt}. */
export function hasIdea(vault: Vault): boolean {
  return ideaAt(vault) !== null;
}

/**
 * When the owner adopted the founder brief — the anchor the first-run seeds hang on (ruling P8-15), and `null`
 * while no brief is adopted.
 *
 * `Memory/founder-brief.md` exists only because the owner approved a `founder_brief` proposal: it is not
 * scaffolded, the `vault.write` tool refuses it by name, and the dispatcher's `founder_brief` case is the one
 * path that writes it (see `hasApprovedBrief`). So the file's first write in the log *is* the adoption, and the
 * proposal's `resolved_at` is the same moment recorded on the note — the fallback for a log that no longer
 * reaches back that far.
 *
 * The epoch is the last resort, and it is deliberately the conservative one: with no evidence of when the brief
 * was adopted, any completed heartbeat counts as having had it and nothing is seeded. Seeding twice would put a
 * second "scaffold the site" on a company that has been running for weeks; seeding never leaves the leads'
 * own plans, which is what later cycles run on anyway.
 */
export function briefAdoptedAt(vault: Vault): string | null {
  if (!hasFounderBrief(vault)) return null;
  for (const e of vault.events.query({ types: ['vault.wrote', 'owner.edited'] })) {
    if (String((e.payload as { path?: string }).path ?? '') === FOUNDER_BRIEF) return e.ts;
  }
  const resolved = listInbox(vault)
    .filter((n) => n.data.kind === 'founder_brief' && n.data.approved === true && !!n.data.resolved_at)
    .map((n) => String(n.data.resolved_at))
    .sort()[0];
  return resolved ?? EPOCH;
}

/**
 * The same answer, for anybody who is going to **print** it: `null` when the log no longer knows, never the
 * epoch (review of the run-3 wave, Important 3).
 *
 * `briefAdoptedAt`'s epoch is a comparison's answer — "treat every completed heartbeat as having had the brief"
 * — and it is the right one there. Read as a date it says the owner adopted the founder brief on 1 January 1970,
 * and the status answer's whole premise (ruling W3-6) is that every line of it is a fact.
 */
export function briefAdoptedOn(vault: Vault): string | null {
  const at = briefAdoptedAt(vault);
  return !at || at === EPOCH ? null : at;
}

/**
 * Seed the first-run jobs on the first heartbeat that runs after the owner adopted the founder brief. Returns
 * the ids created (possibly none).
 *
 * The guard used to be "no `heartbeat.completed` exists at all", which the startup heartbeat broke: that one
 * runs before the owner has typed anything, so all three seeds were spent on a nameless company and the
 * heartbeat that followed the idea then seeded nothing (C1). Anchoring the window to the *idea* fixed that and
 * then broke on ruling S-1: every planning step now waits for the adopted brief, so the seeds — three real
 * jobs, a site, an offer and a channel — were the one piece of work that ran ahead of it. The live AltStack run
 * did eighteen jobs for an idea the board had not judged (D2).
 *
 * The brief's adoption is therefore the anchor (ruling P8-15). It keeps the once-only guarantee the idea anchor
 * had — later cycles plan for themselves — and it is the only stamp that still works when the seeding cycle is
 * a later heartbeat: with the idea as the anchor, the heartbeat that ran between the idea and the adoption
 * would have suppressed the seeds for ever.
 *
 * A seed whose work a live job already covers is skipped, so a lead who planned the scaffold does not get a
 * second one.
 */
export function seedFirstJobs(vault: Vault, org: Org): string[] {
  const since = briefAdoptedAt(vault);
  if (since === null) return [];
  // The window closes on the first heartbeat that *gathered* with the brief and then completed — not on the
  // first `heartbeat.completed` after the write. The owner adopts whenever they like, and on a live daemon a
  // cycle takes minutes: the one in flight at that moment gathered before the brief existed, told its brief
  // step to wait, and still completes after the adoption. Counting it closed the window before anything was
  // seeded, and the company started with a stream and no work (the journey's stall at "the three first jobs").
  // A completed event with no `gathered_at` (an older log) keeps the conservative reading: it counts.
  const seededAlready = vault.events.query({ types: ['heartbeat.completed'], from: since }).some((e) => {
    const gathered = (e.payload as { gathered_at?: unknown }).gathered_at;
    return typeof gathered !== 'string' || gathered >= since;
  });
  if (seededAlready) return [];
  const stream = listStreams(vault)[0]?.slug;
  // A cancelled or failed job is not going to produce anything, so it cannot stand in for a seed.
  const titles = listJobs(vault).filter((j) => !DEAD.includes(j.status)).map((j) => j.title);
  const out: string[] = [];
  for (const spec of specs(org, stream)) {
    if (titles.some((t) => covers(t, spec.title))) continue;
    out.push(createJob(vault, spec, 'ceo'));
    titles.push(spec.title);
  }
  return out;
}

/** "2. SpeedAudit — A free performance diagnostic service…" → the sentence, without the numbering or the bold. */
function pickedIdeaLine(line: string): string {
  return line.trim().replace(/^\d+[.)]\s*/, '').replace(/\*\*/g, '').trim();
}

/**
 * The first stream, from whatever the owner actually gave us. The two fields only a person can answer are
 * written as questions addressed to the product manager, never as "TBD": a stream note is read by an agent, and
 * "TBD" is an instruction to skip the field.
 *
 * The problem is the owner's **own words and nothing else** (ruling W4-9). `Streams/speedaudit.md` in the
 * 2026-09-14 run carried, as its problem: "surprise me I filed three ideas as a proposal in 00 Inbox/. Pick one
 * with `chosen:` … 3. Ghostwriter Hunt — … a simple static submission f" — the owner's two words, the CEO's
 * reply to them, all three ideas, and a cut mid-word at 600 characters. Everything after the note's `## CEO`
 * heading is the company talking to itself, so `ownerSaid` takes it off.
 *
 * What is left is often "surprise me", which is a request for ideas and not a problem statement — the same
 * thing `isDiscoveryMaterial` already refuses to start a research job on. In that case the problem is `picked`:
 * the idea the owner chose from the CEO's three, title and one-liner, which is the one sentence that says what
 * this company is for.
 */
export function firstStreamSpec(brand: { name?: string; tagline?: string }, ownerText: string, picked?: string | null): NewStream {
  const name = (brand.name ?? '').trim() || 'First product';
  const said = ownerSaid(ownerText).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).join(' ').slice(0, 600);
  const own = isDiscoveryMaterial(said) ? said : '';
  const problem = own || (picked ?? '').trim()
    || `${(brand.tagline ?? '').trim() || name} — the owner has not written the problem in their own words yet. The product manager asks them, in one sentence, what goes wrong for the customer today.`;
  return {
    name,
    problem,
    customers: 'Who exactly buys this? The product manager answers in one sentence before the first objective is planned — "everyone" is not an answer (operating model §5).',
    outcome_metric: 'Which number proves this worked, from what to what? The product manager sets it before the first objective is planned; a feature list is not an outcome (§5, §21).',
    owner_team: 'dev',
    error_budget: 4,
  };
}

/**
 * The pipeline a brand-new stream starts with.
 *
 * Green on an empty workspace on purpose. The first seeded job is an `engineer.ship`, and `shipRefusal` will
 * not let one finish without a green CI record newer than every source file — so on day one, with nothing built
 * yet, a stream with no `cubicle-ci.yaml` leaves its first job unable to finish at all: the engineer has to
 * invent a pipeline for an empty directory before it can report success. That is not a first impression worth
 * having, and it is what this file removes.
 *
 * It is a starting point, not a pipeline. The comment says so where the engineer will read it, and the site
 * seed's goal says it again, because a pipeline that only ever echoes is not §17's "validated by the pipeline".
 */
const STARTER_CI_YAML = `# The pipeline for this stream. Every step runs in the sandbox, in this directory, on every ci.run —
# and an engineer.ship cannot finish without a green run newer than every source file here (operating
# model §17).
#
# It starts green on an empty workspace so the first job can finish before any code exists. Replace the
# placeholder below with the real steps as soon as code lands: build, lint, test, then security-scan
# (toolchain §45 gives the canonical order). Steps run in order and stop at the first failure unless the
# step sets allow_failure: true. Set network: allowlist only if a step genuinely needs the proxy.
network: none
timeout_s: 120
steps:
  - name: workspace
    run: "ls -a"
  - name: checks
    run: "echo 'No checks defined yet. Replace this step with the build, lint and test commands for this stream.'"
`;

/**
 * Create the company's first stream on the first cycle after the owner's idea, with the workspace and starter
 * pipeline its first job needs. Once only: any existing stream means the product manager has taken over, and a
 * second seed would compete with their work.
 */
export function seedFirstStream(vault: Vault): string | null {
  if (!hasIdea(vault)) return null;
  if (listStreams(vault).length > 0) return null;
  const brand = parseNote(vault.readTextOrNull('Brand/name.md') ?? '').data as { name?: string; tagline?: string };
  const ownerNote = listInbox(vault).find((n) => n.data.kind === 'message' && n.data.from === 'owner')?.body ?? '';
  // The idea the owner picked from the CEO's three, for an owner whose own note was "surprise me" (W4-9).
  const pick = ownerPick(vault);
  const spec = firstStreamSpec(brand, ownerNote, pick ? pickedIdeaLine(pick.line) : null);
  const slug = createStream(vault, { ...spec, slug: streamSlug(spec.name) }, 'ceo');
  // `createStream` already wrote `Streams/<slug>.md` through the vault, which announced it with a `vault.wrote`
  // carrying the sha. A second, sha-less emit here said nothing new and doubled the event the office reads.
  vault.writeText(ciConfigPath(slug), STARTER_CI_YAML, 'ceo');
  return slug;
}
