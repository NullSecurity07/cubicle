# Workspace

One directory per stream: `Workspace/<slug>/` holds that product's source. Trunk-based — small changes on
`main`, incomplete work behind a flag in `flags.json` (owner's operating model §16, §21).

Each stream carries a `cubicle-ci.yaml` that `ci.run` executes in the sandbox:

```yaml
# Workspace/<slug>/cubicle-ci.yaml
network: none            # or `allowlist` when a step needs npm/GitHub/jsDelivr
timeout_s: 300
steps:
  - { name: build,          run: "npm run build" }
  - { name: lint,           run: "npm run lint" }
  - { name: test,           run: "npm test" }
  - { name: security-scan,  run: "npm audit --audit-level=high", allow_failure: true }
```

`ci.run` writes one record per run to `Workspace/<slug>/.cubicle-ci/<timestamp>.json`. An `engineer.ship` job
cannot finish without a green record newer than every source file in the stream, and `team:qa.review` reads it.

`flags.json` lives beside `cubicle-ci.yaml`:

```json
{ "flags": [ { "key": "new_checkout", "owner": "backend_engineer", "state": "off", "created": "2026-09-11", "remove_by": "2026-10-09" } ] }
```

A flag past its `remove_by` becomes a lesson in `Memory/lessons.md` — abandoned flags are the technical debt
§21 warns about.
