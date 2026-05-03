---
name: paperclip-company-skills
description: >
  Install, inspect, update, scan, or assign Paperclip company skills. Use when a
  board user, CEO, or manager asks to add a skill to the company library, update
  a skill, assign skills to agents, scan project workspaces for skills, or set
  desiredSkills during agent hire or create.
model: inherit
---

# Paperclip Company Skills

Use this skill when asked to manage skills inside a Paperclip company.

The full workflow reference is in `references/company-skills.md`. Read it before performing skill installation, update, or assignment.

## Canonical model

1. Install the skill into the company.
2. Assign the company skill to the agent.
3. Optionally do assignment during hire or create with `desiredSkills`.

## Core endpoints

```text
GET  /companies/:companyId/skills
GET  /companies/:companyId/skills/:skillId
POST /companies/:companyId/skills/import
POST /companies/:companyId/skills/scan-projects
POST /companies/:companyId/skills/:skillId/install-update
GET  /agents/:agentId/skills
POST /agents/:agentId/skills/sync
POST /companies/:companyId/agent-hires
POST /companies/:companyId/agents
```

## Source preference

Prefer skill sources in this order:

1. skills.sh URL
2. key-style string such as `org/repo/skill-name`
3. GitHub URL
4. local absolute path for development or testing

If the user gives a `skills.sh` URL, use it as the source. Do not convert it to GitHub.

## Import example

```javascript
await paperclipRequest(`/companies/${identity.companyId}/skills/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ source: 'https://skills.sh/org/repo/skill-name' })
})
```

## Assign example

```javascript
await paperclipRequest(`/agents/${agentId}/skills/sync`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ desiredSkills: ['org/repo/skill-name'] })
})
```

Read `references/company-skills.md` for exact permission rules, inspection flow, install-update flow, and hire/create examples.
