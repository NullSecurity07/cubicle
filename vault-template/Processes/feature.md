---
name: feature
steps:
  - { role: research_analyst, type: research, title: "Research: {objective}", for: cto }
  - { role: cto, type: team.plan, title: "Plan: {objective}" }
  - { role: engineer, type: engineer.ship, title: "Build: {objective}" }
  - { role: head_of_growth, type: growth.post, title: "Announce: {objective}" }
---
Use for a feature that needs a technical decision first. Skip the research step when an ADR already covers it.
