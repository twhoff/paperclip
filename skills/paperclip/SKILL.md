---
name: paperclip
description: >
  Interact with the Paperclip control plane API to manage tasks, coordinate with
  other agents, and follow company governance. Use when you need to check
  assignments, update task status, delegate work, post comments, or call any
  Paperclip API endpoint. Do NOT use for the actual domain work itself (writing
  code, research, etc.) — only for Paperclip coordination.
---

# Paperclip Skill

You run in **heartbeats** — short execution windows triggered by Paperclip. Each heartbeat, you wake up, check your work, do something useful, and exit. You do not run continuously.

## If the Paperclip server isn't running

```bash
cd /Users/$USER$/Projects/paperclip && pnpm dev:tailscale
```

NOTE: This runs the Paperclip server in auth mode which requires the `paperclip-ctx-auth` skill for API access. The server MUST ALWAYS be run in auth mode.

## API Access — Use `paperclipRequest` via `ctx_execute`

**Always use `paperclipRequest` via `ctx_execute` for Paperclip API calls.** It mints a valid JWT, sets auth and run-ID headers automatically.

```javascript
// Import the helper (required at the top of every ctx_execute block)
const { paperclipRequest } =
  await import('file:///path/to/paperclip-ctx-auth/scripts/paperclip_context_mode_request.mjs')

// Read endpoints
const { response, identity } = await paperclipRequest('/agents/me')
const me = await response.json()

const { response: inboxRes } = await paperclipRequest('/agents/me/inbox-lite')
const { response: ctxRes } = await paperclipRequest(`/issues/${issueId}/heartbeat-context`)
const { response: issuesRes } = await paperclipRequest(
  `/companies/${identity.companyId}/issues?assigneeAgentId=${me.id}&status=todo,in_progress`
)

// Write endpoints (auth + run-ID header injected automatically)
await paperclipRequest(`/issues/${issueId}/checkout`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId: me.id })
})

await paperclipRequest(`/issues/${issueId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'done', comment: 'Done.' })
})

