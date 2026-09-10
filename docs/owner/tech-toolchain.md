# Universal Self-Hosted Company Technology & Development Toolchain

## 1. Purpose

This document defines the **default software toolchain** supporting the Universal Company Development & Engineering Operating Model.

The objective is not to use as many tools as possible.

The objective is:

> **Use the smallest number of capable, interoperable, self-hosted and free/open-source tools necessary to operate the company efficiently.**

The stack should prioritize:

* Zero mandatory SaaS dependency
* Self-hosting
* Open standards
* Open-source software where practical
* Local development
* Data ownership
* Automation
* Interoperability
* Low cognitive overhead
* Low operational overhead
* Reproducibility
* Security
* Easy migration
* Minimal duplication between tools

"Free" in this document means **no mandatory per-user SaaS subscription**. Self-hosting still has infrastructure, electricity, storage, backup and maintenance costs.

The company should therefore distinguish:

**Software cost ≠ operational cost.**

---

# 2. The Golden Rule: One Primary Tool Per Job

A company should avoid giving teams five competing tools for the same function.

For example:

Bad:

```text
Jira
Linear
Trello
Asana
Notion
ClickUp
```

Good:

```text
Plane
   ↓
Projects + Issues + Cycles + Wiki
```

Similarly:

Bad:

```text
Slack
Discord
Teams
Mattermost
Telegram
WhatsApp
```

Good:

```text
Mattermost
   ↓
Internal communication
```

The principle is:

> **Standardize the default. Allow exceptions only when there is a demonstrated need.**

---

# 3. Recommended Core Stack

The default company stack should be approximately:

| Function                 | Default Tool                      |
| ------------------------ | --------------------------------- |
| Git hosting              | Forgejo                           |
| Code review              | Forgejo                           |
| Issue tracking           | Plane                             |
| Project management       | Plane                             |
| Internal documentation   | BookStack                         |
| Team communication       | Mattermost                        |
| Video meetings           | Jitsi Meet                        |
| Email                    | Postfix + Dovecot / mail platform |
| Identity                 | Keycloak                          |
| Passwords/secrets        | OpenBao                           |
| Local development        | VS Code / VSCodium                |
| Containers               | Docker / Podman                   |
| Container registry       | Harbor                            |
| CI                       | Woodpecker CI / Forgejo Actions   |
| CD/GitOps                | Argo CD where Kubernetes is used  |
| Infrastructure as Code   | OpenTofu                          |
| Configuration management | Ansible                           |
| Kubernetes               | Kubernetes / k3s                  |
| Reverse proxy            | Caddy or Traefik                  |
| Databases                | PostgreSQL                        |
| Cache                    | Redis/Valkey                      |
| Message broker           | NATS                              |
| API testing              | Bruno                             |
| Documentation diagrams   | Mermaid + draw.io                 |
| Error tracking           | Sentry                            |
| Metrics                  | Prometheus                        |
| Dashboards               | Grafana                           |
| Logs                     | Loki                              |
| Tracing                  | OpenTelemetry + Tempo/Jaeger      |
| Security scanning        | Semgrep + Trivy + Gitleaks        |
| Dependency management    | Renovate                          |
| Backup                   | Restic                            |
| File storage             | MinIO                             |
| Analytics                | Matomo                            |
| Automation               | n8n                               |
| Search                   | OpenSearch                        |
| AI/local models          | Ollama                            |
| Local AI interface       | Open WebUI                        |

This is the **reference stack**, not a requirement that every company deploy every component on day one.

---

# 4. Source Code Management

## Choice

### Forgejo

Forgejo should be the default Git forge for organizations prioritizing a lightweight, self-hosted stack.

It provides:

* Git repositories
* Pull requests
* Code review
* Issues
* Milestones
* Releases
* Package management
* Repository permissions
* CI integration

Gitea provides a similar all-in-one self-hosted model, including Git hosting, code review, packages and CI/CD. Forgejo is the preferred default here when community governance is a priority.

### Why

A Git forge should be the central source of truth for software.

Instead of:

```text
Code → GitHub
Issues → Jira
Docs → Notion
Packages → another service
CI → another SaaS
```

we want:

```text
Forge
 ├── Code
 ├── Reviews
 ├── Issues
 ├── Releases
 └── Packages
```

### Tradeoff

