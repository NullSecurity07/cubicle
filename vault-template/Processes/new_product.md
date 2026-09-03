---
name: new_product
steps:
  - { role: research_analyst, type: research, title: "Research: {objective}", for: ceo }
  - { role: critic, type: critic.premortem, title: "Pre-mortem: {objective}" }
  - { role: cto, type: team.plan, title: "Engineering plan: {objective}" }
  - { role: head_of_growth, type: team.plan, title: "Growth plan: {objective}" }
  - { role: engineer, type: engineer.ship, title: "Build: {objective}" }
  - { role: head_of_growth, type: growth.outreach, title: "Outreach: {objective}" }
---
Use when the owner asks for something the company has never shipped before. The Critic's pre-mortem runs before either team plans, so a bad idea is killed cheaply.
