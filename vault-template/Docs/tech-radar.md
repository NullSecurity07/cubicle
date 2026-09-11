# Tech radar

What the products this company builds are made of, and how anything new gets on the list. From the owner's
*Self-Hosted Company Technology & Development Toolchain*: the reference stack (§3), the minimum stack (§54) and
the ten selection criteria (§53).

Kept by the CTO with the research manager, after every technical report. Moving something between rings is an
ADR (`adr.create`). The radar is not a wishlist: everything in Adopt is something a stream has actually run in
production, and everything in Hold is something someone already wanted and was told to wait on.

## The rule that comes first (§2, §57)

**One primary tool per job.** Two tools doing the same job is not redundancy, it is two things to operate, two
places to look and two sets of credentials. Pick one, write down why, move on.

Concretely: if a stream wants a second cache, a second CI runner or a second metrics store because the first one
is momentarily inconvenient, that is a sign the underlying problem was not understood, not a sign the radar is
wrong. Raise it as an ADR and let the CTO decide whether the rule bends or the problem gets solved another way.

## Adopt

The defaults. Use these unless an ADR says otherwise for this stream.

| function | tool |
|---|---|
| Database | PostgreSQL |
| Cache | Valkey (Redis-compatible) |
| Containers | Docker or Podman |
| Reverse proxy | Caddy |
| Git hosting and review | Forgejo |
| CI | Woodpecker CI or Forgejo Actions |
| Infrastructure as code | OpenTofu |
| Configuration management | Ansible |
| Metrics | Prometheus |
| Dashboards | Grafana |
| Logs | Loki |
| Tracing | OpenTelemetry + Tempo or Jaeger |
| Error tracking | Sentry |
| Security scanning | Semgrep (SAST) + Trivy (containers, dependencies) + Gitleaks (secrets) |
| Dependency updates | Renovate |
| Backup | Restic |
| Object storage | MinIO |
| Docs and diagrams | Markdown + Mermaid + draw.io |
| API testing | Bruno |
| Static sites | Astro or plain HTML, published to Cloudflare Pages (free tier) |

Metrics, dashboards, logs and tracing are one observability stack, not four separate decisions: Prometheus scrapes,
Grafana renders, Loki holds logs, and OpenTelemetry carries traces into Tempo or Jaeger. Adopting one without the
others is half an incident response.

## Trial

Worth one stream's experiment, with a named owner and a date to decide.

| function | tool | why it is only a trial |
|---|---|---|
| Message broker | NATS | nothing we run needs a broker yet; adopt when two services must not call each other directly |
| Orchestration | Kubernetes / k3s | only when more than one machine and more than a handful of services justify it (§21 of the toolchain: the critical rule) |
| GitOps | Argo CD | follows Kubernetes, never precedes it |
| Search | OpenSearch | PostgreSQL full-text first; move only when it demonstrably is not enough |
| Local models | Ollama + Open WebUI | already how the local tier runs; trial for product use |

## Hold

Not now. Revisit only with evidence, not enthusiasm.

- **Microservices** — modular monolith first (operating model §14, §15). Split a service when a real
  independent scaling or deployment need exists, not to be tidy.
- **Any managed SaaS with no export path** — fails criterion 6 outright.
- **A second database engine in the same product** — fails the one-tool rule.
- **Paid tiers of anything** — the company runs on free infrastructure until the ledger says otherwise.
- **A tool with no maintained project behind it** — a single-author repo with no commits in a year fails
  criterion 10 before it fails anything else.

## What this company itself runs on right now

Not the reference stack. `config/integrations.yaml` maps every capability to a vault-native adapter — Jobs
instead of Plane, Docs instead of BookStack, local git instead of Forgejo, `ci.run` instead of Woodpecker,
Messages instead of Mattermost, `.env` instead of OpenBao, Metrics instead of Grafana. The reference stack is
what we *build with*, and what we would migrate the company onto when there is a machine to run it on.

## The minimum stack (§54)

A small company should not deploy the whole reference stack. Start with: Forgejo, Plane, BookStack, Mattermost,
Keycloak, OpenBao, Docker or Podman, PostgreSQL, Woodpecker, Prometheus, Grafana, Restic. That is enough for a
surprisingly capable organisation.

## Before adding anything (§53)

Answer all ten in the ADR. A "no" on 3, 4, 6 or 10 is usually a "no" on the tool.

1. Does it solve a real problem? If not, do not deploy it.
2. Can an existing tool already solve it? Avoid duplication.
3. Can it be self-hosted? Preferably yes.
4. Is it open source? Preferably yes.
5. Does it use open standards? Strong preference.
6. Can data be exported? Essential.
7. Can it be automated? Strong preference.
8. Can it integrate with the existing stack? Essential.
9. How difficult is it to operate? Critical consideration.
10. What happens if the project disappears? There must be a migration strategy.

None of these ten is a formality. Self-hosting, open source, open standards and exportable data (3, 4, 5, 6) are
what keeps the company able to leave a tool; automatable and integrable (7, 8) are what keeps an agent able to
operate it without a human clicking through a console; operating difficulty and a migration strategy (9, 10) are
the honest admission that every tool is eventually replaced, and the question is only how much it hurts.

## How to change this file

Propose the move in an ADR: which ring, from which, and the evidence. Adopt needs a stream that used it in
anger. Hold needs a reason that will still make sense in six months.
