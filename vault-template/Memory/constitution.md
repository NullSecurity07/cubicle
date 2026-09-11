# Constitution

Hard rules. Agents cannot edit this file; the tool layer enforces the block below on every call.

```yaml
max_emails_per_day: 20
banned_channels: []
banned_tactics:
  - fake urgency
  - fabricated testimonials
  - impersonation
max_roles: 40
auto_approve_hire: false
auto_approve_charter_changes: false
pii_local_only: false
never_modify:
  - Memory/constitution.md
  - Memory/owner_preferences.md
  - Brand/
  - Roles/
  - Teams/
max_team_size: 8
auto_approve_reorg: false
offices:
  chief_executive: ceo
  finance: cfo
  operations: coo
  security: ciso
  compliance: clo
  people: chro
  research: research_manager
  engineering: cto
board_decides_after_hours: 0
```

## Notes

- `pii_local_only: true` forces any job that touches `Customers/` or email to run only on the local model.
- `banned_tactics` is checked by a local classifier on every outbound text.
- `max_roles` caps headcount including the founding roster (33 active seats; the five Sales desks are placeholders until the sales pass).
- `max_team_size` caps how many members a lead can hold before a `reorg` proposal is required; `auto_approve_reorg` gates whether that proposal needs the owner.
- `offices` maps each office the daemon addresses to a role id: gates, escalation and planning ask for the office, so re-staffing a seat is an edit here, not a code change.
- `board_decides_after_hours` is off (`0`): a plan waits in `00 Inbox/` for your verdict for as long as it takes, and work you already approved keeps running while it waits — only new work stops. Set a number of hours to let the board's own verdict stand after that long, which is what an unattended overnight run wants.
