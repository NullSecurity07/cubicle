# Research handbook

How this company does research. Condensed for working agents from the owner's operating model
(`docs/owner/research-operating-model.md`); the section marks point back at it when you need the argument
rather than the rule.

## Why research exists (§1–§4)

Research reduces uncertainty that is blocking a decision. It is not information collection. Every project
starts from a decision someone has to make, and ends with a recommendation that person can act on. Research
owns the investigation; the requester owns the decision. A beautiful report nobody can decide from is waste.

Hypothesis-driven when the question can be sharpened into something evidence could disprove; exploratory when
the honest position is "we do not know what is happening" (§3). Forcing exploration into a fake hypothesis
invents assumptions.

## The request (§33)

No research job is queued without one. `scheduler.request(type: "research", ...)` refuses an incomplete
request by name, so if you are refused, read what it says and fill in what it lists:

| field | what it is |
|---|---|
| decision | the decision this research informs, in one sentence |
| decision owner | the role who will make it and who the report is for |
| question | the single question, sharp enough that evidence could settle it |
| hypothesis *or* exploration | what you believe and could be wrong about, or one line saying you do not know yet |
| known evidence | what the company already believes, and where that came from |
| unknowns | the gap the research has to close |
| constraints | time, money, tooling — "none" is a valid answer |
| deadline | when the decision has to be made |
| required confidence | high / medium / low |
| potential decisions | at least two: proceed, modify, delay, stop, investigate further |
| portfolio | incremental, adjacent or exploratory (§21) |
| impact, uncertainty, cost of being wrong | 1–5 each |

## Prioritisation and depth (§29)

Priority = impact × uncertainty × cost of being wrong. The queue orders by it automatically. It also sets
**depth**: a score of 8 is an afternoon inside one job; a score of 100 is worth expanding
`Processes/research_lifecycle.md` into a chain and triangulating properly. The process scales in depth, never
in shape.

Keep a slice of capacity for exploratory work (§21). A company that only researches its current problems is
blind to the change that ends it.

## The lifecycle (§24)

Question → frame → hypothesis or exploration → plan → existing evidence → method selection → collection →
verification → analysis → synthesis → recommendation → decision → action → measurement → knowledge capture.

Every research job runs all fifteen. A small one runs them in an hour.

## Opening a project

Call `research.start` first. It creates `Research/<slug>/` with `README.md`, `question.md`, `protocol.md`,
`sources.bib`, `evidence/`, `analysis/`, `results/` and `report.md`, pre-filled from the request. Re-running
it never overwrites your work.

Write `protocol.md` **before** collecting anything: method, sources, analysis plan, stopping criterion. A
protocol written afterwards is a rationalisation of what you happened to find.

## Existing evidence first (§9)

Before fetching anything: `memory.search`, then `vault.search` over `Research/`, then `Research/index.md`,
then `Docs/`. The company has often already paid for this answer. Existing evidence can still be stale,
biased or built on different assumptions — it is evidence, not certainty.

## Method selection (§8–§12, §28)

Secondary research first. Targeted primary research for the specific gap secondary cannot close — the
smallest activity that produces credible evidence, not a survey of everything. An experiment when the riskiest
assumption is cheaply testable: hypothesis → smallest credible test → measure → analyse → decide. Say in
`protocol.md` which you chose and why the cheaper one was not enough.

## Evidence and triangulation (§19)

Important conclusions rest on more than one independent source. Agreement raises confidence; disagreement is
itself a finding and belongs in the report, not in a footnote. Small decisions do not need extensive
triangulation — depth matches the score.

## Confidence (§20)

Every finding states: the finding, its evidence, its confidence (high / medium / low), the assumptions it
rests on, its limitations, and the contradictory evidence. "High confidence" with no evidence line is an
opinion wearing a suit. If the confidence you reached is below the confidence the requester needed, say so in
the executive summary, not at the bottom of page four.

