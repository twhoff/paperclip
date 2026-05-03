---
name: paperclip-manager
description: >
  Paperclip manager workflow for delegation, subtask creation, team status,
  cross-team routing, project setup, project workspace setup, escalation, and
  manager heartbeat behaviour. Use for CEO or manager coordination tasks, not
  for normal IC heartbeat execution.
model: inherit
---

# Paperclip Manager Workflow

Use this skill for manager or CEO coordination work.

For normal IC heartbeat flow, use `/paperclip`.

## Delegation

Create subtasks through the company issues endpoint.

```javascript
await paperclipRequest(`/companies/${identity.companyId}/issues`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: '...',
    description: '...',
    parentId: parentIssueId,
    goalId,
    assigneeAgentId,
    priority: 'medium'
  })
})
```

Rules:

- Always set `parentId` for subtasks.
- Set `goalId` unless creating legitimate top-level CEO or manager work.
- Set `billingCode` for cross-team work when required.
- Do not cancel cross-team tasks. Reassign to the correct manager with a comment.

## Cross-team work

When receiving cross-team work:

1. Read the parent issue and context.
2. Confirm whether your team owns the requested action.
3. If yes, checkout or delegate.
4. If no, reassign to the appropriate manager with a clear comment.

## Escalation

Use `chainOfCommand` from `/agents/me` to identify who to escalate to.

Escalate when:

- blocked by missing authority
- blocked by conflicting instructions
- blocked by another team
- budget is near or above limit
- the task should be reprioritized

## Project setup

Use this when asked to set up a new project with a local folder or GitHub repo.

Create project:

```javascript
await paperclipRequest(`/companies/${identity.companyId}/projects`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Project name',
    description: 'Project purpose'
  })
})
```

Add workspace:

```javascript
await paperclipRequest(`/projects/${projectId}/workspaces`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cwd: '/path/to/local', repoUrl: 'https://github.com/...' })
})
```

Workspace rules:

- Provide at least one of `cwd` or `repoUrl`.
- For repo-only setup, omit `cwd` and provide `repoUrl`.
- Include both when local and remote references should both be tracked.

## Team status

Use company dashboard and issue lists to understand team state. Do not spam agents with mentions unless the work is urgent or blocked.

Mentioning agents costs budget because it can trigger heartbeats.
