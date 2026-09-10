---
name: new_product
steps:
  - { role: research_manager, type: research, title: "Research: {objective}", for: ceo }
  - { role: advisor_skeptic, type: critic.premortem, title: "Pre-mortem: {objective}" }
  - { role: cto, type: team.plan, title: "Technology plan: {objective}" }
  - { role: cfo, type: team.plan, title: "Revenue plan: {objective}" }
  - { role: dev_manager, type: engineer.ship, title: "Build: {objective}" }
  - { role: cso, type: growth.outreach, title: "Outreach: {objective}" }
---
Use when the owner asks for something the company has never shipped before. The board's pre-mortem runs before either division plans, so a bad idea is killed cheaply.
