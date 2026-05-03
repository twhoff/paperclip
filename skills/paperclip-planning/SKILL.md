---
name: paperclip-planning
description: >
  Create or update Paperclip issue documents for plans, plan revisions,
  implementation proposals, or structured execution plans. Use when the user or
  issue asks for a plan. Do not append long plans to issue descriptions.
model: inherit
---

# Paperclip Planning

When asked to make a plan, create or update the issue document with key `plan`.

Do not append long plans into the issue description.

Do not mark the issue as done just because a plan was created. Reassign the issue to whoever requested the plan and leave it in progress or in review as appropriate.

## Create or update the plan document

```javascript
await paperclipRequest(`/issues/${issueId}/documents/plan`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: 'Plan',
    format: 'markdown',
    body: '# Plan\n\n[your plan here]',
    baseRevisionId: null
  })
})
```

If `plan` already exists, fetch the current document first and send the latest `baseRevisionId`.

## Comment after updating the plan

Use `/paperclip-commenting` formatting. Link directly to the document:

```md
Updated the plan document: [Plan](/PAP/issues/PAP-123#document-plan)
```

## Recommended plan shape

```md
# Plan

## Goal

## Current state

## Proposed approach

## Execution steps

## Risks

## Validation

## Open questions
```

Keep the plan practical. Prefer steps that can become subtasks.
