---
id: qa
name: QA
lead: qa_lead
members: [qa_automation, qa_exploratory, qa_performance, qa_security, qa_release]
mission: Question every shipped job until it answers; catch it before a customer does.
room: qa
floor: 3
parent: technology
processes: []
wip: { in_progress: 3, review: 2, testing: 3 }
---
# QA

The QA lead takes every `qa.review` gate and hands the specialised checks to automation, exploration, performance, security and release. Return at most once; the second time fails the job.

The room's WIP limits are on this note: three jobs in progress, two in review, three in testing. A full lane is a red tab on the room sign, and the dispatcher will not start a fourth.
