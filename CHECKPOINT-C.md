# Checkpoint C — the company has an org

Teams, leads, review gates, a Critic, a research lab. Everything is markdown you can edit.

## Where the org lives
- `Teams/<team>.md` — lead, members, mission, processes. Edit it; the daemon reloads on the next tick.
- `Roles/<role>.md` — charters now carry `team`, `reports_to`, `title`, `persona`, `permissions`. `Roles/_hireable/` holds charters the CEO can hire from.
- `Processes/<name>.md` — standing pipelines (feature, launch, pricing, weekly_review, new_product, opportunity).
- `config/gates.yaml` — which review a job type passes before it counts.
- `Docs/adr/`, `Docs/research/`, `Docs/postmortems/`, `Docs/tech-radar.md` — the Research Analyst's output.

## A cycle
gather → brand → answer you → meeting → **company.plan** (CEO writes objectives per team) → **critic.premortem** (pass or one return, second veto goes to you) → **team.plan** per lead (≤ 4 jobs each, with Done when) → jobs → gates (QA → COO for engineering; requester for research) → brief with "Next action per team" → commit.

## Try it
```bash
pnpm cubicle start ~/Vaults/Cubicle      # migrates an old vault to the default org on first start
pnpm test:acceptance                      # includes tests 10 (planning fan-out) and 11 (Org drawer)
pnpm test:kill9                           # kill -9 during team.plan → resumes, no duplicate jobs
```
Open the office → **Org** in the top bar. Ask the CEO to "move QA under operations" and approve the `reorg` proposal in `00 Inbox/`.