Forgejo is not necessarily the most feature-heavy enterprise DevOps suite.

For very large organizations wanting an extremely integrated platform, **GitLab Community Edition** is a legitimate alternative. GitLab provides a much broader integrated platform, but its infrastructure footprint is considerably heavier.

### Universal rule

**Small/medium default: Forgejo.**

**Large integrated DevOps environment: evaluate GitLab CE.**

Do not run both unless there is a real organizational reason.

---

# 5. Project and Work Management

## Choice

### Plane

Plane becomes the company's standard for:

* Projects
* Issues
* Cycles
* Modules
* Roadmaps
* Work tracking
* Project documentation
* Dashboards

Plane supports self-hosting and integrates with GitHub/GitLab, Sentry and communication systems.

### Why

It provides enough structure without requiring separate systems for every planning activity.

The basic workflow:

```text
Company Objective
       ↓
Initiative
       ↓
Project
       ↓
Module
       ↓
Issue
       ↓
Implementation
```

### Tradeoff

Plane is not going to perfectly reproduce every enterprise planning workflow.

That's acceptable.

The goal is not to reproduce every feature of Jira.

The goal is to keep work management understandable.

---

# 6. Documentation

## Choice

### BookStack

Use BookStack for structured internal documentation.

Suggested hierarchy:

```text
Company
│
├── Policies
├── Engineering
│   ├── Architecture
│   ├── Development
│   ├── Deployment
│   └── Operations
│
├── Security
│
├── Product
│
└── Human Resources
```

### Why

Documentation should have a predictable home.

### Tradeoff

Documentation becomes stale if nobody owns it.

Every major system should therefore have a documentation owner.

---

# 7. Architecture Documentation

## Choice

### Markdown + Mermaid + draw.io

Use text-based documentation wherever possible.

Examples:

```text
README.md
ARCHITECTURE.md
RUNBOOK.md
SECURITY.md
ADR-001.md
```

Mermaid can represent:

* Architecture
* Sequence diagrams
* Flowcharts
* State diagrams
* Dependencies

draw.io can handle more complex visual architecture diagrams.

### Why

Text-based architecture documentation can live beside code and be version-controlled.

### Tradeoff

Highly visual diagrams may still require graphical tools.

---

# 8. Architecture Decision Records

## Choice

### ADRs

Important architecture decisions should be recorded.

Example:

```text
ADR-001:
Why PostgreSQL was selected

ADR-002:
Why the application remained modular rather than becoming microservices

ADR-003:
Why NATS was selected for event messaging
```

Structure:

```text
Context
Decision
Alternatives
Consequences
Date
Owner
```

### Why

Organizations forget why decisions were made.

ADRs preserve that reasoning.

---

# 9. Communication

## Choice

### Mattermost

Mattermost becomes the primary internal asynchronous communication system.

Channels might include:

```text
#engineering
#product
#security
#platform
#incidents
#announcements
#team-payments
#team-identity
```

### Why

Communication should be searchable, structured and retained.

### Tradeoff

Chat creates noise.

Therefore:

> **Chat should not become the company's database.**

Important decisions should eventually be moved into documentation, issues or ADRs.

---

# 10. Video Conferencing

## Choice

### Jitsi Meet

Use Jitsi for internal video meetings where self-hosting is required.

Useful for:

* Team meetings
* Interviews
* Reviews
* Remote collaboration
* Incident calls

### Why

No mandatory external conferencing SaaS dependency.

### Tradeoff

Running reliable video infrastructure at large scale is non-trivial.

For very large organizations, this may be one of the first areas where a managed service becomes economically rational.

---

# 11. Identity Management

## Choice

### Keycloak

Keycloak becomes the central identity provider.

It can provide:

* Single Sign-On
* OAuth2
* OpenID Connect
* SAML
* Identity federation
* Role-based access
* MFA integration

Architecture:

```text
                 Keycloak
                    │
       ┌────────────┼────────────┐
       ↓            ↓            ↓
    Forgejo       Plane      Mattermost
       ↓            ↓            ↓
              Employees
```

### Why

Users should not maintain independent passwords for every internal system.

### Tradeoff

Identity infrastructure becomes critical infrastructure.

Keycloak itself must therefore be highly protected and backed up.

---

# 12. Secrets Management

## Choice

### OpenBao