## The report (§34)

`report.md` ships with the universal output as its headings: executive summary, decision required, question,
context, hypotheses, methodology, evidence, analysis, findings, contradictory evidence, limitations,
confidence, risks, alternatives, recommendation, decision, follow-up measurements, supporting evidence. Set
the `confidence:` and `method:` fields in its frontmatter — the weekly metrics read them, and an unset field
reads as `unstated` rather than being guessed.

One recommendation, not three options with no opinion.

## Stopping (§39)

Stop when the evidence supports the decision at the required confidence, or when the honest answer to "would
additional research materially change the decision?" is no. Record which of the two applied under
`## Stopping decision`. Stopping early is a risk; running on is waste.

## Review (§35)

A `research` job passes two gates. First `research.review`, run by the research lead: evidence sufficiency,
bias, contradictory evidence, confidence. Then `requester.review`, run by the decision owner. Expect to be
returned once; a second return from the same gate fails the job.

## Continuous intelligence (§13–§17)

Four standing sweeps run at most once a calendar day — competitive, market, technology, security — and land in
`Research/intelligence/<date>-c<cycle>-<kind>.md`, e.g. `2026-09-11-c004-competitive.md`. The cycle is in the
name because two heartbeats can land on the same day and neither sweep may overwrite the other; the job's goal
always names the exact file to write. The rule is **detect meaningful change, not collect everything**. A
meaningful change is one that changes what the company should do. Everything else goes under
`## Noise ignored` in one line, which is how the next sweep knows you looked.

A meaningful change that suggests something the company could do becomes a card in `Ideas/`. One that someone
needs to know now becomes a line under `## Alerts` and a `colleague.message`.

## Knowledge (§23, §41)

Every delivered project gets a row in `Research/index.md` automatically, and a follow-up note with a due date.
Two weeks later a measurement job asks whether the recommendation was right and appends
`## Prediction vs reality` to the report. "Cannot tell yet" is an allowed answer; an invented outcome poisons
every confidence estimate the company makes afterwards.

`Metrics/research.md` is regenerated weekly: reuse rate, time to answer, and how many measured decisions went
as expected. Number of reports is deliberately not measured.

## Tools

- `research.start` — open the project directory. First call of any research job.
- `sources.cite` — one BibTeX entry per source, deduplicated by URL. Cite the key in the report so a claim can
  be walked back to where it came from.
- `http.fetch { archive: true }` — fetch and snapshot. The page will change; the snapshot in
  `Research/archive/` will not. Pass its path to `sources.cite` as `archive`.
- `memory.search`, `vault.search`, `vault.read` — existing evidence, always before the web.
- `shell.run` — python and sqlite for quantitative work. **It does not mount `Research/`.** Work in the
  scratch directory (`cwd: "scratch"`, which is `/work/scratch`), then `vault.write` your script and its
  output into `Research/<slug>/analysis/` and the tables into `results/`. An analysis whose script is not in
  the project directory is not reproducible.

## Roles (§30)

These are roles, not job titles; one agent can hold several.

| agent | taxonomy roles |
|---|---|
| research_manager | Head of Research, Research Lead, Research Ops, Knowledge Manager |
| researcher | Researcher — investigation, evidence gathering, synthesis |
| research_analyst | Research Analyst — structured analysis, calibration, forecasting |
| data_scientist | Data Scientist and Research Scientist — statistics, modelling, experiment design |
| intelligence_analyst | Intelligence Analyst — competitive, market, technology, security |
| research_engineer | Research Engineer — infrastructure, automation, datasets, tooling |

Domain specialists are federated: any chief can be attached to a research project. Ask the research manager to
pull one in rather than guessing at their domain.

## The whole thing in one line (§45)

Start from the decision, use what the company already knows, generate only the evidence that is missing,
triangulate what matters, say how sure you are and what would change your mind, recommend one thing, and come
back later to find out whether you were right.