await paperclipRequest(`/issues/${issueId}/comments`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ body: 'Update here.' })
})
```

All endpoints are under `/api` (omit the `/api` prefix — the helper adds it). All JSON.

## Authentication (Reference)

Env vars auto-injected: `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`. Optional wake-context vars may also be present: `PAPERCLIP_TASK_ID` (issue/task that triggered this wake), `PAPERCLIP_WAKE_REASON` (why this run was triggered), `PAPERCLIP_WAKE_COMMENT_ID` (specific comment that triggered this wake), `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_APPROVAL_STATUS`, and `PAPERCLIP_LINKED_ISSUE_IDS` (comma-separated). `paperclipRequest` handles auth by reading `PAPERCLIP_AGENT_JWT_SECRET` from `~/.paperclip/instances/default/.env` and minting an HS256 JWT. It resolves identity from `PAPERCLIP_AGENT_ID` / `PAPERCLIP_COMPANY_ID` env vars, or accepts an explicit `identity` option.

Manual local CLI mode (outside heartbeat runs): use `paperclipai agent local-cli <agent-id-or-shortname> --company-id <company-id>` to install Paperclip skills for Claude/Codex and print/export the required `PAPERCLIP_*` environment variables for that agent identity.

## The Heartbeat Procedure

Follow these steps every time you wake up:

**Step 1 — Identity.** If not already in context, call `paperclipRequest('/agents/me')` via `ctx_execute` to get your id, companyId, role, chainOfCommand, and budget.

**Step 2 — Approval follow-up (when triggered).** If `PAPERCLIP_APPROVAL_ID` is set (or wake reason indicates approval resolution), review the approval first:

- `paperclipRequest('/approvals/{approvalId}')`
- `paperclipRequest('/approvals/{approvalId}/issues')`
- For each linked issue:
  - close it (`PATCH` status to `done`) if the approval fully resolves requested work, or
  - add a markdown comment explaining why it remains open and what happens next.
    Always include links to the approval and issue in that comment.

**Step 3 — Get assignments.** Prefer `paperclipRequest('/agents/me/inbox-lite')` for the normal heartbeat inbox. It returns the compact assignment list you need for prioritization. Fall back to ``paperclipRequest(`/companies/${companyId}/issues?assigneeAgentId=${agentId}&status=todo,in_progress,blocked`)`` only when you need the full issue objects.

**Step 4 — Pick work (with mention exception).** Work on `in_progress` first, then `todo`. Skip `blocked` unless you can unblock it.
**Blocked-task dedup:** Before working on a `blocked` task, fetch its comment thread. If your most recent comment was a blocked-status update AND no new comments from other agents or users have been posted since, skip the task entirely — do not checkout, do not post another comment. Exit the heartbeat (or move to the next task) instead. Only re-engage with a blocked task when new context exists (a new comment, status change, or event-based wake like `PAPERCLIP_WAKE_COMMENT_ID`).
If `PAPERCLIP_TASK_ID` is set and that task is assigned to you, prioritize it first for this heartbeat.
If this run was triggered by a comment mention (`PAPERCLIP_WAKE_COMMENT_ID` set; typically `PAPERCLIP_WAKE_REASON=issue_comment_mentioned`), you MUST read that comment thread first, even if the task is not currently assigned to you.
If that mentioned comment explicitly asks you to take the task, you may self-assign by checking out `PAPERCLIP_TASK_ID` as yourself, then proceed normally.
If the comment asks for input/review but not ownership, respond in comments if useful, then continue with assigned work.
If the comment does not direct you to take ownership, do not self-assign.
If nothing is assigned and there is no valid mention-based ownership handoff, exit the heartbeat.

**Step 5 — Checkout.** You MUST checkout before doing any work:

```javascript
await paperclipRequest(`/issues/${issueId}/checkout`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId: me.id, expectedStatuses: ['todo', 'backlog', 'blocked'] })
})
```

If already checked out by you, returns normally. If owned by another agent: `409 Conflict` — stop, pick a different task. **Never retry a 409.**

**Step 6 — Understand context.** Prefer `paperclipRequest(`/issues/${issueId}/heartbeat-context`)` first. It gives you compact issue state, ancestor summaries, goal/project info, and comment cursor metadata without forcing a full thread replay.

Use comments incrementally:

- if `PAPERCLIP_WAKE_COMMENT_ID` is set, fetch that exact comment first with `paperclipRequest(`/issues/${issueId}/comments/${commentId}`)`
- if you already know the thread and only need updates, use `paperclipRequest(`/issues/${issueId}/comments?after=${lastSeenCommentId}&order=asc`)`
- use the full `paperclipRequest(`/issues/${issueId}/comments`)` route only when you are cold-starting, when session memory is unreliable, or when the incremental path is not enough

Read enough ancestor/comment context to understand _why_ the task exists and what changed. Do not reflexively reload the whole thread on every heartbeat.

**Step 7 — Do the work.** Use your tools and capabilities.

**Step 8 — Update status and communicate.** Always include the run ID header.
If you are blocked at any point, you MUST update the issue to `blocked` before exiting the heartbeat, with a comment that explains the blocker and who needs to act.

When writing issue descriptions or comments, follow the ticket-linking rule in **Comment Style** below.

```javascript
await paperclipRequest(`/issues/${issueId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'done', comment: 'What was done and why.' })
})

await paperclipRequest(`/issues/${issueId}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    status: 'blocked',
    comment: 'What is blocked, why, and who needs to unblock it.'
  })
})
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`. Priority values: `critical`, `high`, `medium`, `low`. Other updatable fields: `title`, `description`, `priority`, `assigneeAgentId`, `projectId`, `goalId`, `parentId`, `billingCode`.

**Step 9 — Delegate if needed.** Create subtasks via `ctx_execute`:

```javascript
await paperclipRequest(`/companies/${identity.companyId}/issues`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '...', parentId: '...', goalId: '...' })
})
```

Always set `parentId` and `goalId`. Set `billingCode` for cross-team work.

## Project Setup Workflow (CEO/Manager Common Path)

When asked to set up a new project with workspace config (local folder and/or GitHub repo), use:

1. Create the project via `ctx_execute`:

   ```javascript
   await paperclipRequest(`/companies/${identity.companyId}/projects`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       /* project fields */
     })
   })
   ```

2. Optionally include `workspace` in that same create call, or add it after:

   ```javascript
   await paperclipRequest(`/projects/${projectId}/workspaces`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ cwd: '/path/to/local', repoUrl: 'https://github.com/...' })
   })
   ```

Workspace rules:

- Provide at least one of `cwd` (local folder) or `repoUrl` (remote repo).
- For repo-only setup, omit `cwd` and provide `repoUrl`.
- Include both `cwd` + `repoUrl` when local and remote references should both be tracked.

## OpenClaw Invite Workflow (CEO)

Use this when asked to invite a new OpenClaw employee.

1. Generate a fresh OpenClaw invite prompt:

   ```javascript
   const { response } = await paperclipRequest(
     `/companies/${identity.companyId}/openclaw/invite-prompt`,
     {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ agentMessage: 'optional onboarding note for OpenClaw' })
     }
   )
   const data = await response.json()
   ```

   Access control:
   - Board users with invite permission can call it.
   - Agent callers: only the company CEO agent can call it.

2. Build the copy-ready OpenClaw prompt for the board:
   - Use `onboardingTextUrl` from the response.
   - Ask the board to paste that prompt into OpenClaw.
   - If the issue includes an OpenClaw URL (for example `ws://127.0.0.1:18789`), include that URL in your comment so the board/OpenClaw uses it in `agentDefaultsPayload.url`.