Use OpenBao for centralized secrets management.

Store:

* API keys
* Database credentials
* Certificates
* Tokens
* Service credentials
* Encryption material

Do not store secrets inside:

* Git
* source code
* Docker images
* ordinary documentation
* chat

### Why

Centralized secret management reduces credential sprawl.

### Tradeoff

A secrets system is itself highly sensitive infrastructure.

It must be:

* backed up
* access-controlled
* monitored
* audited

---

# 13. Password Management

## Choice

### KeePassXC for local/offline password management

For individuals or small teams, KeePassXC provides an excellent offline password-management option.

For organization-wide shared credentials, use a centrally managed secrets/password platform rather than passing KeePass databases around manually.

### Principle

Human passwords and machine secrets should not be treated identically.

---

# 14. Developer Environment

## Choice

### VS Code / VSCodium

Standard development environment.

Common extensions:

* Git
* Docker
* Kubernetes
* language tooling
* linters
* formatters
* security scanners

### Why

Large ecosystem and broad language support.

---

# 15. Local Development Environment

## Choice

### Dev Containers

Each project should define its development environment declaratively.

Example concept:

```text
Repository
│
├── source/
├── tests/
├── Dockerfile
├── devcontainer.json
└── compose.yaml
```

A new developer should ideally be able to:

```text
clone
  ↓
open
  ↓
start environment
  ↓
run tests
  ↓
start development
```

### Why

Reduces:

> "It works on my machine."

---

# 16. Containers

## Choice

### Docker or Podman

Containers standardize application environments.

Use them for:

* Development
* CI
* Testing
* Deployment
* Service isolation

Podman is particularly attractive where daemonless/container security characteristics are preferred.

### Tradeoff

Containers add abstraction.

For ordinary local applications, don't containerize everything merely because you can.

---

# 17. Container Registry

## Choice

### Harbor

Harbor stores:

* Container images
* Helm charts
* Artifacts
* Signed packages

It can also support vulnerability scanning and image governance.

Architecture:

```text
Developer
   ↓
CI
   ↓
Build Image
   ↓
Harbor
   ↓
Deployment
```

---

# 18. Continuous Integration

## Choice

### Woodpecker CI or Forgejo Actions

CI should automatically run:

```text
Commit
 ↓
Build
 ↓
Lint
 ↓
Unit tests
 ↓
Security scans
 ↓
Integration tests
 ↓
Package
```

Woodpecker is a lightweight container-based CI system designed to work with Git forges.

### Why

CI must be automatic.

### Tradeoff

CI runners are security-sensitive because they execute repository code.

Runners should therefore be isolated and should not receive unnecessary production credentials.

---

# 19. Infrastructure as Code

## Choice

### OpenTofu

OpenTofu is the default infrastructure-as-code engine.

Infrastructure should be defined as code:

```text
Infrastructure
      ↓
Git
      ↓
Review
      ↓
CI
      ↓
Apply
```

This means infrastructure changes receive similar review and traceability as application code.

### Why

Infrastructure becomes reproducible.

### Tradeoff

IaC introduces its own complexity and state-management concerns.

---

# 20. Configuration Management

## Choice

### Ansible

Use Ansible for:

* Server configuration
* Package installation
* System configuration
* Baseline hardening
* Repeated administrative operations

Use OpenTofu for provisioning infrastructure.

Use Ansible for configuring machines.

---

# 21. Container Orchestration

## Choice

### Kubernetes when justified

Kubernetes becomes the standard orchestration layer at sufficient scale.

For smaller installations:

### k3s

Use k3s where a lighter Kubernetes distribution is appropriate.

### Critical rule

Do not introduce Kubernetes simply because it is fashionable.

For:

```text
5 services
2 servers
3 engineers
```

Kubernetes may be unnecessary.

For:

```text
100+ services
many teams
multiple environments
complex deployment requirements
```

Kubernetes becomes much more reasonable.

---

# 22. GitOps

## Choice

### Argo CD

Where Kubernetes is used, use GitOps.

Concept:

```text
Git
 ↓
Desired State
 ↓
Argo CD
 ↓
Kubernetes
```

The cluster continuously converges toward the state defined in Git.

### Why

Deployment becomes:

> Change Git → system reconciles.

### Tradeoff

GitOps adds another abstraction layer.

