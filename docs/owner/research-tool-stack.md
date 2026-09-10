# Universal Research & Intelligence Tool Stack

## Free, Open-Source, Local-First Company Research Infrastructure

---

# 1. Design Principles

The research organization should follow five rules when selecting tools.

### Rule 1 — Local-first

Research data should remain under company control whenever practical.

Tools should preferably:

* Run on company computers
* Run on company servers
* Work without permanent internet access
* Store data in standard formats
* Allow export and migration
* Avoid mandatory cloud subscriptions

This is especially important for confidential research, internal strategy, customer information, technical research and security research.

---

### Rule 2 — Open-source first

When two tools provide comparable capabilities, prefer the open-source option.

Benefits include:

* No mandatory per-seat licensing
* Inspectable software
* Greater control
* Easier self-hosting
* Reduced vendor lock-in
* Better long-term archival

There are exceptions where a proprietary tool is substantially better, but the default should remain open-source/local.

---

### Rule 3 — One primary tool per job

Do not maintain:

> Three note-taking systems + four databases + five project managers.

Instead:

> One primary system + a small number of specialized tools.

This makes training and maintenance dramatically easier.

---

### Rule 4 — Standard formats

Research should use portable formats wherever possible:

* Markdown
* PDF/A
* CSV
* JSON
* Parquet
* SQLite
* PostgreSQL
* BibTeX
* Git
* PNG/SVG
* HTML

The company should be able to abandon a particular application without losing its knowledge.

---

### Rule 5 — Automation over repetition

If researchers repeatedly perform the same operation, automate it.

Examples:

* Source collection
* PDF extraction
* Metadata extraction
* Data cleaning
* Statistical analysis
* Report generation
* Research indexing
* Backups
* Monitoring
* Dataset updates

---

# 2. Core Operating System

## Tool

**Linux**

### Recommended choice

Ubuntu LTS or Debian Stable.

### Purpose

Foundation for the research infrastructure.

Used for:

* Research servers
* Databases
* Jupyter
* Automation
* Search
* Data processing
* Internal services
* Containers

### Why

Stable, mature, free and extremely well supported.

### Tradeoff

Some researchers may be more comfortable with Windows or macOS.

Therefore:

> Linux for servers; researchers can use Linux, Windows or macOS for personal workstations.

---

# 3. Web Browser

## Tool

**Firefox**

### Purpose

Primary research browser.

Used for:

* Web research
* Documentation
* Academic sources
* Government sources
* Industry information
* Competitor research
* Internal applications

### Why

Open-source browser with strong privacy controls and extensive extension support.

### Recommended configuration

Create separate browser profiles:

```text
Research
Internal
Personal
Security Research
Administration
```

This reduces accidental data leakage between contexts.

---

# 4. Source and Reference Management

## Tool

**Zotero**

### Purpose

Central reference manager.

Used for:

* Papers
* Books
* Reports
* Web sources
* PDFs
* Citations
* Bibliographies
* Research notes
* Source organization

Zotero is free/open-source, supports collection/tag organization, PDF management, annotations, citation generation and local operation. Its desktop application stores research data locally unless synchronization is explicitly configured.

### Why

This should be the organization's **source-of-record for external research references**.

### Recommended structure

```text
Zotero
│
├── Market
├── Product
├── Technology
├── Security
├── Finance
├── Legal
├── Operations
├── AI/ML
├── Industry
└── Strategic Foresight
```

### Tradeoff

Zotero is primarily a reference system, not a complete knowledge-management platform.

Therefore it should work alongside the company's research repository.

---

# 5. PDF Reading and Annotation

## Primary tool

**Zotero PDF Reader**

### Purpose

* Read papers
* Highlight evidence
* Annotate
* Extract notes
* Link notes to sources

### Secondary tool

**Okular**

For general PDF viewing and technical documents.

### Why

Avoid maintaining multiple PDF ecosystems.

---

# 6. Research Knowledge Base

## Primary tool

**BookStack**

### Purpose

Central human-readable research knowledge base.

Used for:

* Research methods
* Internal methodologies
* Research guides
* Institutional knowledge
* Research summaries
* Procedures
* Domain knowledge
* Internal documentation

### Why

A research repository should be easy for non-researchers to read.

A CEO should not need to understand Git to find:

> "What did we learn about this market last year?"

### Tradeoff

BookStack is not ideal for every form of research artifact.

Therefore it should be the **knowledge presentation layer**, not the raw-data layer.

---

# 7. Research Source-of-Truth Repository

## Tools

