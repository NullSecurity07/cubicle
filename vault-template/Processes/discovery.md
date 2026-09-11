---
name: discovery
steps:
  - { role: research_manager, type: discovery, title: "Read what the owner gave us: {objective}", for: ceo }
  - { role: cfo, type: finance.estimate, title: "What would it cost: {objective}" }
---
How the company finds out what it is for. The daemon runs this on its own on the first cycle — this note is
here so a lead can run it again by hand when the owner drops something new in, and so the steps are readable
without reading the daemon.

Step 1 — read everything, once. `discovery.inputs` returns the files in `Discovery/inbox/`, the founder
interview and every message the owner has typed in the cabin. That is the whole brief; there is nothing else to
go on, and a file it could not read is named so you can say "present but unread" rather than guess.

Then the research lifecycle (`Processes/research_lifecycle.md`), abbreviated to what one job can hold:
`research.start` to open the project, vault memory and `Research/index.md` before the web, `http.fetch
{ archive: true }` and `sources.cite` for every page you lean on.

Two outputs, both required. One `Ideas/<slug>.md` card per candidate idea, filed with `idea.card`, each with
the evidence that points at it — one card per idea, never a digest of several. And `Memory/founder-brief.md`,
filed as a `founder_brief` proposal with all seven sections:

## What the company is
## Who it is for
## What already exists
## What success looks like
## Constraints
## Candidate ideas
## What we do not know

Every claim about what already exists cites the file it came from. Where the owner's material and the interview
disagree, say so rather than picking one. Never invent a customer, a number or a date: the owner will read this
and will know.

Step 2 — price the candidates. The finance office reads each card and answers the two questions only it can:
what this is worth if it works (`value`), and how cheap it is to try (`effort`, inverted — 5 is a week). A rough
order of magnitude in words is the answer; a model is not.

Then the board sits on the best-scoring card, the owner keeps, parks or scraps it, and the next plan draws on
whatever was kept. See `Docs/ideas-handbook.md`.
