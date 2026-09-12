---
title: Money
---
# How money works here

The company has one book, `Ledger/ledger.md`, and one page of arithmetic over it, `Ledger/runway.md`. Read both
before you say anything about what the company can afford.

## The book

Three kinds of row. `capital` is money the owner put in. `revenue` is money coming in. `cost` is money going
out. Amounts are always positive — the kind carries the sign — with at most two decimal places, in the currency
named at the top of the file.

Two rules matter more than the rest:

- **It is append-only.** Nothing edits a row that is already there. If a row is wrong, record the opposite row
  and say so in `why`. An append-only book that can be rewritten is not append-only.
- **`mode` says whether the money really moved.** `live` means it did. `mock` means it did not — a simulated
  sale, a service we are pretending to pay for. Mock rows are reported separately and are **never** counted as
  cash. A runway computed from money nobody paid is worse than no runway.

Use `ledger.record` to add a row. You cannot record `capital`: only the owner puts money in. If the company
needs money, say so with `proposal.create` and let them decide.

## Cash, burn, runway

- **Cash** is live capital plus live revenue minus live cost.
- **Burn** is live cost over the last 30 days, divided by however long the company has actually existed for.
- **Runway** is whole days of cash at that burn — or "not spending" when nothing is costing anything, which is
  the honest answer today and is not the same as infinite.

You never calculate these. The daemon does, and puts them in `Ledger/runway.md` and in the brief. If you find
yourself deriving a figure, you are about to publish a wrong one.

## What models cost

Every provider we use is on a free tier, so the models cost nothing. `config/providers.yaml` can carry a
`price:` per model so the CFO can say what a cycle *would* have cost on a paid tier; that number appears in
`Ledger/runway.md` and is never a ledger row, because no money moved.

## The model quota

Each day's free calls at the strong and medium tiers are split between the divisions, with a quarter reserved for
the house — the heartbeat, the board, the gates, security. A division past its quota drops to the cheapest tier.
It does not stop, and it is not in trouble; it is doing the same work with a smaller model. The split is on the
bank screen and in `Ledger/runway.md`.

Both halves of that gauge — what a division may spend and what it has spent — are read from
`config/providers.yaml` as it stands right now, so removing or renaming a model there mid-day drops that day's
calls on it from the count and leaves the divisions a little over-budget until the window resets at UTC
midnight.

## When the money runs out

Cash at or below zero, in a company the owner has funded, is dormancy: the daemon starts nothing but the
heartbeat, the CEO sends one message explaining where the money went, and a `capital` row brings it all back.

A company nobody has funded is **not** dormant. It has zero cash and runs perfectly well, because everything it
uses is free. That is the normal state of this system, not a problem to be solved.