**Git + Gitea**

### Purpose

Version-controlled research artifacts.

Gitea provides self-hosted Git hosting, code/research collaboration, review, issues, project management and CI/CD capabilities. It is specifically designed to be lightweight and self-hosted.

### Store

```text
research/
│
├── projects/
├── datasets/
├── analysis/
├── experiments/
├── methodologies/
├── reports/
├── scripts/
├── models/
└── templates/
```

### Why

Research changes.

You need to know:

* Who changed something?
* What changed?
* When?
* Why?
* Which analysis produced this result?

Git provides this history.

### Tradeoff

Git is not suitable for every large binary dataset.

Use Git for:

* Code
* Text
* Configuration
* Research protocols
* Small metadata files

Use data storage for large datasets.

---

# 8. Data Storage

## Primary database

**PostgreSQL**

### Purpose

Structured research data.

Used for:

* Research metadata
* Survey results
* Experimental results
* Internal datasets
* Structured intelligence
* Research project information

### Why

Mature, powerful and open-source.

---

## Lightweight local database

**SQLite**

### Purpose

Small individual research projects.

Useful for:

* Prototypes
* Local datasets
* Research scripts
* Portable analysis

### Why

Zero server administration.

---

# 9. Large Dataset Storage

## Tool

**MinIO**

### Purpose

S3-compatible object storage operated locally.

Used for:

* Large datasets
* PDFs
* Research archives
* Experimental outputs
* Images
* Audio
* Video
* Model artifacts
* Backups

### Why

Separates large files from databases and Git repositories.

### Tradeoff

Requires infrastructure administration.

---

# 10. Data Analysis

## Primary language

**Python**

### Purpose

General research computation.

Used for:

* Data cleaning
* Statistical analysis
* Machine learning
* Automation
* Scraping where permitted
* Experiments
* Forecasting
* Visualization
* Text processing

### Core libraries

```text
pandas
NumPy
SciPy
statsmodels
scikit-learn
Matplotlib
Seaborn
Polars
PyArrow
```

### Why

One language can support a huge percentage of research workflows.

---

# 11. Statistical Research

## Tool

**R**

### Purpose

Advanced statistical analysis.

Particularly useful for:

* Statistical modeling
* Experimental analysis
* Econometrics
* Survey analysis
* Epidemiology
* Social science research
* Visualization

### Why

Python should be the general-purpose research language.

R should exist as the specialist statistical environment.

### Tradeoff

Maintaining two programming ecosystems adds complexity.

But forcing every statistical problem into one ecosystem is worse.

---

# 12. Interactive Research Environment

## Tool

**JupyterLab**

### Purpose

Interactive research notebooks.

Used for:

* Exploratory analysis
* Data science
* Experiments
* Statistical analysis
* Visualization
* Prototyping
* Reproducible research

Jupyter is a 100% open-source project and is explicitly designed for interactive data science and scientific computing.

### Recommended structure

Every major analysis should contain:

```text
01_problem.ipynb
02_data.ipynb
03_analysis.ipynb
04_results.ipynb
```

Or, preferably for larger projects:

```text
notebooks/
src/
data/
results/
figures/
reports/
```

---

# 13. Shared Research Compute

## Tool

**JupyterHub**

### Purpose

Central Jupyter environment for multiple researchers.

Instead of every researcher maintaining their own environment:

```text
Research Server
      │
      ├── Researcher A
      ├── Researcher B
      ├── Researcher C
      └── Researcher D
```

### Why

Centralized:

* Environments
* Packages
* Compute
* Storage
* Backups

### Tradeoff

Requires administration.

For a very small research team, individual JupyterLab installations may be simpler.

---

# 14. Data Visualization / BI

## Primary tool

**Metabase**

### Purpose

Company-wide analytical dashboards.

Used for:

* Business metrics
* Research dashboards
* Product analytics
* Operational analytics
* Survey results
* Financial research
* KPI monitoring

Metabase is an open-source BI platform that supports dashboards, interactive charts, GUI queries and SQL, and can be self-hosted.

### Why

Researchers can expose useful findings to non-technical departments without requiring everyone to use Python.

### Tradeoff

Not a replacement for advanced statistical analysis.

It is the **decision-facing visualization layer**.

---

# 15. Advanced Visualization

## Tools

**Matplotlib**

**Plotly**

**Grafana**

### Use:

Matplotlib:

> Scientific/reproducible figures.

Plotly:

> Interactive analytical visualizations.

Grafana:

> Operational and time-series monitoring.

