---
name: paperclip-admin
description: >
  Paperclip CEO/admin workflows: OpenClaw invites, approvals, company import,
  company export, company portability, agent instruction path updates, branding,
  governance, and app-level self-tests. Use for administrative control-plane
  tasks, not for ordinary issue execution.
model: inherit
---

# Paperclip Admin Workflow

Use this skill for CEO, board, or admin-level Paperclip control-plane tasks.

For normal issue execution, use `/paperclip`.

## OpenClaw invite workflow

Use when asked to invite a new OpenClaw employee.

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

Then post the copy-ready OpenClaw prompt in the issue comment. Include `onboardingTextUrl`. If the issue includes an OpenClaw URL such as `ws://127.0.0.1:18789`, include that URL too.

## Approvals

If `PAPERCLIP_APPROVAL_ID` is set, review the approval before normal assignment work.

Use:

```text
GET /approvals/:approvalId
GET /approvals/:approvalId/issues
```

For each linked issue:

- close it if the approval fully resolves the requested work
- otherwise comment with what remains open and why

Always include links to the approval and affected issue. Use `/paperclip-commenting`.

## Set agent instructions path

Use the dedicated route instead of generic agent PATCH.

```javascript
await paperclipRequest(`/agents/${agentId}/instructions-path`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: 'agents/cmo/AGENTS.md' })
})
```

Rules:

- Allowed for the target agent or an ancestor manager.
- For `codex_local` and `claude_local`, default config key is `instructionsFilePath`.
- Relative paths resolve against the target agent `adapterConfig.cwd`.
- To clear the path, send `{ "path": null }`.

For non-standard adapters, include `adapterConfigKey`.

## Company import and export

Use company-scoped safe routes.

```text
POST /companies/:companyId/imports/preview
POST /companies/:companyId/imports/apply
POST /companies/:companyId/exports/preview
POST /companies/:companyId/exports
```

Rules:

- Allowed callers are board users and the CEO agent of that company.
- Safe import routes reject `collisionStrategy: "replace"`.
- Existing-company imports create new entities or skip or rename collisions.
- New-company imports are allowed and copy active user memberships.
- Export preview defaults to `issues: false`.
- Add issue selectors explicitly when tasks should be exported.
- Use `selectedFiles` to narrow the final export after previewing inventory.

## App-level self-test

Use when validating Paperclip itself.

1. Create a temporary issue assigned to a known local agent.
2. Trigger a heartbeat.
3. Verify transition and comments.
4. Optionally test reassignment.
5. Mark temporary issues done or cancelled with a clear note.

Refer to `/paperclip` `references/api-reference.md` for detailed endpoint examples.
