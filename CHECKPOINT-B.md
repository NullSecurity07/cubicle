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

- **Cubicles**: one sprite per active role at its desk; a coloured ring marks the role; a small glyph over the head shows the tool in use (W browser, >_ shell, M mail, D docs, % analytics, … chat); `!` = last job failed, `?` = blocked.
- **CEO cabin** (top right): click the dark screen to talk to the CEO (writes `00 Inbox/…-message-….md`); the latest brief is pinned there. Type "surprise me" for three ideas.
- **Whiteboard**: `Plans/plan.md`, live. **Notice board** (by the door): the open queue.
- **Board room / meeting room**: sprites walk in when `meeting.open` fires and speak in bubbles.
- **Courtyard**: Billboard (live browser stream while a session is open, else the last screenshot), Terminal shed (shell output), Post office (mail + the red "N to approve" count), Newsstand (brief + decision feed), Bank (quota runway bars), Vault (job list + Obsidian link), Workshop (`Site/dist` preview + last deploy).
- **Time controls** (bottom left): live, or pick a date → replay; double-click the slider to play/pause at the chosen speed. Day/night tint follows real time live and event timestamps in replay.

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
