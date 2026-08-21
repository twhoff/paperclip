---
mode: agent
description: Capture requirements as a tracked epic and decompose them into deliverable child issues.
---

Load the `track` skill, then execute the Track workflow defined in
`workflows/track.yaml` via the `use-workflow` executor contract.

Treat everything after the command as the requirements, user story, raw task,
or existing epic ID to decompose. Run the workflow's discovery and decomposition
phases, then present the full epic structure — epic, children, dependencies, and
wave / agent-path labels — for approval **before creating any issues**.

${input}