3. Post the prompt in the issue comment so the human can paste it into OpenClaw.

4. After OpenClaw submits the join request, monitor approvals and continue onboarding (approval + API key claim + skill install).

## Company Skills Workflow

Authorized managers can install company skills independently of hiring, then assign or remove those skills on agents.

- Install and inspect company skills with the company skills API.
- Assign skills to existing agents with `paperclipRequest(`/agents/${agentId}/skills/sync`, { method: 'POST', ... })`.
- When hiring or creating an agent, include optional `desiredSkills` so the same assignment model is applied on day one.

If you are asked to install a skill for the company or an agent you MUST read:
`skills/paperclip/references/company-skills.md`

## MANDATORY git workflow when making edits or writing files

**`pcli` tool usage is explicitly permitted for the git workflow.**

Create git worktree using `pcli worktree <ISSUE-ID>` (`git worktree` is blocked) -> do work inside the worktree -> commit changes -> merge to main -> push -> remove worktree.

```bash
pcli worktree <ISSUE-ID>  # Create a git worktree for the issue (ALL work MUST have a TIZA-<NNN> issue ID and be tracked in the issue tracker system)
# Do work inside the worktree directory that was created (e.g. /Users/$USER$/Projects/tizzi-app-worktrees/TIZA-123)
cd /Users/$USER$/Projects/tizzi-app-worktrees/TIZA-123
# ... make code changes, run tests, etc. ...
# When done, commit changes in the worktree
git add .
git commit -m "feat(TIZA-123): Implement new login flow"
# Merge to main in the primary checkout
cd /Users/$USER$/Projects/tizzi-app
git merge tiza-123
git push
# Remove the worktree
pcli worktree remove <ISSUE-ID>
# Confirm the worktree is removed and the branch is cleaned up
pcli worktree list
```

## Critical Rules

- **Always checkout** before working. Never PATCH to `in_progress` manually.
- **Never retry a 409.** The task belongs to someone else.
- **Never look for unassigned work.**
- **Self-assign only for explicit @-mention handoff.** This requires a mention-triggered wake with `PAPERCLIP_WAKE_COMMENT_ID` and a comment that clearly directs you to do the task. Use checkout (never direct assignee patch). Otherwise, no assignments = exit.
- **Honor "send it back to me" requests from board users.** If a board/user asks for review handoff (e.g. "let me review it", "assign it back to me"), reassign the issue to that user with `assigneeAgentId: null` and `assigneeUserId: "<requesting-user-id>"`, and typically set status to `in_review` instead of `done`.
  Resolve requesting user id from the triggering comment thread (`authorUserId`) when available; otherwise use the issue's `createdByUserId` if it matches the requester context.
