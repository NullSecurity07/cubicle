# Ideas handbook

How this company decides what to do next. Condensed for working agents; `Processes/discovery.md` is the steps,
this is the reasons.

## What an idea is, and where they come from

An idea is a candidate the company could pursue — not a decision. Every idea becomes one dossier,
`Ideas/<slug>.md`, filed with `idea.card`. Ideas arrive from three places: **discovery** reads
`Discovery/inbox/` (via `discovery.inputs`) and the founder interview — a transcript in which the CEO answered
the six founder questions itself, tagged `[from the idea]`, `[from the vault]` or `[unstated]`, and the owner
added to or corrected those answers — when the owner drops in new material, and
proposes `Memory/founder-brief.md` alongside its cards; **intelligence** sweeps notice something changed in the
world; and the owner can type one in directly. Wherever it came from, the source goes in the card so a reader
can weigh it — and the source decides what happens next: a sweep's card is listed for the owner and goes no
further until they ask for it (see [The board](#the-board)).

## The dossier's eight sections

`Ideas/_template.md` is the shape every card takes: the opening line, **What changed**, **Why it might
matter**, **Evidence**, **Research**, **What it would cost**, **The board**, **Score**, and **Decision**. One
card per idea, always — a digest covering three ideas in one note cannot be scored, cannot be kept or parked on
its own, and hides the two that were actually good behind the one that was not.

## The score, spelled out

`4 × value + 3 × evidence + 3 × effort + 2 × fit`, each input 1–5, so the total runs from 12 to 60. Keep at 44,
park at 26, scrap below. `effort` is inverted on purpose — 5 means cheap (a week), 1 means expensive (a
quarter) — so every input reads "higher is better" and the arithmetic needs no sign rules.

Worked example: an idea worth trying (`value` 4), decently evidenced (`evidence` 4), cheap to test (`effort` 4,
i.e. about a week), and a reasonable fit (`fit` 3) scores `4×4 + 3×4 + 3×4 + 2×3 = 16 + 12 + 12 + 6 = 46` —
just above 44, so it is kept. The number is derived from the four inputs and is never written by hand;
a card with a `score` nobody can reconstruct from its `score_inputs` is not trustworthy.

## Who fills what

Two offices, two inputs each, so no single office can talk an idea up alone:

- The **research office** sets `evidence` (how well the demand is actually supported — 5 is customers already
  paying someone for it) and `fit` (how much this uses what the company already has).
- The **finance office** sets `value` (what this is worth if it works) and `effort` (how cheap it is to try,
  inverted). A rough order of magnitude in words is the answer; a model is not.

A dossier where only one office wrote is a dossier that is half done.

## The board

The board sits on the best-scoring card, the same three advisors as a plan pre-mortem, in one session (the
heartbeat's `ideas_board` step, recorded as a `board.session` job) — pass or return, with the failure modes named. The board advises; it does not decide.

**It sits only on ideas the owner has seen.** A card whose `source` is `discovery`, `owner`, `pantry` or
`board` (a pivot the board itself proposed) is a candidate as soon as it is scored. A card an
**intelligence** sweep filed is not — nor is one any other job filed on its own initiative (its `source` is
that job's id): nobody asked for it, and a board session on it costs up to seventeen
model calls, a question to the owner and a decision note about something they have never been told about.
Those cards are listed in every brief under **Ideas the sweep found** — title, one line of why, and where to
read them — and nothing else is spent on them: neither office is asked to score one either.

To have the board look at one, the owner sets `decision: keep` in its frontmatter (or says so to the CEO, who
sets it). On a sweep card that flag reads "look at this one", not "we are doing it": the card becomes a
candidate, both offices fill their halves, the board sits on it, and the owner then rules on it in the usual
`idea_verdict` note. `park` or `scrap` on such a card closes it without a session.

## The pressure test

Before the score is read, the board pressure-tests the idea the way a YC partner reads an application:
the core assumption, the three most likely ways it dies, whether the pain is real, founder-market fit, and one
word of verdict — **STRONG**, **WEAK** or **PIVOT REQUIRED**. It comes back with a 0–2 score on five dimensions
out of 10, recorded beside the verdict under `## The board`. `Docs/pressure-test-handbook.md` is the whole of
it, and the phrase "it has potential, but" is refused: the board decides.

The pressure test is advisory and moves no number. A STRONG passes the card; a WEAK or a PIVOT returns it,
which parks the recommendation until the findings are answered — exactly what a board return has always meant.

## The owner's verdict

After the board, the owner rules: `keep`, `park` or `scrap`, recorded under `Decision` with `decided_by` and
`decided_at`. If the owner has not ruled after the configured hours and `board_decides_after_hours` is on, the verdict
resolves with the recommendation the note carries — the band stamped on it when the board sat, which already
accounts for a board `return` — so the company is never stuck waiting on a card forever.

## What a plan may draw on

Only a **kept** idea may appear in `Plans/plan.md`. A plan that names a parked or scrapped idea is returned
before the board even reads it — the decision already happened once, and reopening it silently is worse than
asking again.

## The three mistakes

1. **A digest instead of one card per idea.** Bundling candidates together makes none of them scoreable.
2. **A card with no evidence.** An idea with nothing under `## Evidence` is a hunch; say so rather than
   dressing it up as a dossier.
3. **A number written by hand instead of derived.** `score` always comes from `score_inputs` through the
   formula above — never typed in directly.

## Tools

- `discovery.inputs` — everything discovery has to go on: `Discovery/inbox/`, the founder interview (the
  CEO's own tagged answers plus the owner's `**You:**` additions — attribute each to whoever said it), the
  owner's own words.
- `idea.card` — file or update one dossier at `Ideas/<slug>.md`. Use it instead of `vault.write` so every card
  keeps the same shape.
- `research.start`, `sources.cite` — the research office's usual tools, used here to back `evidence` and `fit`.
