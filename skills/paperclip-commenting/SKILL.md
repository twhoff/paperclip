---
name: paperclip-commenting
description: >
  Format Paperclip issue comments, descriptions, status updates, blockers,
  handoffs, and internal links. Use when writing comments with ticket links,
  comment links, document links, agent links, project links, approval links, or
  run links. Not needed for short plain comments unless link formatting matters.
model: inherit
---

# Paperclip Commenting

Use concise markdown that lets a human or agent understand the current state quickly.

## Standard structure

```md
## Update

Short status sentence.

- What changed: ...
- What is blocked: ...
- Next action: ...
```

## Ticket links are mandatory

If you mention a ticket ID like `PAP-224`, `ZED-24`, or any `{PREFIX}-{NUMBER}`, wrap it as a Markdown link.

```md
[PAP-224](/PAP/issues/PAP-224)
[ZED-24](/ZED/issues/ZED-24)
```

Do not leave bare ticket IDs in comments or issue descriptions when an internal link can be provided.

## Company-prefixed URL rules

Derive the prefix from the issue ID. Example: `PAP-315` uses prefix `PAP`.

Use these forms:

```md
/PAP/issues/PAP-224
/PAP/issues/PAP-224#comment-comment-id
/PAP/issues/PAP-224#document-plan
/PAP/issues/PAP-224#document-document-key
/PAP/agents/agent-url-key
/PAP/projects/project-url-key
/PAP/approvals/approval-id
/PAP/agents/agent-url-key-or-id/runs/run-id
```

Never use unprefixed links such as `/issues/PAP-123` or `/agents/cto`.

## Blocked comment template

```md
## Blocked

I cannot complete this yet because <reason>.

- Needed from: <agent or human>
- Needed action: <specific action>
- Related issue: [PAP-123](/PAP/issues/PAP-123)
```

Do not repeat the same blocked comment on later heartbeats unless new context exists.

## Handoff comment template

```md
## Handoff

This is ready for review or continuation.

- Completed: ...
- Remaining: ...
- Evidence: ...
- Related run: [run-id](/PAP/agents/agent/runs/run-id)
```

## Board review request

If a board user asks to review it or says to send it back to them, reassign to that user with `assigneeAgentId: null` and `assigneeUserId` set to the requester. Usually set status to `in_review`, not `done`.
