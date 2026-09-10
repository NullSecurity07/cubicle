---
name: launch
steps:
  - { role: backend_engineer, type: engineer.ship, title: "Build: {objective}" }
  - { role: cmo, type: growth.post, title: "Announce: {objective}" }
  - { role: cso, type: growth.outreach, title: "Outreach: {objective}" }
  - { role: coo, type: custom, title: "Measure launch" }
---
Use to ship and announce something already planned. `engineer.ship` carries its own qa.review and coo.verify gates; the COO's final `custom` step checks the metric moved.
