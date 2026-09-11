# Engineering handbook

The owner's *Universal Company Development & Engineering Operating Model*, condensed to what you act on. Each
rule cites its section there; read the source when a case is not covered. If this handbook and the document
disagree, the document wins and this file is wrong — say so in your job's lessons.

## The one idea (§2, §41)

Build toward measurable outcomes, in small steps, with the feedback loop as short as you can make it. Everything
below is that idea applied to one part of the work.

## Teams (§9, §10, §11)

The Dev room is a stream-aligned team: it owns one product end to end, from the problem to production. The QA
room is the quality system, not a gate you throw work over. Small and stable beats large and reshuffled. Nobody
is "the frontend person" for a job the team owns.

## Streams (§5, §21)

Every product is a stream: `Streams/<slug>.md` — the problem in the customer's words, who exactly buys it, the
outcome metric with a from and a to, the owning team, the error budget, the runbook, the repo path. Its code
lives in `Workspace/<slug>/`.

An objective is an outcome, never a feature list. "Raise checkout completion from 72 % to 82 %" is an
objective. "Build the new checkout" is a task list wearing an objective's clothes. Every job states its
`done_when` as something a stranger could check.

## Flow: Kanban and WIP (§7)

```
Backlog → Ready → In Progress → Review → Testing → Ready for Release → Done
```

Your lane is derived from the job's status and the gate it still owes; nobody sets it by hand. `Teams/<id>.md`
carries the limits — three in progress, two in review, two or three in testing. The dispatcher will not start a
fourth job while three are in progress, and the room sign turns that lane red.

The objective is not to keep everyone busy. It is to keep valuable work flowing. When a lane is full, the useful
move is to finish or return something, not to start something else.

## Development: Trunk-based (§16)

Small changes onto `main`, often. No long-lived branches. Work that is not finished ships disabled behind a
feature flag in `Workspace/<slug>/flags.json`. Feature flags decouple deploy from release: the code can be on
`main` and in production, dark, while it is still being built. Every flag has an owner and a `remove_by` date,
and a flag past its date becomes a lesson with your name on it (§21).

## CI: the gate (§17, toolchain §45)

`Workspace/<slug>/cubicle-ci.yaml` declares the pipeline: build, lint, test, security scan. Run it with
`ci.run({ stream })`. It writes a record to `Workspace/<slug>/.cubicle-ci/`.

**An `engineer.ship` cannot finish without a green record newer than every source file in the stream.** The
harness refuses the finish and tells you which file moved. This is not bureaucracy: the longer a problem stays
undetected, the more it costs.

## Quality (§18)

Automated first. Quality is shared across engineering; QA owns the strategy, not the blame. Anything you check
by hand twice becomes a job for `qa_automation`. A green build is not a pass — the job's `done_when` is.

QA returns a job at most once per gate; the second return fails it. Every finding cites a file or an output
line.

## Delivery: progressive (§19, §20)

`deploy.site` goes in stages: **preview → canary → live**. Canary needs a preview first; live needs a canary.
Both must name the metrics they will watch — error rate, latency, the stream's outcome metric, resource use.
The canary percentage is recorded, not enforced: real traffic splitting does not exist yet, and pretending it
does would be worse than saying so.

`deploy.site({ rollback: true })` republishes the previous live deploy. Roll back first, debug second.

## Risk-based governance (§26, §27)

Every job that changes the product states a `risk`, set by whoever schedules it with `scheduler.request`:

| risk | what it covers | what it adds |
|---|---|---|
| `low` | text, UI, minor bug fixes | automated guardrails only |
| `medium` | data, significant backend, new external integrations | a `security.review` gate before QA |
| `high` | auth, money, destructive migrations, core infrastructure | a `threat_model` proposal the owner approves |

Pick the highest level any part of the change touches. Guardrails run on every level and never ask: secrets
cannot be committed or deployed, required tests must pass, owner-edited files are read-only.

The higher the risk, the stronger the human governance. A copy tweak must not carry a migration's process.

## Operations and reliability (§22, §23, §33)

You run what you build. Each stream has an error budget in incident-hours per week. When it is spent, the next
division plan prioritises reliability over features — that is not a suggestion, the plan says so.

Incidents go: detect → triage → mitigate → recover → root cause → corrective actions → learning. A rolled
back deploy opens one automatically. The postmortem goes in `Docs/postmortems/` and is **blameless**: the
question is how the system allowed this, never who to punish. The other half of that bargain is strong ownership
of the corrective actions, which become jobs.

## Decisions (§34, §35, toolchain §8)

Decide at the lowest competent level. You pick your implementation technique; the dev manager shapes the
subsystem; the CTO sets what crosses teams; the owner decides direction. Escalate when the decision crosses
teams, the risk is high, significant resources are involved, or strategy is affected.

Record architecture decisions as an ADR with `adr.create` — context, decision, alternatives, consequences, date,
owner. The alternatives are the part organisations forget and the part that is worth most later. QA returns a
ship that changed the architecture without one.

Documentation exists where it prevents repeated confusion. Do not document what the code already says.

## Measurement (§31)

Four measures, computed weekly from the event log into `Metrics/engineering.md`: Lead time, deployment
frequency, change failure rate, time to restore. They describe the delivery system, not the people in it.

Lines of code, tickets closed and story points are never measured here. They are trivially gamed and they
encourage the wrong behaviour.

## Adding anything new (toolchain §53)

Before a new library, service or tool: check `Docs/tech-radar.md`. Ten questions, and a "no" on self-hosting,
export or a migration path is usually a "no" on the tool. Prefer the boring thing already in the codebase.
