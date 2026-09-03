# Checkpoint A — the headless company runs

Phases 1–4 are complete. Nothing here needs the office UI; everything is observable in Obsidian and the terminal.

## What to run (from the repo root)

```bash
pnpm install && pnpm -r build && pnpm -r test          # every package green
pnpm cubicle init ~/Vaults/Cubicle                     # scaffold a vault (open the folder in Obsidian: "Open folder as vault")
pnpm cubicle providers test                            # gemini + ollama should say "yes"; others say "no key"
GEMINI_API_KEY= pnpm cubicle chat --tier strong "pong" # cascade proof: answers from ollama with a router.downgraded line
GEMINI_API_KEY= pnpm cubicle heartbeat ~/Vaults/Cubicle   # acceptance test 4: a full heartbeat on Ollama alone (slow: minutes)
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
- `00 Inbox/…-brand_change-….md` — the CEO's name proposal; set `approved: true` to adopt it. To change the name, edit the fenced block in a *CEO-authored* proposal; proposals created by an agent's `vault.write` carry the content in `call.args` and ignore fence edits — reject those and ask for a new one instead.
- your idea note gains a `## CEO` reply and `answered: true` (only `kind: message` is required in the frontmatter — `id`, `created`, `from`, `to` are filled in for you; a note the daemon cannot read is reported as a `daemon.warning` event, never dropped silently)
- `Plans/plan.md` rewritten by the CTO, `Plans/archive/` keeps the old one
- `Jobs/queue.md` regenerated; `Runs/<timestamp>.md` — the "since you were away" brief
- a git commit `cubicle: heartbeat <id>` inside the vault
- zero `email.sent` / `deploy.done` lines in `.cubicle/events/*.jsonl` (nothing outbound without approval)

`pnpm cubicle status ~/Vaults/Cubicle` summarises jobs and the last heartbeat. `pnpm cubicle stop` checkpoints and exits in under 5 s.

## Known limits at this checkpoint

- Tools with side effects (shell, browser, email, deploy, Stripe, analytics, social, meetings) arrive in Phases 5–6; until then the Engineer can only write files through `vault.write`.
- Sleep detection needs a reachable D-Bus system bus; if it cannot connect within 4 s the daemon logs it and relies on SIGTERM. The delay lock that makes logind wait for the checkpoint is held by a `systemd-inhibit` child (`systemd-inhibit --list` shows `cubicle` while the daemon runs); without `systemd-inhibit` the signal still arrives but the machine may sleep before the checkpoint finishes.
- The office (Phases 8–9) and the tray app (Phase 10) do not exist yet; the WebSocket server on port 7411 already serves snapshots and live events.
