# Constitution

Hard rules. Agents cannot edit this file; the tool layer enforces the block below on every call.

```yaml
max_emails_per_day: 20
banned_channels: []
banned_tactics:
  - fake urgency
  - fabricated testimonials
  - impersonation
max_roles: 8
auto_approve_hire: false
auto_approve_charter_changes: false
pii_local_only: false
never_modify:
  - Memory/constitution.md
  - Memory/owner_preferences.md
  - Brand/
  - Roles/
```

## Notes

- `pii_local_only: true` forces any job that touches `Customers/` or email to run only on the local model.
- `banned_tactics` is checked by a local classifier on every outbound text.
- `max_roles` caps headcount including the founding five.
