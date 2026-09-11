---
name: research_lifecycle
steps:
  - { role: research_manager, type: custom, title: "Frame and protocol: {objective}" }
  - { role: researcher, type: custom, title: "Existing evidence, then collection: {objective}" }
  - { role: data_scientist, type: custom, title: "Analysis and triangulation: {objective}" }
  - { role: research_manager, type: custom, title: "Synthesis and recommendation: {objective}", for: ceo }
---
The universal research lifecycle (`Docs/research-handbook.md`), expanded when a question is big enough to need more than one pair of hands. Small questions run all of it inside a single `research` job instead; the process is the same, the depth is not.

Step 1 — frame. Call `research.start` to open `Research/<slug>/`. Write `question.md` and then `protocol.md`: method, sources, analysis plan, and the stopping criterion, before anything is collected. Depth scales with impact × uncertainty × cost of being wrong, which is on the request.

If this lifecycle was expanded without a `research` job behind it, file one now with `scheduler.request` (`type: research`, `assigned` the research lead, `for` the decision owner) carrying the whole §33 request: decision, decision owner, question, hypothesis or exploration, known evidence, unknowns, constraints, deadline, required confidence, at least two potential decisions, portfolio, impact, uncertainty, cost of being wrong. That request is the contract the review gates judge against and the row `Research/index.md` keeps; a delivery with no request behind it reaches the institutional index reading "decision: not stated on the request". Say in `protocol.md` which job it is.

Step 2 — existing evidence, then collection. Search vault memory, `Research/index.md` and `Docs/` before the web: the company has often already paid for this answer. Only then gather what is missing, secondary before primary, and archive every page with `http.fetch { archive: true }` and cite it with `sources.cite`. Evidence goes in `evidence/`.

Step 3 — analysis and triangulation. Important conclusions rest on more than one independent source. Where sources agree, confidence rises; where they disagree, the disagreement is itself a finding and goes in the report. Scripts run in the sandbox scratch directory; their output is written back into `analysis/` and `results/`.

Step 4 — synthesis, recommendation, delivery. One recommendation, not three options with no opinion. Every finding carries its evidence, its confidence, its assumptions, its limitations and the contradictory evidence. Stop when more research would not change the decision, and say in `protocol.md` that you stopped and why. Write the synthesis into `report.md`, then finish the `research` job this lifecycle serves — the one the request was filed on — with that recommendation as its result. Its gates take it from there: the research lead checks the evidence, and the requester decides. This step is not itself the delivery; a `research` job without a request behind it is refused, and rightly so.
