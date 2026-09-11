# CUBICLE

A local-first "company that runs itself" on your laptop. You type a one-line business idea; a team of LLM agents (CEO, CTO, Engineer, Growth, COO, plus anyone they hire) builds a website, finds customers, ships improvements, measures, and writes you a brief — working whenever the laptop is on, checkpointing every step so a closed lid never loses work. **An Obsidian vault is the single source of truth**: every plan, job, decision, customer and lesson is a markdown note you can read and edit. A pixel-art office shows what is happening.

Everything runs on free tiers (Gemini/Groq/OpenRouter free models, Ollama locally, Brevo, Cloudflare Pages, Stripe links, GoatCounter). Nothing outbound — no email, post or deploy — happens without your approval unless you loosen the rules.

## Requirements

- Linux (built and tested on CachyOS/Arch), Node ≥ 20 (26 used), pnpm 11 (`npm i -g pnpm@11 --prefix ~/.local` if global installs need sudo)
- [Ollama](https://ollama.com) with `qwen2.5:7b` and `nomic-embed-text` — the always-available floor
- Docker (the Engineer's sandbox); without it `shell.run` is refused unless you opt into a bubblewrap-jailed local shell
- Obsidian, to open the vault (optional: everything is plain markdown)
- A Gemini API key makes the company fast and smart; see [SETUP.md](SETUP.md) for every free account and env var

## Quick start

The short way: `scripts/run.sh` (or `pnpm launch`) checks Node, pnpm, Ollama and Docker, builds only what is stale, scaffolds `~/Vaults/Cubicle` if needed, then launches the tray when your desktop has a tray host or a background daemon plus the office in your browser otherwise. `scripts/run.sh status|stop|logs` do what they say; `--tray`, `--headless`, `--no-open` override the guesses.

The long way, step by step:

```bash
pnpm install && pnpm -r build && pnpm --filter @cubicle/viewer build
docker build -t cubicle-sandbox config/sandbox          # or: pnpm cubicle doctor --build-sandbox
cp .env.example .env                                     # add GEMINI_API_KEY (and any other free keys)
pnpm cubicle doctor                                      # what works, what runs in mock mode
pnpm cubicle init ~/Vaults/Cubicle                       # scaffold the vault + git repo; open the folder in Obsidian
pnpm cubicle start ~/Vaults/Cubicle                      # daemon; prints the office URL (with its token)
pnpm cubicle open ~/Vaults/Cubicle                       # launch the office in your browser
```

The office is one tall map: four floors stacked as a cross-section — F1 executive (CEO office, meeting room, board room, pantry), F2 departments (Research, Dev, Sales, CHRO), F3 assurance (CLO, CISO, CGO, QA), F4 leadership (CTO, CMO, COO, CFO) — an elevator on the right and the street below; a floor rail shows all four plus the lobby, click a tab or press `1`–`4` (`L` for the lobby, `0` to fit the tower). On a fresh company a card asks "What company will you start?" — type your idea or press "Surprise me" — and it goes to the CEO like any chat; afterwards the CEO office, the CEO sprite, "Talk to the CEO" and `T` all reach the same chat. Click any room screen to open it (the billboard opens a live browser viewer, the Dev terminal a live shell) or any sprite for its sheet; everything opens into one stacked panel, so `Esc` always backs out exactly one level, `Ctrl/Cmd+K` or `/` jumps anywhere, and `?` lists every shortcut. The chrome follows your OS light/dark theme (`?theme=light|dark` overrides it). `pnpm office:shot` (screenshots checked against `docs/office-visual-checklist.md`) and `pnpm test:overlay` (click isolation) are the visual gates — both build the viewer first. Or, in Obsidian, create a note in `00 Inbox/`:

```markdown
---
id: msg_my_idea
kind: message
from: owner
to: ceo
answered: null
---
A one-page site selling a printable weekly meal-planning template for busy parents.
```

Within one tick (≤ 30 s) heartbeat #1 runs: the CEO answers you and proposes a company name in `00 Inbox/` (set `approved: true`), the CTO writes `Plans/plan.md` and queues jobs, the Engineer scaffolds `Site/`, Growth researches a channel, the COO verifies, and `Runs/<timestamp>.md` is your "since you were away" brief. Every heartbeat ends with a git commit inside the vault (`cubicle: heartbeat <id>`), so you can always revert.

Tray app (Tauri): build it once with `pnpm -r build`, then `pnpm --filter @cubicle/app start` — start/stop the daemon, open the office/vault, and checkpoint before your laptop sleeps. It needs Rust and `webkit2gtk-4.1 libappindicator-gtk3 librsvg` (see SETUP.md).

## How the vault works

`docs/vault-schema.md` lists every folder and frontmatter contract. The parts you will touch:

| You want to… | Do this |
|---|---|
| talk to the CEO | cabin chat in the office, or a `kind: message` note in `00 Inbox/` |
| approve or reject something | set `approved: true` / `false` on the proposal note in `00 Inbox/` (the daemon acts on the next tick) |
| change the brand | edit `Brand/name.md`, `palette.md`, `voice.md`, `logo.png` (scaffolded as a placeholder on `cubicle init`) — the Engineer reconciles the site on the next heartbeat |
| edit the site yourself | edit anything under `Site/`; the Engineer never reverts your edits and asks you when they collide |
| add / cancel / reprioritise a job | copy `Jobs/_template.md`; set `status: cancelled`; change `priority` |
| pause a job | set `status: blocked` (no `blocked_on`) |
| change a role | edit `Roles/<role>.md` (model tier, tools, approval overrides, the charter itself) |
| set hard rules | `Memory/constitution.md` — agents cannot edit it; the tool layer enforces it |
| loosen or tighten approvals | the `approvals:` block in `Memory/owner_preferences.md` |
| give feedback | `%%cubicle: …%%` comments in any note, `feedback:` lines in preferences, `owner_rating: up|down` on decisions |

## Approval modes

Every tool has a mode in `config/tools.yaml`: `auto` (runs), `propose` (files a proposal and the job continues; the daemon runs the stored call once you approve), `ask` (the job waits for you), `never`. Roles may tighten modes in their charter; you may loosen or tighten anything in `owner_preferences.md`, except a config-level `never`. Defaults: internal work is `auto`; `email.send`, `social.post`, `browser.submit` are `ask`; `deploy.site` and `stripe.payment_link` are `propose` (the first deploy needs you, later ones run automatically).

Outbound tools carry idempotency keys and are at-most-once: a crash mid-send never sends twice.

## Models and quota ("runway")

`config/providers.yaml` is the only place model ids live. The router cascades gemini → groq → openrouter → ollama, same tier first, and downgrades only when every same-tier option is exhausted or cooling from a 429. The Bank in the office (and `Metrics/quota.md`) shows free calls remaining per provider. `pnpm cubicle providers test` pings every model; `pnpm cubicle providers refresh` pulls the current OpenRouter `:free` list.

## CLI

```
cubicle init <vault>                 scaffold a vault
cubicle start|stop|status|open       daemon and office
cubicle heartbeat                    force a heartbeat (runs inline if the daemon is off)
cubicle providers test|refresh       models
cubicle job add|cancel|list          queue
cubicle replay <date>                event summary for a day
cubicle doctor [--live]              environment and keys; --build-sandbox builds the Docker image
cubicle rebuild                      rebuild the .cubicle cache from the vault + event log
cubicle memory rebuild|search        embedding index over Memory/, Skills/, Decisions/
cubicle chat [--tier t] <prompt>     one completion through the cascade (debug)
```

## The org

The company is a real org, not a flat list of roles: a tower of divisions and rooms (`Teams/<team>.md`), leads, review gates (`config/gates.yaml`), a three-advisor board that pre-mortems every plan, and a Research department that writes ADRs and research notes. One cycle of planning goes: the CEO writes objectives per *division* in `Plans/plan.md` → the board (skeptic, investor, customer) imagines the cycle has already failed and returns one merged verdict, filed as a `Decisions/premortem-*.md` note → **you** rule on the plan in `00 Inbox/` (`approved: true|false`; work already approved keeps running while you decide, only new work waits) → each division lead turns their objective into up to four jobs with a "Done when", handing a room's work to the room. A job counts as accepted only once it clears its gate, and every gate is addressed by *office* or by room (`team:qa.review`, `office:operations.verify`, `office:security.review`, the requester for research), so re-staffing a seat in `Memory/constitution.md` re-routes the company without a code change. See [CHECKPOINT-C.md](CHECKPOINT-C.md) for the full picture, how to open the **Org** drawer in the office, and how to reorganize a team through a `reorg` proposal.

Colleagues ask each other questions with `colleague.message(kind: question)`; asking creates a `colleague.answer` job for the recipient so the question is real, tracked work, not a fire-and-forget message. If nobody answers within two heartbeat intervals, the question escalates to the asker's own division lead — or to whoever holds the chief executive's office when there is no usable one: the asker's job is unblocked, a `colleague.answer` job is created for that role, and their `Messages/<role>.md` gets a handoff note naming the asker, the recipient and the question.

## Tests and acceptance

```bash
pnpm -r test                 # unit + integration (offline: mocks, local servers, headless Chromium, local sandbox)
pnpm test:kill9              # kill -9 mid-job → resume, no duplicate side effects
pnpm test:sleep              # SIGTERM and PrepareForSleep → checkpoint + exit < 5 s → resume
pnpm test:replay             # close viewer, browse, reopen → replay shows frames on the billboard
pnpm test:acceptance         # tagged spec §14 cases (tests 1–4, 6–11; test 5 is live-only)
CUBICLE_LIVE=1 pnpm --filter @cubicle/harness test  # spec §14 test 5, against a local Ollama
scripts/acceptance-all.sh    # everything above on a fresh clone
```

## Layout

`packages/core` (vault, events, schemas) · `router` (models, quota) · `tools` (MCP tools, adapters, sandbox, browser, guardrails) · `harness` (agent loop, memory) · `daemon` (workers, heartbeat, dispatcher, WS, CLI, doctor) · `viewer` (Phaser office) · `app` (tray). Design deviations and their reasons are in [DECISION.md](DECISION.md); the build plan in [PLAN.md](PLAN.md); the event catalogue in [docs/events.md](docs/events.md).
