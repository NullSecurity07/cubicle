# Engineering metrics

_Computed by the weekly review from the event log. Never edit by hand — the next review overwrites it._

| measure | value | how it is computed |
|---|---|---|
| Lead time | not enough data | median `job.queued` → the live `deploy.done` of the same job |
| Deployment frequency | 0.00 / week | live deploys over the window |
| Change failure rate | not enough data | rollbacks + returned ships, over deploys |
| Time to restore | not enough data | median `incident.opened` → `incident.recovered` |

## Error budgets

- No active streams yet.

## What these are for

These four describe the delivery system, not the people in it (§31). A measure reading "not enough data" means
the window held nothing to measure — that is information, not a zero.

## What is never measured here

Lines of code. Number of tickets closed. Story points completed. §31: they are trivially gamed and they
encourage the wrong behaviour. If someone asks for one of these, the answer is one of the four above.
