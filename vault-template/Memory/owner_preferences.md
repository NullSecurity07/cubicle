# Owner preferences

The CEO reads this every heartbeat. Free text is fine; the `approvals:` block is parsed.

```yaml
approvals: {}
feedback: []
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
