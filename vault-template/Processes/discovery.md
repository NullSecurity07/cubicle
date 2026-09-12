---
name: discovery
---
How the company finds out what it is for. This note is the readable version; the daemon runs the real thing.

**It has no `steps:`, on purpose.** The daemon queues the discovery job itself, with an id derived from a
digest of the material, so the same material can never queue a second job. A `process: discovery` line in a
plan would mint fresh random ids that idempotence cannot see — a second full research lifecycle over material
already read, plus a `finance.estimate` job naming no card at all. To run discovery again, give the company
something new to read: drop a file in `Discovery/inbox/`, or answer the founder interview. Either wakes the
heartbeat, and the next cycle reads it.

Read everything, once. `discovery.inputs` returns the files in `Discovery/inbox/`, the founder
interview and every message the owner has typed in the cabin. That is the whole brief; there is nothing else to
go on, and a file it could not read is named so you can say "present but unread" rather than guess.

Then the research lifecycle (`Processes/research_lifecycle.md`), abbreviated to what one job can hold:
`research.start` to open the project, vault memory and `Research/index.md` before the web, `http.fetch
{ archive: true }` and `sources.cite` for every page you lean on.

Two outputs, both required. One `Ideas/<slug>.md` card per candidate idea, filed with `idea.card`, each with
the evidence that points at it — one card per idea, never a digest of several. And `Memory/founder-brief.md`,
filed as a `founder_brief` proposal with all eight sections:

## What the company is
## Who it is for
## What already exists
## What success looks like
## Constraints
## Candidate ideas
## What we do not know
## Pressure test

`## Pressure test` is the Paul Graham test run on the company itself, once: the core assumption, the three most
likely ways it dies, whether the pain is real, founder-market fit, and one word — STRONG, WEAK or PIVOT
REQUIRED. `Docs/pressure-test-handbook.md` is the whole of it. Re-run it whenever the brief changes materially;
the core assumption moves when the customer moves.

Every claim about what already exists cites the file it came from. Where the owner's material and the interview
disagree, say so rather than picking one. Never invent a customer, a number or a date: the owner will read this
and will know.

Then the cards are filled in from both sides, one office each. The finance office (`finance.estimate`) answers
the two questions only it can: what this is worth if it works (`value`), and how cheap it is to try (`effort`,
inverted — 5 is a week). A rough order of magnitude in words is the answer; a model is not. The research office
(a follow-up `research` job) answers the other two: how well the evidence supports the demand (`evidence`) and
how much of what the company already has this would use (`fit`), with the report and its confidence. Neither
office may write the other's numbers — that is the whole reason there are four of them.

Then the board sits on the best-scoring card, the owner keeps, parks or scraps it, and the next plan draws on
whatever was kept. See `Docs/ideas-handbook.md`.
