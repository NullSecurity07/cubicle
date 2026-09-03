# Checkpoint B — the office is open

Phases 5–9 are complete: the company can build, browse, mail, deploy (mock or live), evolve, and everything shows up as sprites and screens in the office.

## Open the office

```bash
pnpm --filter @cubicle/viewer build          # once; the daemon serves packages/viewer/dist
pnpm cubicle start ~/Vaults/Cubicle          # prints:  open the office: http://127.0.0.1:7412/?token=…
pnpm cubicle open ~/Vaults/Cubicle           # same URL, launched with xdg-open
```

Add `&vault=<your vault name>` to the URL to make the Vault building's Obsidian link work.

## What to look at

- **Top bar**: the company name and tagline from `Brand/name.md`, the connection state, an amber "N to approve" badge (opens the post office), and shortcuts to the brief, the plan, the queue and the CEO.
- **Screens in the office** show a head line and a few short lines only (they are cropped to their box); click any of them for the full content. Lists open in the right-hand drawer, documents (plan, brief, job notes) open in a centered reader with Copy and an Obsidian link.
- **Cubicles**: one sprite per active role at its desk; a coloured ring marks the role; a small glyph over the head shows the tool in use (W browser, >_ shell, M mail, D docs, % analytics, … chat); `!` = last job failed, `?` = blocked. Click a sprite for its current job and charter.
- **Expressions**: faces change with the job (thinking, happy on done, worried on a failure, puzzled when blocked, asleep after a quiet spell or when offline) and pixel emotes float above the head (sweat, ?, !, a lightbulb when proposing, a heart on hire, a star on deploy, zzz, the COO's clipboard on the way to a failed job). Thought bubbles (cloud, animated dots) show thinking; speech bubbles (tail, role-coloured border) show what an agent said; dark action strips name the tool call ("running npm run build"). Sprites blink, type, stretch, glance around, stop at the kitchen for a coffee after a finished job, wave when you message the CEO, and turn towards whoever is speaking in a meeting.
- **CEO cabin** (top right): click the dark screen for the conversation with the CEO as a message thread (your notes in `00 Inbox/` and the `## CEO` replies), with the latest brief pinned above it. Type "surprise me" for three ideas.
- **Whiteboard**: `Plans/plan.md`, live. **Notice board** (by the door): the open queue, each row opening the job.
- **Board room / meeting room**: sprites walk in when `meeting.open` fires and speak in bubbles.
- **Courtyard**: Billboard (live browser stream while a session is open, else the last screenshot), Terminal shed (shell output), Post office (mail + the red "N to approve" count), Newsstand (brief + decision feed), Bank (quota runway bars), Vault (job list + Obsidian link), Workshop (`Site/dist` preview + last deploy).
- **Time controls** (bottom left): live, or pick a date → replay; double-click the slider to play/pause at the chosen speed. Day/night tint follows real time live and event timestamps in replay.
- **Org** (top bar): teams as openable rows with their lead, members and open-job count; the queue groups jobs by team and shows an `in_review` chip for jobs still waiting on a gate. See [CHECKPOINT-C.md](CHECKPOINT-C.md).

## Acceptance checks you can run yourself

```bash
pnpm test:replay        # test 8: close viewer, browse, reopen → office reconstructs; replay shows frames on the billboard
pnpm office:shot        # headless screenshots of the office under a burst of events → .shots/
pnpm test:acceptance    # tagged suites (tests 2, 3, 5, 6, 7)
```

## Live smoke tests once you have keys (all free; see SETUP.md)

```bash
pnpm cubicle doctor --live                                   # each key pinged with one free call
GROQ_API_KEY=… pnpm cubicle providers test --tools           # tool calling on each provider
```

With `BREVO_API_KEY`, `CLOUDFLARE_*`, `STRIPE_SECRET_KEY` (test key), `GOATCOUNTER_*` set, the first real email/deploy/link each arrives as a proposal in `00 Inbox/` — approve it there and watch the Post office badge drop.

## Real suspend (acceptance test 9)

```bash
pnpm cubicle start ~/Vaults/Cubicle &   # then: systemctl suspend
```

The daemon logs `PrepareForSleep(true) received`, checkpoints and exits within 5 s. After wake, `pnpm cubicle start` (or the tray app from Phase 10) resumes every interrupted job from its checkpoint.