Do not use all three for everything.

Each has a defined role.

---

# 16. Search Infrastructure

## Tool

**OpenSearch**

### Purpose

Internal search across research knowledge.

Can index:

* Research reports
* PDFs
* Notes
* Datasets
* Metadata
* Internal documents
* Intelligence records

OpenSearch is an open-source search and analytics suite supporting full-text search, analytics and vector search.

### Why

Eventually the organization will have thousands or millions of research artifacts.

Folder browsing stops working.

Search becomes essential.

---

# 17. Research Archive

## Tool

**Paperless-ngx**

### Purpose

Document archive.

Used for:

* Reports
* Invoices
* Regulatory documents
* Administrative research documents
* Scanned documents
* Historical records

### Why

OCR + searchable archival.

---

# 18. OCR

## Tool

**Tesseract OCR**

### Purpose

Extract text from:

* Scanned PDFs
* Images
* Documents
* Historical records

### Why

Free, local and automatable.

---

# 19. Document Conversion

## Tools

**Pandoc**

**LibreOffice**

### Pandoc

Converts between:

* Markdown
* HTML
* DOCX
* PDF workflows
* LaTeX
* EPUB
* Other formats

### LibreOffice

For:

* DOCX
* XLSX
* PPTX
* ODT
* Spreadsheet work

### Why

Keeps document production independent of proprietary office ecosystems.

---

# 20. Research Writing

## Primary format

**Markdown**

### Purpose

Default research writing format.

Why:

* Human-readable
* Version-controllable
* Portable
* Easy to automate
* Easy to convert

### Long scientific documents

**LaTeX**

Use for:

* Scientific papers
* Mathematics-heavy research
* Complex references
* Formal publications

### Tradeoff

LaTeX has a learning curve.

Do not force ordinary business research into LaTeX.

---

# 21. Survey Research

## Tool

**LimeSurvey Community Edition**

### Purpose

Self-hosted surveys.

Used for:

* Customer research
* Employee surveys
* Market research
* Research questionnaires
* Feedback collection

### Why

Keeps survey data under company control.

### Tradeoff

Hosted commercial survey platforms can be easier to operate.

Self-hosting requires maintenance.

---

# 22. Qualitative Research

## Primary approach

Use:

**Markdown + structured coding + spreadsheets/database**

for small and medium projects.

### Specialized tool

**Taguette**

### Purpose

Qualitative coding.

Used for:

* Interview transcripts
* Open-ended survey responses
* Documents
* Thematic analysis

### Why

Avoid paying for enterprise qualitative analysis software when the research workload doesn't justify it.

### Tradeoff

Specialized commercial tools may provide more sophisticated workflows.

---

# 23. Audio / Video Transcription

## Tool

**Whisper**

### Purpose

Local transcription.

Used for:

* Interviews
* Focus groups
* Meetings
* User research
* Expert interviews

### Workflow

```text
Audio
 ↓
Whisper
 ↓
Transcript
 ↓
Researcher verification
 ↓
Taguette / Markdown
 ↓
Analysis
```

### Why

Local transcription protects sensitive interviews.

---

# 24. Audio / Video Processing

## Tool

**FFmpeg**

### Purpose

Convert and process:

* Audio
* Video
* Recordings
* Interview files

Used heavily in automated research pipelines.

---

# 25. Experimental Tracking

## Tools

**MLflow**

**DVC**

### MLflow

Track:

* Experiments
* Parameters
* Metrics
* Models

### DVC

Track:

* Datasets
* Large files
* Data versions
* Reproducible pipelines

### Why

Research should be reproducible.

You need to know exactly:

> Which dataset + code + parameters produced this result?

---

# 26. Reproducible Environments

## Tools

**Docker**

**Docker Compose**

### Purpose

Package research environments.

Example:

```text
Research Project
│
├── PostgreSQL
├── Jupyter
├── Python
├── OpenSearch
└── Research application
```

can be reproduced using containers.

### Why

Avoid:

> "It worked on the researcher's laptop."

### Tradeoff

Containers add complexity.

Use them for shared/reproducible environments, not necessarily every tiny script.

---

# 27. Dependency Management

## Python

Use:

**uv**

or

**Poetry**

### Purpose

Manage:

* Python versions
* Dependencies
* Virtual environments
* Reproducibility

### Recommendation

Prefer **uv** for the default modern Python workflow because it keeps environment/package management fast and lightweight.

---

# 28. Version Control

## Tools

**Git**

**Gitea**

Git:

> Version control.

Gitea:

> Internal Git server + collaboration.

This should be the standard for:

* Research code
* Protocols
* Analysis
* Methodologies
* Reports
* Templates

---

# 29. Project / Research Work Management

## Tool

**OpenProject**

### Purpose

Manage larger research programs.

Used for:

* Research projects
* Milestones
* Dependencies
* Tasks
* Resource planning
* Timelines

### Why

Research itself needs project management.

### Tradeoff

Don't use a heavyweight project-management platform for every small research question.

Use lightweight Git issues for small projects and OpenProject for larger programs.

---

# 30. Lightweight Task Management

## Tool

**Gitea Issues**

### Purpose

Small research projects.

Use:

```text
Issue
 ↓
Research task
 ↓
Assignment
 ↓
Evidence
 ↓
Completion
```

Gitea already provides issues, milestones, assignments, dependencies and project-management capabilities.

This prevents unnecessary application proliferation.

---

# 31. Communication

## Tool

**Mattermost**

### Purpose

Internal research communication.

Channels:

```text
research-general
research-methods
market-intelligence
technology-intelligence
security-research
data-research
research-ops
```

### Why

Self-hosted communication.

### Tradeoff

Communication should never become the research repository.

Important knowledge must eventually move into the formal repository.

---

# 32. Internal Meetings

## Tool

**Jitsi Meet**

### Purpose

Self-hosted video conferencing.

Used for:

* Interviews
* Research meetings
* Expert sessions
* Cross-functional research meetings

### Why

Useful when research confidentiality matters.

---

# 33. Password and Secret Management

## Tool

**Vaultwarden**

### Purpose

Store:

* Research service credentials
* Database credentials
* API keys
* Service passwords

### Rule

Never put passwords or API keys inside:

* Git
* Research notebooks
* Reports
* Markdown
* Datasets

---

# 34. Infrastructure Secrets

## Tool

**HashiCorp Vault**

### Purpose

Machine/service secrets.

Use when the research infrastructure becomes sufficiently large.

### Important distinction

```text
Vaultwarden
     ↓
Human credentials

HashiCorp Vault
     ↓
Machine/service secrets
```

A small research team may not need both initially.

---

# 35. Backup

## Tools

**Restic**

**BorgBackup**

### Purpose

Encrypted backups.

Recommended approach:

```text
Primary Data
     ↓
Local Backup
     ↓
Secondary Storage
     ↓
Offline / Cold Backup
```

### Why

Research represents institutional knowledge.

Losing it can be more damaging than losing hardware.

### Tradeoff

Backups require monitoring and periodic restoration tests.

A backup that has never been restored is only a theory.

---

# 36. Monitoring

## Tools

**Prometheus**

**Grafana**

### Purpose

Monitor research infrastructure.

Track:

* CPU
* RAM
* Disk
* Databases
* Jupyter
* Search
* Storage
* Service availability

### Why

Research infrastructure itself needs reliability.

---

# 37. Logs

## Tool

**OpenSearch**

Use OpenSearch for:

* Logs
* Search
* Research indexing
* Analytics

This reduces the number of independent infrastructure systems.

---

# 38. Workflow Automation

## Tool

**n8n**

### Purpose

Connect research systems.

Example:

```text
New research request
        ↓
Create project
        ↓
Create repository
        ↓
Create folder structure
        ↓
Notify Research Lead
        ↓
Create tracking record
```

### Why

Eliminates repetitive administrative work.

### Tradeoff

Automation should remain understandable.

Don't create a 50-step workflow that nobody can debug.

---

# 39. General Programming / Research IDE

## Tool

**VS Code**

### Purpose

Primary development environment.

Used for:

* Python
* R
* SQL
* Markdown
* Git
* Jupyter
* Automation
* Research tooling

### Why

One environment can cover most technical research.

---

# 40. Terminal

## Tools

**Bash**

**PowerShell**

### Purpose

Automation and system interaction.

Linux researchers should primarily use Bash.

Windows researchers can use PowerShell where appropriate.

---

# 41. Data Querying

## Primary language

**SQL**

### Primary database

**PostgreSQL**

### Local analysis

**DuckDB**

### Why DuckDB is important

DuckDB is excellent for analytical queries directly against files such as:

* CSV
* Parquet
* JSON

This means researchers don't always need to load everything into a database.

Example:

```text
Raw Parquet
     ↓
DuckDB
     ↓
SQL analysis
     ↓
Jupyter
```

Very efficient.

---

# 42. Data Formats

The organization should standardize around:

### Tabular

