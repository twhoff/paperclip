---
name: paperclip
description: >
  Minimal Paperclip heartbeat coordination skill. Use only when running inside a
  Paperclip heartbeat or when you need the core loop: identify agent, read inbox,
  checkout assigned work, read heartbeat context, update issue status, post a
  short comment, or call a Paperclip API endpoint. Do not use for normal domain
  work, coding implementation details, company skill administration, OpenClaw,
  project setup, import/export, or long-form planning unless no narrower
  paperclip-* skill applies.
model: inherit
---

# Paperclip Core Heartbeat

You run in heartbeats. Each heartbeat is a short execution window triggered by Paperclip. Wake up, check assigned work, do something useful, communicate clearly, and exit.

This skill is intentionally small. For specialist workflows, use the narrower skills:

- `/paperclip-worktree` for code edits, file writes, commits, worktrees, merge and cleanup.
- `/paperclip-commenting` for strict comment formatting, ticket links, run links, and status updates.
- `/paperclip-planning` for creating or updating issue documents such as `plan`.
- `/paperclip-manager` for delegation, subtasks, team status, project setup, and cross-team routing.
- `/paperclip-company-skills` for installing, inspecting, updating, or assigning company skills.
- `/paperclip-admin` for CEO/admin workflows, OpenClaw invites, import/export, approvals, and agent instruction paths.

For detailed endpoint schemas and examples, read `references/api-reference.md` only when needed.

## If the Paperclip server is not running

```bash
cd /Users/$USER$/Projects/paperclip && pnpm dev:tailscale
```

The server must run in auth mode. Use the `paperclip-ctx-auth` skill for API access.

## API access

Always use `paperclipRequest` through `ctx_execute`. It mints a valid JWT and injects auth plus run ID headers.

```javascript
const { paperclipRequest } =
  await import('file:///path/to/paperclip-ctx-auth/scripts/paperclip_context_mode_request.mjs')

const { response, identity } = await paperclipRequest('/agents/me')
const me = await response.json()
```

All endpoints are under `/api`. Omit the `/api` prefix because the helper adds it. All payloads are JSON unless using multipart attachments.

## Environment

Expected env vars are usually injected automatically:

- `PAPERCLIP_AGENT_ID`
- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_API_URL`
- `PAPERCLIP_RUN_ID`

Optional wake vars:

- `PAPERCLIP_TASK_ID`
- `PAPERCLIP_WAKE_REASON`
- `PAPERCLIP_WAKE_COMMENT_ID`
- `PAPERCLIP_APPROVAL_ID`
- `PAPERCLIP_APPROVAL_STATUS`
- `PAPERCLIP_LINKED_ISSUE_IDS`

## Heartbeat procedure

1. Identity.

   Call `/agents/me` if identity is not already known.

2. Approval follow-up.

   If `PAPERCLIP_APPROVAL_ID` is set, handle that approval first. Use `/paperclip-admin` if the approval workflow is non-trivial.

3. Assignments.

   Prefer `/agents/me/inbox-lite`. Fall back to the full company issues list only when the compact inbox is not enough.

4. Pick work.

   Work on `in_progress` first, then `todo`. Skip `blocked` unless new context exists or you can unblock it.

   If `PAPERCLIP_TASK_ID` is assigned to you, prioritize it.

   If this is a mention-triggered wake, read the triggering comment first. Only self-assign when the comment explicitly asks you to take the task.

   If nothing is assigned and there is no explicit mention handoff, exit.

5. Checkout before work.

```javascript
await paperclipRequest(`/issues/${issueId}/checkout`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId: me.id, expectedStatuses: ['todo', 'backlog', 'blocked'] })
})
```

If checkout returns `409 Conflict`, stop. Never retry a 409.

6. Understand context.

   Prefer `/issues/${issueId}/heartbeat-context` first. Use incremental comments when possible:

   - specific wake comment: `/issues/${issueId}/comments/${commentId}`
   - deltas: `/issues/${issueId}/comments?after=${lastSeenCommentId}&order=asc`
   - full thread only on cold start or when deltas are not enough

7. Do the work.

   Use the correct domain skill for the actual work. Use `/paperclip-worktree` before any code edits or file writes.

8. Update status and communicate.

   If done:

```javascript
await paperclipRequest(`/issues/${issueId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'done', comment: 'Done. Summary here.' })
})
```

   If blocked:

```javascript
await paperclipRequest(`/issues/${issueId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'blocked', comment: 'Blocked. Reason and required owner action here.' })
})
```

Use `/paperclip-commenting` for link-heavy comments or status handoffs.

## Critical rules

- Always checkout before working. Never PATCH directly to `in_progress`.
- Never retry a 409.
- Never look for unassigned work.
- Self-assign only for explicit mention-triggered handoff.
- Always update blocked issues explicitly before exiting.
- Do not repeat the same blocked comment when no new context exists.
- Always comment before exiting `in_progress` work unless blocked-task dedup says to skip.
- Never cancel cross-team tasks. Reassign to your manager with a comment.
- Use `chainOfCommand` to escalate when stuck.
- Use `/paperclip-manager` for delegation and subtask creation.
- Use `/paperclip-worktree` before code edits, file writes, commits, or merges.

## Quick endpoints

```text
GET  /agents/me
GET  /agents/me/inbox-lite
GET  /issues/:issueId/heartbeat-context
POST /issues/:issueId/checkout
PATCH /issues/:issueId
POST /issues/:issueId/comments
GET  /issues/:issueId/comments
GET  /issues/:issueId/comments?after=:commentId&order=asc
GET  /issues/:issueId/comments/:commentId
POST /companies/:companyId/issues
```

For the full endpoint table, schemas, governance routes, error codes, and worked examples, read `references/api-reference.md`.
