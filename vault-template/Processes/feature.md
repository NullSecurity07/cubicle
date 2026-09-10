---
name: feature
steps:
  - { role: research_manager, type: research, title: "Research: {objective}", for: cto }
  - { role: cto, type: team.plan, title: "Plan: {objective}" }
  - { role: backend_engineer, type: engineer.ship, title: "Build: {objective}" }
  - { role: cmo, type: growth.post, title: "Announce: {objective}" }
---
Use for a feature that needs a technical decision first. Skip the research step when an ADR already covers it. The build step is the room's job: the dev manager splits it in the Dev queue, a worker ships it on green.