**Parquet**

Default for large analytical datasets.

**CSV**

For simple interoperability.

### Structured

**JSON**

For APIs and structured research records.

### Database

**PostgreSQL**

For shared structured information.

### Local

**SQLite**

For portable projects.

### Why

Standard formats make research portable between tools.

---

# 43. Data Processing

## Tools

**Polars**

**Pandas**

**PyArrow**

### Recommended roles

Polars:

> Large/fast dataframe processing.

Pandas:

> General research ecosystem compatibility.

PyArrow:

> Parquet and columnar data infrastructure.

---

# 44. Machine Learning / AI Research

## Tools

**PyTorch**

**scikit-learn**

**Hugging Face Transformers**

### PyTorch

Deep learning research.

### scikit-learn

Classical machine learning.

### Transformers

Modern NLP/transformer models.

### Why

All are widely used open-source ecosystems.

---

# 45. Local AI

For companies requiring local AI research:

## Tools

**Ollama**

**llama.cpp**

**vLLM**

### Roles

Ollama:

> Simple local model deployment.

llama.cpp:

> Efficient local inference, especially on consumer hardware.

vLLM:

> Higher-throughput model serving.

### Why

Research data can remain inside the company.

### Tradeoff

Local models may be weaker than the best frontier hosted models for some tasks.

Therefore local AI should be treated as an infrastructure capability, not an ideological requirement.

---

# 46. Local Embeddings / Semantic Search

## Tools

**sentence-transformers**

**FAISS**

### Purpose

Build internal semantic search systems.

Example:

```text
Research documents
       ↓
Embeddings
       ↓
FAISS
       ↓
Semantic search
```

### Use cases

* Find related research
* Discover duplicate work
* Search historical findings
* Retrieve relevant evidence

---

# 47. Vector Search

## Primary options

**OpenSearch**

or

**pgvector + PostgreSQL**

### Recommendation

Start with **pgvector** when the research system is small.

Move toward OpenSearch when the organization needs large-scale search, analytics and hybrid search.

This avoids deploying another large service prematurely.

---

# 48. Web Research

The company should use researchers' ordinary web browsers plus structured source capture.

Recommended process:

```text
Discover
   ↓
Evaluate source
   ↓
Capture
   ↓
Zotero
   ↓
Annotate
   ↓
Research repository
```

The key is not having a magical research browser.

It's having a **repeatable source-management process**.

---

# 49. Web Archiving

## Tool

**ArchiveBox**

### Purpose

Preserve web research.

Used for:

* Important web pages
* Competitor pages
* Historical sources
* Research evidence
* Documentation snapshots

### Why

Web content changes.

If an important conclusion depends on a webpage today, preserving the evidence is valuable.

### Tradeoff

Archiving everything creates enormous storage and legal/operational complications.

Archive selectively.

---

# 50. Geographic Research

## Tools

**QGIS**

**PostGIS**

### QGIS

Desktop GIS analysis.

### PostGIS

Geospatial database extension for PostgreSQL.

### Use cases

* Market geography
* Site selection
* Demographics
* Logistics
* Infrastructure
* Environmental research
* Geographic risk

---

# 51. Scientific Computing

## Tools

**SciPy**

**SymPy**

**NumPy**

### Purpose

* Numerical computation
* Optimization
* Signal processing
* Mathematical modeling
* Symbolic mathematics
* Scientific simulations

---

# 52. Mathematical / Symbolic Research

## Tool

**SageMath**

### Purpose

Advanced mathematical research.

Use only where necessary.

### Why

It is powerful but unnecessary for ordinary business research.

This is an example of a **specialist tool that should not burden every researcher**.

---

# 53. Reference/Data Import

## Tools

**Zotero Connector**

**Crossref**

**OpenAlex**

### Purpose

Discover and collect scholarly literature.

### Workflow

```text
Discovery
 ↓
Metadata
 ↓
Zotero
 ↓
PDF
 ↓
Annotation
 ↓
Research notes
```

---

# 54. Patent Research

Use:

* Patent databases
* Local downloaded patent datasets where legally available
* Zotero for references
* Python for analysis
* PostgreSQL for structured patent datasets

The important principle is:

> External databases are sources; Zotero/research repositories are where the organization's resulting knowledge is retained.

---

# 55. Regulatory Research

Use:

* Browser
* Zotero
* PDF/OCR tools
* Research repository
* OpenSearch

Each regulatory conclusion should preserve:

```text
Regulation
 ↓
Relevant section
 ↓
Interpretation
 ↓
Applicability
 ↓
Confidence
 ↓
Source
 ↓
Date checked
```

---

# 56. Competitive Intelligence

Use the existing stack:

```text
Firefox
   +
Zotero
   +
ArchiveBox
   +
OpenSearch
   +
PostgreSQL
   +
Python
   +
Metabase
```

There is no need for a separate expensive “competitive intelligence platform” by default.

---

# 57. Market Research

Use:

```text
LimeSurvey
   +
Zotero
   +
PostgreSQL
   +
Python/R
   +
Metabase
   +
QGIS where geographic analysis is needed
```

---

# 58. UX Research

Use:

```text
LimeSurvey
   +
Jitsi
   +
Whisper
   +
Taguette
   +
Markdown
   +
PostgreSQL
```

Workflow:

```text
Interview
 ↓
Recording
 ↓
Whisper transcription
 ↓
Human verification
 ↓
Qualitative coding
 ↓
Theme analysis
 ↓
Findings
```

---

# 59. Technical Research

Use:

```text
VS Code
   +
Git/Gitea
   +
Python
   +
Jupyter
   +
Docker
   +
PostgreSQL
   +
MLflow/DVC
```

This gives technical researchers a complete environment without proprietary dependencies.

---

# 60. Security Research

Security research should use the same core infrastructure but add specialized defensive tooling where required.

Core:

* Linux
* Git/Gitea
* Python
* Jupyter
* Docker
* PostgreSQL
* OpenSearch
* Grafana
* Prometheus

Specialized security tooling can then be added according to the company's authorized security-testing requirements.

The key principle is:

> **Security tools remain inside the controlled research environment and follow the company's authorization and data-handling rules.**

---

# 61. Financial Research

Use:

```text
PostgreSQL
   +
Python
   +
R
   +
Jupyter
   +
Metabase
   +
LibreOffice
```

Python handles modeling and automation.

R handles advanced statistics.

Metabase exposes decision dashboards.

LibreOffice handles conventional financial spreadsheets.

---

# 62. Operations Research

Use:

```text
Python
   +
SciPy
   +
OR-Tools
   +
Jupyter
   +
PostgreSQL
   +
QGIS where required
```

OR-Tools is particularly useful for:

* Scheduling
* Routing
* Optimization
* Resource allocation
* Logistics

---

# 63. Research Documentation

Every research project should have a predictable directory.

```text
PROJECT/
│
├── README.md
│
├── question/
│   └── research-question.md
│
├── protocol/
│   └── protocol.md
│
├── sources/
│
├── data/
│   ├── raw/
│   └── processed/
│
├── analysis/
│
├── experiments/
│
├── figures/
│
├── results/
│
├── report/
│
└── archive/
```

This structure should be generated automatically when a project starts.

---

# 64. Research Templates

Create standardized templates for:

### Research request

```text
Department:
Decision:
Question:
Hypothesis:
Known evidence:
Unknowns:
Constraints:
Deadline:
Required confidence:
```

### Research protocol

```text
Objective
Scope
Research questions
Hypotheses
Methods
Sources
Participants
Data
Analysis
Risks
Limitations
Stopping criteria
```

### Research report

```text
Executive Summary
Decision
Question
Context
Method
Evidence
Analysis
Findings
Contradictory Evidence
Limitations
Confidence
Recommendation
Follow-up
Sources
```

---

# 65. Recommended Tool Architecture

The final stack should look approximately like this:

```text
                         RESEARCHERS
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
       Firefox             VS Code            LibreOffice
          │                   │                   │
          ▼                   ▼                   ▼
       SOURCES             CODE / DATA          DOCUMENTS
          │                   │                   │
       Zotero               Git                 Pandoc
          │                 Gitea                  │
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                         RESEARCH CORE
                              │
             ┌────────────────┼────────────────┐
             │                │                │
          Jupyter           Python/R        Taguette
             │                │                │
             └────────────────┼────────────────┘
                              │
                           DATA
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
      PostgreSQL            DuckDB              MinIO
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                         KNOWLEDGE
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
       BookStack          OpenSearch          ArchiveBox
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                       DECISION LAYER
                              │
                         Metabase
                              │
                              ▼
                         MANAGEMENT
```

---

# 66. Infrastructure Layer

Under everything:

```text
Linux
Docker
Docker Compose
Git
PostgreSQL
MinIO
Restic
Prometheus
Grafana
```

This is the foundation.

---

# 67. Communication Layer

```text
Mattermost
Jitsi
```

Communication is deliberately separated from knowledge.

