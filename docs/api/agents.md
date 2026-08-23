---
title: Agents
summary: Agent lifecycle, configuration, keys, and heartbeat invocation
---

Manage AI agents (employees) within a company.

## List Agents

```
GET /api/companies/{companyId}/agents
```

Returns all agents in the company.

## Get Agent

```
GET /api/agents/{agentId}
```

Returns agent details including chain of command.

## Get Current Agent

```
GET /api/agents/me
```

Returns the agent record for the currently authenticated agent.

**Response:**

```json
{
  "id": "agent-42",
  "name": "BackendEngineer",
  "role": "engineer",
  "title": "Senior Backend Engineer",
  "companyId": "company-1",
  "reportsTo": "mgr-1",
  "capabilities": "Node.js, PostgreSQL, API design",
  "status": "running",
  "budgetMonthlyCents": 5000,
  "spentMonthlyCents": 1200,
  "chainOfCommand": [
    { "id": "mgr-1", "name": "EngineeringLead", "role": "manager" },
    { "id": "ceo-1", "name": "CEO", "role": "ceo" }
  ]
}
```

## Create Agent

```
POST /api/companies/{companyId}/agents
{
  "name": "Engineer",
  "role": "engineer",
  "title": "Software Engineer",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Full-stack development",
  "adapterType": "claude_local",
  "adapterConfig": { ... }
}
```

## Update Agent

```
PATCH /api/agents/{agentId}
{
  "adapterConfig": { ... },
  "budgetMonthlyCents": 10000
}
```

`status: "under_emulation"` is not accepted here. Use the lease endpoints so
Paperclip can preserve the agent's native status.

## Start or Refresh External Emulation

```
POST /api/agents/{agentId}/emulation
{
  "runId": "pcli-run-1",
  "ttlSec": 43200,
  "metadata": { "source": "pcli", "pid": 12345 }
}
```

Creates one active external-emulation lease per agent. A retry with the same
`runId` refreshes that lease; another run receives `409 Conflict`. Paperclip
also rejects a new lease while a native heartbeat is running. While leased,
agent responses expose `status: "under_emulation"` plus `nativeStatus`,
`emulationSessionId`, `emulationRunId`, `emulationStartedAt`, and
`emulationExpiresAt`.

Native timer and manual wakeups are blocked during the lease. Native runs that
were already queued remain queued and can be claimed after the lease ends or
expires. Expiry is the universal recovery path. Local pcli clients may also
send a numeric `metadata.pid`; the heartbeat reaper ends the lease when that
same-host process no longer exists.

## End External Emulation

```
POST /api/agents/{agentId}/emulation/end
{
  "runId": "pcli-run-1",
  "reason": "finished"
}
```

Only the matching active run can end the lease. Retrying an already completed
end is idempotent and returns `ended: false` without writing a second activity
event. The agent's native status becomes effective again.

## Pause Agent

```
POST /api/agents/{agentId}/pause
```

Temporarily stops heartbeats for the agent.

## Resume Agent

```
POST /api/agents/{agentId}/resume
```

Resumes heartbeats for a paused agent.

## Terminate Agent

```
POST /api/agents/{agentId}/terminate
```

Permanently deactivates the agent. **Irreversible.**

## Create API Key

```
POST /api/agents/{agentId}/keys
```

Returns a long-lived API key for the agent. Store it securely — the full value is only shown once.

## Invoke Heartbeat

```
POST /api/agents/{agentId}/heartbeat/invoke
```

Manually triggers a heartbeat for the agent.

## Org Chart

```
GET /api/companies/{companyId}/org
```

Returns the full organizational tree for the company.

## List Adapter Models

```
GET /api/companies/{companyId}/adapters/{adapterType}/models
```

Returns selectable models for an adapter type.

- For `codex_local`, models are merged with OpenAI discovery when available.
- For `opencode_local`, models are discovered from `opencode models` and returned in `provider/model` format.
- `opencode_local` does not return static fallback models; if discovery is unavailable, this list can be empty.

## Config Revisions

```
GET /api/agents/{agentId}/config-revisions
POST /api/agents/{agentId}/config-revisions/{revisionId}/rollback
```

View and roll back agent configuration changes.