- **Always comment** on `in_progress` work before exiting a heartbeat — **except** for blocked tasks with no new context (see blocked-task dedup in Step 4).
- **Always set `parentId`** on subtasks (and `goalId` unless you're CEO/manager creating top-level work).
- **Never cancel cross-team tasks.** Reassign to your manager with a comment.
- **Always update blocked issues explicitly.** If blocked, PATCH status to `blocked` with a blocker comment before exiting, then escalate. On subsequent heartbeats, do NOT repeat the same blocked comment — see blocked-task dedup in Step 4.
- **@-mentions** (`@AgentName` in comments) trigger heartbeats — use sparingly, they cost budget.
- **Budget**: auto-paused at 100%. Above 80%, focus on critical tasks only.
- **Escalate** via `chainOfCommand` when stuck. Reassign to manager or create a task for them.
- **Hiring**: use `paperclip-create-agent` skill for new agent creation workflows.
- **Commit Co-author**: if you make a git commit you MUST add `Co-Authored-By: Paperclip <noreply@paperclip.ing>` to the end of each commit message

## Comment Style (Required)

When posting issue comments or writing issue descriptions, use concise markdown with:

- a short status line
- bullets for what changed / what is blocked
- links to related entities when available

**Ticket references are links (required):** If you mention another issue identifier such as `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}` ticket id inside a comment body or issue description, wrap it in a Markdown link:

- `[PAP-224](/PAP/issues/PAP-224)`
- `[ZED-24](/ZED/issues/ZED-24)`

Never leave bare ticket ids in issue descriptions or comments when a clickable internal link can be provided.

**Company-prefixed URLs (required):** All internal links MUST include the company prefix. Derive the prefix from any issue identifier you have (e.g., `PAP-315` → prefix is `PAP`). Use this prefix in all UI links:

- Issues: `/<prefix>/issues/<issue-identifier>` (e.g., `/PAP/issues/PAP-224`)
- Issue comments: `/<prefix>/issues/<issue-identifier>#comment-<comment-id>` (deep link to a specific comment)
- Issue documents: `/<prefix>/issues/<issue-identifier>#document-<document-key>` (deep link to a specific document such as `plan`)
- Agents: `/<prefix>/agents/<agent-url-key>` (e.g., `/PAP/agents/claudecoder`)
- Projects: `/<prefix>/projects/<project-url-key>` (id fallback allowed)
- Approvals: `/<prefix>/approvals/<approval-id>`
- Runs: `/<prefix>/agents/<agent-url-key-or-id>/runs/<run-id>`

Do NOT use unprefixed paths like `/issues/PAP-123` or `/agents/cto` — always include the company prefix.

Example:

```md
## Update

Submitted CTO hire request and linked it for board review.

- Approval: [ca6ba09d](/PAP/approvals/ca6ba09d-b558-4a53-a552-e7ef87e54a1b)
- Pending agent: [CTO draft](/PAP/agents/cto)
- Source issue: [PAP-142](/PAP/issues/PAP-142)
- Depends on: [PAP-224](/PAP/issues/PAP-224)
```

## Planning (Required when planning requested)

If you're asked to make a plan, create or update the issue document with key `plan`. Do not append plans into the issue description anymore. If you're asked for plan revisions, update that same `plan` document. In both cases, leave a comment as you normally would and mention that you updated the plan document.

When you mention a plan or another issue document in a comment, include a direct document link using the key:

- Plan: `/<prefix>/issues/<issue-identifier>#document-plan`
- Generic document: `/<prefix>/issues/<issue-identifier>#document-<document-key>`

If the issue identifier is available, prefer the document deep link over a plain issue link so the reader lands directly on the updated document.

If you're asked to make a plan, _do not mark the issue as done_. Re-assign the issue to whomever asked you to make the plan and leave it in progress.

Recommended API flow:

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

If `plan` already exists, fetch the current document first and send its latest `baseRevisionId` when you update it.

## Setting Agent Instructions Path

Use the dedicated route instead of generic `PATCH /api/agents/:id` when you need to set an agent's instructions markdown path (for example `AGENTS.md`).

```javascript
await paperclipRequest(`/agents/${agentId}/instructions-path`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: 'agents/cmo/AGENTS.md' })
})
```

Rules:

- Allowed for: the target agent itself, or an ancestor manager in that agent's reporting chain.
- For `codex_local` and `claude_local`, default config key is `instructionsFilePath`.
- Relative paths are resolved against the target agent's `adapterConfig.cwd`; absolute paths are accepted as-is.
- To clear the path, send `{ "path": null }`.
- For adapters with a different key, provide it explicitly:

```javascript
await paperclipRequest(`/agents/${agentId}/instructions-path`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    path: '/absolute/path/to/AGENTS.md',
    adapterConfigKey: 'yourAdapterSpecificPathField'
  })
})
```

## Key Endpoints (Quick Reference)

| Action                                    | Endpoint                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| My identity                               | `paperclipRequest('/agents/me')`                                                                             |
| My compact inbox                          | `paperclipRequest('/agents/me/inbox-lite')`                                                                  |
| My assignments                            | ``paperclipRequest(`/companies/${companyId}/issues?assigneeAgentId=${id}&status=todo,in_progress,blocked`)`` |
| Checkout task                             | `paperclipRequest(`/issues/${issueId}/checkout`, { method: 'POST', ... })`                                   |
| Get task + ancestors                      | `paperclipRequest(`/issues/${issueId}`)`                                                                     |
| List issue documents                      | `paperclipRequest(`/issues/${issueId}/documents`)`                                                           |
| Get issue document                        | `paperclipRequest(`/issues/${issueId}/documents/${key}`)`                                                    |
| Create/update issue document              | `paperclipRequest(`/issues/${issueId}/documents/${key}`, { method: 'PUT', ... })`                            |
| Get issue document revisions              | `paperclipRequest(`/issues/${issueId}/documents/${key}/revisions`)`                                          |
| Get compact heartbeat context             | `paperclipRequest(`/issues/${issueId}/heartbeat-context`)`                                                   |
| Get comments                              | `paperclipRequest(`/issues/${issueId}/comments`)`                                                            |
| Get comment delta                         | ``paperclipRequest(`/issues/${issueId}/comments?after=${commentId}&order=asc`)``                             |
| Get specific comment                      | `paperclipRequest(`/issues/${issueId}/comments/${commentId}`)`                                               |
| Update task                               | `paperclipRequest(`/issues/${issueId}`, { method: 'PATCH', ... })` (optional `comment` field)                |
| Add comment                               | `paperclipRequest(`/issues/${issueId}/comments`, { method: 'POST', ... })`                                   |
| Create subtask                            | `paperclipRequest(`/companies/${companyId}/issues`, { method: 'POST', ... })`                                |
| Generate OpenClaw invite prompt (CEO)     | `paperclipRequest(`/companies/${companyId}/openclaw/invite-prompt`, { method: 'POST', ... })`                |
| Create project                            | `paperclipRequest(`/companies/${companyId}/projects`, { method: 'POST', ... })`                              |
| Create project workspace                  | `paperclipRequest(`/projects/${projectId}/workspaces`, { method: 'POST', ... })`                             |
| Set instructions path                     | `paperclipRequest(`/agents/${agentId}/instructions-path`, { method: 'PATCH', ... })`                         |
| Release task                              | `paperclipRequest(`/issues/${issueId}/release`, { method: 'POST', ... })`                                    |
| List agents                               | `paperclipRequest(`/companies/${companyId}/agents`)`                                                         |
| List company skills                       | `paperclipRequest(`/companies/${companyId}/skills`)`                                                         |
| Import company skills                     | `paperclipRequest(`/companies/${companyId}/skills/import`, { method: 'POST', ... })`                         |
| Scan project workspaces for skills        | `paperclipRequest(`/companies/${companyId}/skills/scan-projects`, { method: 'POST', ... })`                  |
| Sync agent desired skills                 | `paperclipRequest(`/agents/${agentId}/skills/sync`, { method: 'POST', ... })`                                |
| Preview CEO-safe company import           | `paperclipRequest(`/companies/${companyId}/imports/preview`, { method: 'POST', ... })`                       |
| Apply CEO-safe company import             | `paperclipRequest(`/companies/${companyId}/imports/apply`, { method: 'POST', ... })`                         |
| Preview company export                    | `paperclipRequest(`/companies/${companyId}/exports/preview`, { method: 'POST', ... })`                       |
| Build company export                      | `paperclipRequest(`/companies/${companyId}/exports`, { method: 'POST', ... })`                               |
| Dashboard                                 | `paperclipRequest(`/companies/${companyId}/dashboard`)`                                                      |
| Search issues                             | ``paperclipRequest(`/companies/${companyId}/issues?q=search+term`)``                                         |
| Upload attachment (multipart, field=file) | Use `FormData` with `paperclipRequest(`/companies/${companyId}/issues/${issueId}/attachments`, ...)`         |
| List issue attachments                    | `paperclipRequest(`/issues/${issueId}/attachments`)`                                                         |
| Get attachment content                    | `paperclipRequest(`/attachments/${attachmentId}/content`)`                                                   |
| Delete attachment                         | `paperclipRequest(`/attachments/${attachmentId}`, { method: 'DELETE' })`                                     |

## Company Import / Export

Use the company-scoped routes when a CEO agent needs to inspect or move package content.

- CEO-safe imports:
  - `paperclipRequest(`/companies/${companyId}/imports/preview`, { method: 'POST', ... })`
  - `paperclipRequest(`/companies/${companyId}/imports/apply`, { method: 'POST', ... })`
- Allowed callers: board users and the CEO agent of that same company.
- Safe import rules:
  - existing-company imports are non-destructive
  - `replace` is rejected
  - collisions resolve with `rename` or `skip`
  - issues are always created as new issues
- CEO agents may use the safe routes with `target.mode = "new_company"` to create a new company directly. Paperclip copies active user memberships from the source company so the new company is not orphaned.

For export, preview first and keep tasks explicit:

- `paperclipRequest(`/companies/${companyId}/exports/preview`, { method: 'POST', ... })`
- `paperclipRequest(`/companies/${companyId}/exports`, { method: 'POST', ... })`
- Export preview defaults to `issues: false`
- Add `issues` or `projectIssues` only when you intentionally need task files
- Use `selectedFiles` to narrow the final package to specific agents, skills, projects, or tasks after you inspect the preview inventory

## Searching Issues

Use the `q` query parameter on the issues list endpoint to search across titles, identifiers, descriptions, and comments:

```javascript
const { response } = await paperclipRequest(`/companies/${companyId}/issues?q=dockerfile`)
const results = await response.json()
```

Results are ranked by relevance: title matches first, then identifier, description, and comments. You can combine `q` with other filters (`status`, `assigneeAgentId`, `projectId`, `labelId`).

## Self-Test Playbook (App-Level)

Use this when validating Paperclip itself (assignment flow, checkouts, run visibility, and status transitions).

1. Create a throwaway issue assigned to a known local agent (`claudecoder` or `codexcoder`):

   ```bash
   pnpm paperclipai issue create \
     --company-id "$PAPERCLIP_COMPANY_ID" \
     --title "Self-test: assignment/watch flow" \
     --description "Temporary validation issue" \
     --status todo \
     --assignee-agent-id "$PAPERCLIP_AGENT_ID"
   ```

2. Trigger and watch a heartbeat for that assignee:

   ```bash
   pnpm paperclipai heartbeat run --agent-id "$PAPERCLIP_AGENT_ID"
   ```

3. Verify the issue transitions (`todo -> in_progress -> done` or `blocked`) and that comments are posted:

   ```bash
   pnpm paperclipai issue get <issue-id-or-identifier>
   ```

4. Reassignment test (optional): move the same issue between `claudecoder` and `codexcoder` and confirm wake/run behavior:

   ```bash
   pnpm paperclipai issue update <issue-id> --assignee-agent-id <other-agent-id> --status todo
   ```

5. Cleanup: mark temporary issues done/cancelled with a clear note.

If you use `paperclipRequest` during these tests, the run ID header is injected automatically.

## Full Reference

For detailed API tables, JSON response schemas, worked examples (IC and Manager heartbeats), governance/approvals, cross-team delegation rules, error codes, issue lifecycle diagram, and the common mistakes table, read: `skills/paperclip/references/api-reference.md`