Chat is for:

> "Let's discuss this."

Knowledge management is for:

> "This is what the company has concluded."

---

# 68. Automation Layer

```text
n8n
Python
Bash
Git hooks
Scheduled jobs
```

Automation connects everything.

Example:

```text
New Research Request
        ↓
n8n
        ↓
Create Project
        ↓
Create Gitea Repository
        ↓
Create Research Structure
        ↓
Create PostgreSQL Record
        ↓
Notify Research Lead
        ↓
Begin Research
```

---

# 69. Knowledge Layer

The organization should distinguish four things:

### Source

Original external information.

**Zotero**

### Evidence

Collected internal/external evidence.

**Research repository + data storage**

### Knowledge

Validated organizational understanding.

**BookStack + OpenSearch**

### Decision

What the company chose to do.

**Research report + project/decision records**

This separation is extremely important.

---

# 70. Minimal Stack

A small company should NOT install everything above.

Start with:

```text
Linux
Firefox
Zotero
VS Code
Git
Gitea
Python
JupyterLab
PostgreSQL
DuckDB
BookStack
MinIO
Restic
Docker
Metabase
```

That is already enough for a surprisingly sophisticated research organization.

---

# 71. Medium-Sized Research Organization

Add:

```text
JupyterHub
OpenSearch
OpenProject
Mattermost
Jitsi
LimeSurvey
Whisper
Taguette
MLflow
DVC
Prometheus
Grafana
n8n
ArchiveBox
```

---

# 72. Large Research Organization

Then add specialized infrastructure where justified:

```text
High-performance compute
GPU cluster
Advanced storage
Distributed databases
Large-scale search
Advanced ML infrastructure
Dedicated research data lake
Research API services
Advanced experiment tracking
Specialized scientific software
Domain-specific tools
```

The organization should **not deploy these simply because it has grown**.

Deploy them when research workload actually requires them.

---

# 73. Tool Selection by Research Role

| Role                    | Primary Tools                                                      |
| ----------------------- | ------------------------------------------------------------------ |
| Research Lead           | BookStack, Gitea, OpenProject, Metabase                            |
| Researcher              | Firefox, Zotero, VS Code, Jupyter                                  |
| Research Analyst        | Python, R, Jupyter, DuckDB                                         |
| Data Scientist          | Python, Jupyter, MLflow, DVC                                       |
| Research Scientist      | Python, R, Jupyter, SciPy, SymPy                                   |
| UX Researcher           | LimeSurvey, Jitsi, Whisper, Taguette                               |
| Market Researcher       | Zotero, LimeSurvey, Python, Metabase                               |
| Intelligence Analyst    | Firefox, Zotero, ArchiveBox, OpenSearch                            |
| Technical Researcher    | VS Code, Git, Gitea, Docker, Jupyter                               |
| Security Researcher     | Linux, Git, Python, Docker, OpenSearch + approved security tooling |
| AI/ML Researcher        | Python, PyTorch, Jupyter, MLflow, DVC                              |
| Financial Researcher    | Python, R, PostgreSQL, Jupyter, Metabase                           |
| Operations Researcher   | Python, OR-Tools, SciPy, PostgreSQL, QGIS                          |
| Knowledge Manager       | BookStack, Zotero, OpenSearch                                      |
| Research Engineer       | Linux, Git, Gitea, Docker, Python                                  |
| Research Ops            | OpenProject, Gitea, n8n, BookStack                                 |
| Research Infrastructure | Linux, Docker, PostgreSQL, MinIO, Prometheus, Grafana, Restic      |

---

# 74. The Most Important Optimization

The stack should be **modular rather than maximal**.

Do not think:

> "We need every tool."

Think:

```text
CORE
│
├── Knowledge
├── Sources
├── Data
├── Analysis
├── Version Control
├── Project Management
├── Communication
├── Automation
└── Backup
        │
        ▼
SPECIALIZED TOOLS
        │
        ├── UX
        ├── AI
        ├── Scientific
        ├── GIS
        ├── Security
        └── Other domains
```

The core remains constant.

Specialized tools are plugged in only when needed.

---

# 75. Recommended Default Stack

If I had to choose **one exact default stack** for a universal company today, I would use:

