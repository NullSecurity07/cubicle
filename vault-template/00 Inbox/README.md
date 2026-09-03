# Inbox

This folder is the conversation between you and the company.

- **Write to the CEO**: create a note with `kind: message` (or just use the cabin chat in the office). Nothing else is required — `id`, `created`, `from: owner`, `to: ceo` are filled in when the CEO answers under a `## CEO` heading. A note the daemon cannot read shows up as a `daemon.warning` event instead of being ignored.
- **Proposals** land here when an agent needs your approval (`kind: hire | fire | brand_change | charter_change | file_change | spend | outbound_batch`). Set `approved: true` or `approved: false` in the frontmatter; the daemon acts on the next tick and stamps `resolved_at`.
- Nothing outbound (email, posts, deploys) happens until you approve it here, unless you loosen the approval modes in `Memory/owner_preferences.md`.
