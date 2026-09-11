---
incident: ""
stream: ""
opened: ""
recovered: ""
severity: minor
budget_hours: 0
owner: sre
---
# Postmortem: <what the customer saw>

Blameless (operating model §33). The question is how the system allowed this, never who to punish. No personal
names anywhere in this note; strong ownership of the corrective actions below is the other half of that bargain.

## Timeline

| time (UTC) | what happened | how we knew |
|---|---|---|
|  |  |  |

## Impact

Who was affected, for how long, and what it cost. Hours against the stream's error budget.

## Root cause

Why the system allowed it. Keep asking "and what let that happen?" until the answer is a design, a default or a
missing check — never a person.

## Corrective actions

- <one concrete change> — owner: <role>
- <one concrete change> — owner: <role>

Each becomes a job. The daemon reads this section.

## What we learned

One sentence that would have prevented this, written so the next person recognises the shape.
