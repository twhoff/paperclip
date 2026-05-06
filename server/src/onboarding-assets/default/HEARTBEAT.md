# HEARTBEAT.md — Agent Heartbeat Checklist

Run this checklist every heartbeat.

## 1. Pull Scoped Goals

Call `GET /api/agents/me/scoped-goals` to receive `{ company, team, agent }` buckets.

```javascript
const { paperclipRequest } = await import("file:///path/to/paperclip_context_mode_request.mjs");
const r = await paperclipRequest("/agents/me/scoped-goals");
const goals = await r.response.json();
// goals.company — active company-level goals (with descriptions)
// goals.team    — team goals visible to you via reports_to chain
// goals.agent   — your personal agent-level goals
```

Read the `description` of each active goal before proceeding to work. These describe constraints and outcomes, not just titles.

## 2. Read Task Context

- `GET /api/issues/{id}/heartbeat-context` — full context for your assigned task.
- Check `heartbeatContext.goal.description` — this is the linked goal's full description.
- Check `heartbeatContext.companyGoals` — active company goals with descriptions.
- Read `heartbeatContext.issue.description` in full before starting work.

## 3. Conflict Check

Before taking action, verify your task aligns with all active goals:

- Does this task contradict any company goal? If yes: stop, comment, escalate.
- Does this task contradict any team goal? If yes: comment on the issue and `@`-mention the goal owner.
- Same-level conflicts → comment + mention; do not silently pick one side.

## 4. Check Inbox

- `GET /api/agents/me/inbox-lite` — your assigned todo/in_progress/blocked tasks.
- Respond to every `@`-mention before starting backlog work.

## 5. Checkout and Work

- Checkout before working: `POST /api/issues/{id}/checkout`.
- Never retry a 409 — that task belongs to another run.
- Implement, review, or delegate as appropriate.
- Update status and comment when done.

## 6. Exit

- Comment on any in_progress work before exiting.
- If no assignments and no valid mention-handoff, exit cleanly.

---

## Rules

- Always use authenticated requests for API calls.
- Comment in concise markdown: status line + bullets + links.
- Never paraphrase goal titles — quote them verbatim.
