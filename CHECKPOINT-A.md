# Checkpoint A — the headless company runs

Phases 1–4 are complete. Nothing here needs the office UI; everything is observable in Obsidian and the terminal.

## What to run (from the repo root)

```bash
pnpm install && pnpm -r build && pnpm -r test          # every package green
pnpm cubicle init ~/Vaults/Cubicle                     # scaffold a vault (open the folder in Obsidian: "Open folder as vault")
pnpm cubicle providers test                            # gemini + ollama should say "yes"; others say "no key"
GEMINI_API_KEY= pnpm cubicle chat --tier strong "pong" # cascade proof: answers from ollama with a router.downgraded line
pnpm test:kill9                                        # acceptance test 1: kill -9 after step 2 → resume at 3, 2 keys
pnpm test:sleep                                        # acceptance test 9: SIGTERM and PrepareForSleep → exit < 5 s → resume
pnpm test:acceptance                                   # tagged acceptance cases (2, 5 fake-model, plus resumability)
```

## What to expect on a first run

```bash
pnpm cubicle start ~/Vaults/Cubicle
```

Then in Obsidian create `00 Inbox/idea.md`:

```markdown
---
id: msg_my_idea
kind: message
from: owner
to: ceo
answered: null
---
A one-page site selling a printable meal-planning template for busy parents.
```

Within one tick (30 s) the daemon runs heartbeat #1. You will see, in this order:

- `Jobs/job_…md` with `type: ceo.heartbeat`, then `type: cto.plan`
- `00 Inbox/…-brand_change-….md` — the CEO's name proposal; set `approved: true` to adopt it (or edit the fenced block first)
- your idea note gains a `## CEO` reply and `answered: true`
- `Plans/plan.md` rewritten by the CTO, `Plans/archive/` keeps the old one
- `Jobs/queue.md` regenerated; `Runs/<timestamp>.md` — the "since you were away" brief
- a git commit `cubicle: heartbeat <id>` inside the vault
- zero `email.sent` / `deploy.done` lines in `.cubicle/events/*.jsonl` (nothing outbound without approval)

`pnpm cubicle status ~/Vaults/Cubicle` summarises jobs and the last heartbeat. `pnpm cubicle stop` checkpoints and exits in under 5 s.

## Known limits at this checkpoint

- Tools with side effects (shell, browser, email, deploy, Stripe, analytics, social, meetings) arrive in Phases 5–6; until then the Engineer can only write files through `vault.write`.
- Sleep detection needs a reachable D-Bus system bus; if it cannot connect within 4 s the daemon logs it and relies on SIGTERM.
- The office (Phases 8–9) and the tray app (Phase 10) do not exist yet; the WebSocket server on port 7411 already serves snapshots and live events.