| Function               | Selected Tool                         |
| ---------------------- | ------------------------------------- |
| OS                     | Ubuntu/Debian Linux                   |
| Browser                | Firefox                               |
| References             | Zotero                                |
| Knowledge base         | BookStack                             |
| Version control        | Git + Gitea                           |
| Project management     | OpenProject                           |
| Lightweight tasks      | Gitea Issues                          |
| Programming            | VS Code                               |
| Primary language       | Python                                |
| Statistics             | R                                     |
| Notebooks              | JupyterLab                            |
| Shared notebooks       | JupyterHub                            |
| Data analysis          | Polars + Pandas                       |
| Analytical SQL         | DuckDB                                |
| Database               | PostgreSQL                            |
| Local database         | SQLite                                |
| Object storage         | MinIO                                 |
| BI                     | Metabase                              |
| Search                 | OpenSearch                            |
| Semantic search        | pgvector initially / OpenSearch later |
| Qualitative research   | Taguette                              |
| Surveys                | LimeSurvey                            |
| Transcription          | Whisper                               |
| Audio/video            | FFmpeg                                |
| Documents              | LibreOffice                           |
| Document conversion    | Pandoc                                |
| Scientific computing   | NumPy + SciPy                         |
| Mathematics            | SymPy                                 |
| Optimization           | OR-Tools                              |
| GIS                    | QGIS + PostGIS                        |
| ML                     | scikit-learn + PyTorch                |
| ML experiment tracking | MLflow                                |
| Dataset versioning     | DVC                                   |
| Containers             | Docker                                |
| Automation             | n8n + Python                          |
| Communication          | Mattermost                            |
| Video meetings         | Jitsi                                 |
| Web archiving          | ArchiveBox                            |
| OCR                    | Tesseract                             |
| Local AI               | Ollama / llama.cpp / vLLM             |
| Semantic retrieval     | sentence-transformers + pgvector      |
| Monitoring             | Prometheus + Grafana                  |
| Backups                | Restic                                |
| Human secrets          | Vaultwarden                           |
| Machine secrets        | HashiCorp Vault when needed           |

---

# 76. What Should NOT Be Installed by Default

This is just as important.

Do not automatically deploy:

* Multiple project-management systems
* Multiple wikis
* Multiple BI platforms
* Multiple databases
* Multiple vector databases
* Multiple chat platforms
* Multiple notebook systems
* Multiple reference managers
* Multiple survey systems
* Multiple cloud storage systems

Every additional platform creates:

* Training cost
* Maintenance
* Security surface
* Data duplication
* Integration work
* Backup requirements
* Migration problems

The default should therefore be:

> **One primary tool per capability.**

Add another only when there is a demonstrable requirement.

---

# 77. Final Architecture

The entire research technology ecosystem should ultimately look like:

```text
                         RESEARCH & INTELLIGENCE
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       │                          │                          │
    SOURCES                    RESEARCH                    PEOPLE
       │                          │                          │
   Firefox                    Jupyter                    Mattermost
   Zotero                     Python                     Jitsi
   ArchiveBox                 R
       │                      Data
       │                       │
       └──────────────┬────────┘
                      │
                   EVIDENCE
                      │
          ┌───────────┼───────────┐
          │           │           │
      PostgreSQL    MinIO       Git/Gitea
          │           │           │
          └───────────┼───────────┘
                      │
                   ANALYSIS
                      │
       ┌──────────────┼──────────────┐
       │              │              │
    Jupyter         Python/R      Specialized
       │              │            Research
       └──────────────┼──────────────┘
                      │
                  KNOWLEDGE
                      │
          ┌───────────┼───────────┐
          │           │           │
      BookStack    OpenSearch   Zotero
          │           │           │
          └───────────┼───────────┘
                      │
                 RECOMMENDATION
                      │
                   Metabase
                      │
                      ▼
                  DECISION
                      │
                      ▼
                    ACTION
                      │
                      ▼
                  MEASUREMENT
                      │
                      ▼
              NEW RESEARCH DATA
```

---

# 78. Final Principle

The tool stack should never become the research methodology.

The methodology remains:

> **Question → Frame → Hypothesis/Exploration → Existing Evidence → Method Selection → Evidence Collection → Verification → Analysis → Synthesis → Recommendation → Decision → Measurement → Knowledge**

The tools merely execute those steps.

That distinction keeps the organization from becoming dependent on software.

If tomorrow one application disappears, the research system should continue operating because:

* The data is portable.
* The knowledge is documented.
* The methodology is standardized.
* The repositories are version-controlled.
* The infrastructure is replaceable.
* The processes are documented.
* The tools are modular.

That is the real objective of a **free/local universal research stack**: not simply avoiding subscription fees, but creating a research capability that the company can **control, reproduce, migrate, automate and operate for decades**.
