---
id: _template
title: One line naming the opening, not the observation
source: intelligence:competitive
status: new
created: ""
evidence: []
decision: undecided
decided_by: ""
decided_at: ""
score: null
score_inputs: {}
research: ""
research_confidence: null
estimate: ""
board_verdict: null
board_decision: ""
---
# One line naming the opening

## What changed

What is actually different in the world, with the date it changed and where you saw it.

## Why it might matter

What the company could do about it, and what would have to be true for that to be worth doing.

## Evidence

Links to `Research/archive/` snapshots, `Research/intelligence/` files or `Research/<project>/` reports.
An idea with no evidence is a hunch; say so rather than dressing it up.

## Research

The research office's answer: what the investigation found, its confidence, and a link to the report.
It also sets `evidence` (how well the demand is supported) and `fit` (how much this uses what we already have).

## What it would cost

The finance office's rough order of magnitude, in words — people, weeks, money out of pocket — and the
assumption behind it. It also sets `value` (what this is worth if it works) and `effort` (how cheap it is to
try, inverted: 5 is a week, 1 is a quarter).

## The board

The three advisors' joint verdict and the failure modes they named. `pass` or `return`; the board advises.

## Score

`4 × value + 3 × evidence + 3 × effort + 2 × fit`, from 12 to 60. Keep at 44, park at 26, scrap below.
An idea nobody would pay much for (`value` 1–2) parks however cheap it is; an idea the board returned parks
rather than keeps. The number is derived from the four inputs and is never written by hand.

## Decision

`keep`, `park` or `scrap` — the owner's, or the board's when `board_decides_after_hours` has elapsed.
Only a kept idea may appear in `Plans/plan.md`.
