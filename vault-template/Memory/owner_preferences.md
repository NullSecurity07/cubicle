# Owner preferences

The CEO reads this every heartbeat. Free text is fine; the `approvals:` block is parsed.

```yaml
approvals: {}
feedback: []
shell_local_fallback: false   # true = allow a bubblewrap-jailed local shell when Docker is unavailable
```

## How I like to work

- Tell me what needs me at the top of every brief.
- Prefer boring, reversible choices.

## Approval overrides (examples)

```text
approvals:
  email.send: ask        # auto | propose | ask | never
  deploy.site: propose
  social.post: never
```