Do not use Argo CD for systems that don't need Kubernetes/GitOps.

---

# 23. Reverse Proxy

## Choice

### Caddy

Use Caddy as the simple default reverse proxy where appropriate.

Responsibilities:

* TLS
* Reverse proxy
* HTTP routing
* Certificate management

For more complex environments:

### Traefik

can become preferable for dynamic service discovery and container/Kubernetes integration.

---

# 24. Database

## Choice

### PostgreSQL

PostgreSQL should be the default relational database.

Use it for:

* Business data
* Transactional systems
* APIs
* Internal applications
* Metadata

### Why

One strong default database is easier to operate than five different database technologies.

### Tradeoff

Some workloads genuinely require different databases.

Do not force PostgreSQL into problems it is not designed to solve.

---

# 25. Cache

## Choice

### Valkey / Redis-compatible cache

Use for:

* Caching
* Sessions
* Queues where appropriate
* Rate limiting
* Temporary state

### Rule

A cache should never become the only copy of critical business data.

---

# 26. Messaging

## Choice

### NATS

Use NATS for lightweight messaging and event-driven communication.

Useful for:

* Pub/sub
* Service communication
* Event distribution
* Internal messaging

### Why

It is lightweight and fast.

### Tradeoff

More complicated event-driven systems may require Kafka-class infrastructure.

Do not introduce Kafka unless the workload actually requires it.

---

# 27. API Development and Testing

## Choice

### Bruno

Use Bruno for API testing and collections.

API collections should be version-controlled with the project.

Instead of:

```text
Developer's laptop
   ↓
mysterious API collection
```

use:

```text
Git repository
   ↓
API collection
   ↓
Team
```

### Why

API testing becomes reproducible.

---

# 28. Error Tracking

## Choice

### Sentry

Use self-hosted Sentry where appropriate for application errors.

It should collect:

* Exceptions
* Stack traces
* Error frequency
* Affected releases
* Context

### Why

Logs tell you what happened.

Error tracking helps tell you:

> Which application failures are affecting users?

---

# 29. Metrics

## Choice

### Prometheus

Prometheus should be the standard metrics collection system.

It collects:

* CPU
* Memory
* Request rates
* Latency
* Errors
* Application metrics
* Infrastructure metrics

Prometheus is already supported as a monitoring component in self-managed GitLab environments, illustrating how naturally it fits into this type of stack.

---

# 30. Dashboards

## Choice

### Grafana

Grafana visualizes:

* Prometheus metrics
* Logs
* Traces
* Other data sources

The standard observability relationship is:

```text
Applications
     │
     ├── Metrics → Prometheus
     │
     ├── Logs → Loki
     │
     └── Traces → OpenTelemetry
                         │
                         ↓
                      Grafana
```

Prometheus + Grafana is a particularly strong baseline for self-hosted observability.

---

# 31. Logs

## Choice

### Loki

Loki provides centralized log aggregation.

Instead of:

```text
Server A → logs
Server B → logs
Server C → logs
```

use:

```text
Servers
   ↓
Loki
   ↓
Grafana
```

### Why

Engineers can investigate distributed systems from one place.

---

# 32. Distributed Tracing

## Choice

### OpenTelemetry

OpenTelemetry becomes the instrumentation standard.

It allows the organization to collect:

* Traces
* Metrics
* Logs

without tightly coupling applications to a particular observability vendor.

### Why

Open standards reduce vendor lock-in.

---

# 33. Trace Storage

## Choice

### Grafana Tempo or Jaeger

Use Tempo where the Grafana ecosystem is already the central observability environment.

Use Jaeger where a dedicated tracing workflow is preferable.

Do not deploy both by default.

---

# 34. Security Scanning

The company should use several complementary security tools rather than one magical "security scanner."

---

## Static Application Security Testing

### Choice

**Semgrep**

Use for source-code security analysis and policy enforcement.

---

## Dependency Scanning

### Choice

**OWASP Dependency-Check / ecosystem-native tooling**

Identify vulnerable third-party dependencies.

---

## Container Scanning

### Choice

**Trivy**

Scan:

* Containers
* Filesystems
* Dependencies
* Infrastructure configurations
* Kubernetes manifests

---

## Secret Detection

### Choice

**Gitleaks**

Detect accidentally committed:

* API keys
* tokens
* passwords
* credentials

Pipeline:

```text
Developer
 ↓
Git
 ↓
Gitleaks
 ↓
Semgrep
 ↓
Dependency Scan
 ↓
Trivy
 ↓
Tests
 ↓
Build
```

---

# 35. Dependency Updates

## Choice

### Renovate

Renovate automatically identifies outdated dependencies and creates update proposals.

This prevents:

> "We haven't updated this dependency in two years."

It can be configured to group safe updates and automatically test them through CI.

---

# 36. Backup

## Choice

### Restic

Restic should be a default backup tool for important data.

Backups should cover:

* Databases
* Git repositories
* Documentation
* Configuration
* Secrets according to an appropriate backup policy
* Infrastructure state
* Critical application data

The backup principle is:

```text
Production
    ↓
Backup
    ↓
Different storage
    ↓
Different failure domain
```

A backup that lives only on the same server isn't a real disaster-recovery strategy.

---

# 37. Object Storage

## Choice

### MinIO

Use S3-compatible object storage for:

* Files
* Backups
* Artifacts
* Media
* Large objects
* Internal data

This gives applications a standardized object-storage interface.

---

# 38. Analytics

## Choice

### Matomo

For product analytics where self-hosting and data ownership are priorities.

Track:

* Product usage
* User flows
* Conversion
* Adoption
* Feature usage

### Principle

Analytics should answer:

> Are customers actually receiving value?

not:

> How many clicks did we generate?

---

# 39. Automation

## Choice

### n8n

Use n8n for internal workflow automation.

Examples:

```text
New employee
   ↓
Create accounts
   ↓
Assign groups
   ↓
Create workspace access
   ↓
Send onboarding message
```

Another:

```text
Security alert
   ↓
Create incident
   ↓
Notify security
   ↓
Create tracking issue
```

### Why

Not every automation requires custom software.

### Tradeoff

Do not build the company's entire business logic inside n8n.

Complex core systems belong in maintainable software.

---

# 40. Search

## Choice

### OpenSearch

Use when the organization needs serious centralized search/log analytics capabilities.

Potential uses:

* Application search
* Security analytics
* Log search
* Internal search

### Tradeoff

OpenSearch adds operational complexity.

Don't deploy it for a company that simply needs search over 50 documents.

---

# 41. Local AI

## Choice

### Ollama

Use Ollama as the local model runtime for development and internal AI workloads where appropriate.

Possible uses:

* Coding assistance
* Internal summarization
* Documentation search
* Local experimentation
* Development assistants

---

# 42. AI Interface

## Choice

### Open WebUI

Provide a common internal interface for locally hosted models.

Architecture:

```text
Employee
   ↓
Open WebUI
   ↓
Ollama / other local inference
   ↓
Local models
```

This keeps sensitive internal experimentation inside company infrastructure.

---

# 43. Internal Developer Portal

As the company grows, create a developer portal.

Possible foundation:

### Backstage

It can become the internal catalog for:

* Services
* Teams
* APIs
* Ownership
* Documentation
* Infrastructure
* Dependencies

Example:

```text
Service: Payments API

Owner: Payments Team
Repository: ...
Documentation: ...
Production: ...
Dashboard: ...
Alerts: ...
Dependencies: ...
```

This becomes extremely valuable once the organization has dozens or hundreds of services.

---

# 44. Service Ownership

Every production service should have:

* Owner team
* Technical lead
* Repository
* Documentation
* Dashboard
* Alert policy
* Runbook
* Deployment process
* Dependencies

A system without an owner is an organizational liability.

---

# 45. CI/CD Pipeline Standard

Every production project should converge toward:

```text
Developer
   ↓
Commit
   ↓
Pull Request
   ↓
Code Review
   ↓
Lint
   ↓
Unit Tests
   ↓
SAST
   ↓
Dependency Scan
   ↓
Secret Scan
   ↓
Build
   ↓
Integration Tests
   ↓
Container Scan
   ↓
Artifact Registry
   ↓
Deployment
   ↓
Canary
   ↓
Monitoring
   ↓
Full Release
```

The exact pipeline varies by project.

The principle does not.

---

# 46. Tool Ownership Model

Every shared tool should have an owner.

Example:

| Tool              | Owner                 |
| ----------------- | --------------------- |
| Forgejo           | Platform              |
| Plane             | Platform / Operations |
| Mattermost        | IT / Platform         |
| Keycloak          | Identity/Security     |
| OpenBao           | Security/Platform     |
| Harbor            | Platform              |
| CI                | Platform              |
| Kubernetes        | Platform              |
| Prometheus        | SRE                   |
| Grafana           | SRE                   |
| Loki              | SRE                   |
| Sentry            | Engineering/SRE       |
| Security scanners | Security              |
| BookStack         | Operations            |
| n8n               | Platform/Automation   |

The owner isn't necessarily the only user.

The owner is accountable for:

* availability
* upgrades
* backups
* security
* documentation
* access management

---

# 47. Standard Developer Workflow

A developer's daily environment should be extremely simple.

```text
VS Code
   ↓
Git
   ↓
Forgejo
   ↓
Plane
   ↓
CI
   ↓
Container Registry
   ↓
Deployment
   ↓
Grafana / Sentry
```

They should not need to understand twenty internal systems to make a normal code change.

---

# 48. Standard Product Team Workflow

A product team might operate like this:

```text
Customer Problem
      ↓
Plane
      ↓
Product Requirement
      ↓
Issue
      ↓
Developer
      ↓
Forgejo
      ↓
Pull Request
      ↓
CI
      ↓
Security / Quality
      ↓
Artifact
      ↓
Deployment
      ↓
Sentry + Prometheus
      ↓
Grafana
      ↓
Customer Outcome
```

That's the complete loop.

---

# 49. Standard Platform Workflow

Platform engineers operate slightly differently:

```text
Developer Pain Point
       ↓
Plane
       ↓
Platform Feature
       ↓
Code
       ↓
CI
       ↓
Infrastructure as Code
       ↓
OpenTofu / Ansible
       ↓
Deployment
       ↓
Observability
       ↓
Developer Feedback
```

The platform is continuously improved based on its internal customers.

---

# 50. Standard Security Workflow

```text
Architecture
     ↓
Threat Model
     ↓
Security Requirements
     ↓
Development
     ↓
SAST
     ↓
Dependency Scan
     ↓
Secret Scan
     ↓
Container Scan
     ↓
Deployment
     ↓
Runtime Monitoring
     ↓
Detection
     ↓
Incident Response
     ↓
Lessons Learned
```

Security is therefore a continuous process rather than a final approval step.

---

# 51. Standard Operations Workflow

```text
Deployment
    ↓
Metrics
    ↓
Logs
    ↓
Traces
    ↓
Alerts
    ↓
Incident
    ↓
Mitigation
    ↓
Recovery
    ↓
Post-Incident Review
    ↓
Engineering Improvement
```

---

# 52. What Should NOT Be Standardized

A universal toolchain does **not** mean every technical choice must be identical.

Teams should retain freedom over:

* Programming language
* Framework
* Internal library
* Database specialization
* AI model
* Testing framework
* IDE preferences
* Local developer utilities

provided they satisfy company standards.

For example:

```text
Company Standard
       │
       ├── Security
       ├── Observability
       ├── Identity
       ├── Backup
       ├── CI/CD
       └── Reliability
               │
               ↓
        Team Technology
```

The company standardizes **interfaces and outcomes**, not every implementation detail.

---

# 53. Tool Selection Criteria

Every new tool should be evaluated against:

### 1. Does it solve a real problem?

If not, don't deploy it.

### 2. Can an existing tool already solve it?

Avoid duplication.

### 3. Can it be self-hosted?

Preferably yes.

### 4. Is it open source?

Preferably yes.

### 5. Does it use open standards?

Strong preference.

### 6. Can data be exported?

Essential.

### 7. Can it be automated?

Strong preference.

### 8. Can it integrate with the existing stack?

Essential.

### 9. How difficult is it to operate?

Critical consideration.

### 10. What happens if the project disappears?

There should be a migration strategy.

---

# 54. The "Minimum Viable Company Stack"

A small company should NOT deploy the entire reference stack.

Start with:

```text
Forgejo
Plane
BookStack
Mattermost
Keycloak
OpenBao
Docker/Podman
PostgreSQL
Woodpecker / Forgejo Actions
Prometheus
Grafana
Restic
```

That's enough for a surprisingly capable organization.

---

# 55. Medium Company Stack

As complexity increases:

