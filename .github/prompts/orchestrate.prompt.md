---
mode: agent
description: Orchestrate bounded swarm delivery of an epic's children across worker agents.
---

Load the `orchestrate` skill, then execute the Orchestrate Swarm workflow defined
in `workflows/orchestrate-swarm.yaml` via the `use-workflow` executor contract.

Treat everything after the command as the epic ID or scope to orchestrate.
Confirm the epic's ready children and the delivery plan with the user before
dispatching any swarm workers. If the work is a single coherent change or the
children are tightly coupled, recommend `implement` instead of a swarm.

${input}