```text
Forgejo
Plane
BookStack
Mattermost
Keycloak
OpenBao
Harbor
Woodpecker
OpenTofu
Ansible
Kubernetes/k3s
Argo CD
PostgreSQL
Valkey
NATS
Sentry
Prometheus
Grafana
Loki
OpenTelemetry
Tempo
Trivy
Semgrep
Gitleaks
Renovate
Restic
MinIO
n8n
```

---

# 56. Large Company Stack

At larger scale, add specialized infrastructure:

```text
Backstage
OpenSearch
Advanced Kubernetes
Multi-cluster management
Dedicated observability infrastructure
Advanced security tooling
Data platforms
ML infrastructure
Service mesh where justified
Disaster recovery systems
High-availability identity
Centralized audit infrastructure
```

The key phrase is:

> **Add complexity only when organizational or technical complexity demands it.**

---

# 57. The One-Tool-Per-Problem Principle

The company should actively avoid tool sprawl.

For example:

### Work management

**Plane**

Not:

> Plane + Jira + Trello + Linear.

### Git

**Forgejo**

Not:

> Forgejo + GitLab + GitHub simultaneously.

### Communication

**Mattermost**

Not:

> Mattermost + Discord + Slack + WhatsApp for internal work.

### Observability

**Prometheus + Grafana + Loki + OpenTelemetry**

Not:

> Five overlapping monitoring platforms.

### Infrastructure

**OpenTofu + Ansible**

Not:

> Terraform + Pulumi + CloudFormation + Ansible + random scripts.

The objective is a **coherent system**, not an impressive list of software.

---

# 58. The Toolchain as an Architecture

The final system should look like:

```text
                         COMPANY
                            │
              ┌─────────────┼─────────────┐
              ↓             ↓             ↓
           PRODUCT      ENGINEERING     SECURITY
              │             │             │
              └─────────────┼─────────────┘
                            ↓
                         PLANE
                            │
                            ↓
                         FORGEJO
                            │
                    ┌───────┼───────┐
                    ↓       ↓       ↓
                   CI     Review   Packages
                    │
                    ↓
                 Security
                    │
                    ↓
                 Harbor
                    │
                    ↓
               Deployment
                    │
          ┌─────────┼─────────┐
          ↓         ↓         ↓
      Prometheus   Loki    OpenTelemetry
          │         │         │
          └─────────┼─────────┘
                    ↓
                  Grafana
                    │
                    ↓
                Operations
```

Supporting everything:

```text
Keycloak ───────── Identity
OpenBao ────────── Secrets
BookStack ──────── Knowledge
Mattermost ─────── Communication
Restic ─────────── Backup
MinIO ──────────── Object Storage
n8n ────────────── Automation
```

---

# 59. The Most Important Optimization

The biggest optimization isn't choosing the "best" individual tool.

It's reducing **context switching**.

A developer should be able to move through:

```text
Plane
 ↓
Forgejo
 ↓
CI
 ↓
Deployment
 ↓
Grafana
```

without constantly jumping between unrelated systems.

Likewise, a security engineer should have:

```text
Forgejo
 ↓
CI
 ↓
Security scanners
 ↓
OpenBao
 ↓
Observability
 ↓
Incident management
```

connected through automation.

The systems should behave like **one platform**, not 30 independent applications.

---

# 60. Final Standard

The company should therefore adopt the following philosophy:

> **Standardize the platform, not the creativity.**

Standardize:

* Identity
* Security
* Git
* Work tracking
* CI/CD
* Infrastructure
* Observability
* Backup
* Communication
* Documentation
* Access control
* Deployment standards

Allow flexibility in:

* Programming languages
* Frameworks
* Libraries
* Product implementation
* Technical experimentation
* Specialized databases
* AI models
* Team-level tools

The ideal result is:

```text
                 COMPANY
                    │
              Shared Platform
                    │
       ┌────────────┼────────────┐
       ↓            ↓            ↓
   Product A    Product B    Product C
       │            │            │
       └────────────┼────────────┘
                    ↓
               Common Standards
                    │
       ┌────────────┼────────────┐
       ↓            ↓            ↓
    Security     Reliability    Quality
```

The teams remain autonomous.

The infrastructure underneath them remains coherent.

That is the real objective of the toolchain.

**The company should feel like one engineering system, not a collection of departments that happen to use computers.**
