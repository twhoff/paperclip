---
title: "Platform Requirements: Stale executionRunId Lock Clearance"
status: draft
issue: TIZA-682
related:
  - 001-core-product-overview.md
---

# Platform Requirements: Stale executionRunId Lock Clearance

**Issue:** TIZA-682  
**Date:** 2026-04-03  
**Author:** Lead Engineer  
**Status:** Draft — awaiting Paperclip control-plane team review

---

## Problem Statement

When an agent run terminates abnormally (rate_limit, error, timeout, cancellation), the `executionRunId` field on locked issues is **not cleared**. This leaves issues locked indefinitely, blocking the next agent heartbeat from checking them out via the checkout API.

### Confirmed Incidents

| Date (UTC)        | Issue    | Run ID     | Termination Cause    | Outcome             |
| ----------------- | -------- | ---------- | -------------------- | ------------------- |
| 2026-04-01 ~20:00 | TIZA-675 | —          | Abnormal termination | Manual PATCH by CEO |
| 2026-04-02 ~22:25 | TIZA-627 | `684d615d` | Rate limit / timeout | Manual PATCH by CEO |
| 2026-04-02 ~22:45 | TIZA-655 | `05c7c417` | Rate limit / timeout | Manual PATCH by CEO |

**Frequency:** ~2–3 incidents per day. Each requires CEO or EM manual intervention to PATCH the issue and bypass the lock ownership check.

---

## Current Behaviour

1. Agent calls `POST /api/issues/{id}/checkout` → `executionRunId` is set to the run's ID.
2. Run terminates with status `failed`, `rate_limit`, `cancelled`, or `error`.
3. `executionRunId` is **never cleared** — it remains pointing at a dead run.
4. Next agent heartbeat attempts checkout → rejected (lock owned by dead run).
5. Issue is stuck until manual PATCH.

---

## Required Fixes

### Fix 1 — Run-Termination Hook (Primary, High Priority)

**Trigger:** When a run transitions to any terminal state:

- `failed`
- `rate_limit`
- `cancelled`
- `error`
- `timeout` (if applicable)

**Action:** For every issue where `executionRunId = <this run's ID>`, clear `executionRunId` to `null` (and `executionLockedAt` to `null` if that field exists).

**Rationale:** This is the most deterministic fix. The control plane knows exactly when a run ends — it should atomically release all locks held by that run.

**Scope:** All issues across all companies, not just TIZA.

---

### Fix 2 — TTL-Based Expiry (Safety Net, Medium Priority)

**Trigger:** Periodic sweep (suggested: every 5–10 minutes).

**Logic:** For each issue where `executionRunId IS NOT NULL`:

1. Look up the associated run's `updatedAt` (or `lastHeartbeatAt` if available).
2. If `now - run.updatedAt > TTL`, clear the lock.

**Suggested TTL:** 30 minutes. Agent heartbeats run frequently; a 30-minute-old run that hasn't updated is almost certainly dead.

**Rationale:** Handles edge cases where the termination hook fires but fails, or where the run state machine has a bug. Belt-and-suspenders defence.

---

## Acceptance Criteria

- [ ] When a run transitions to `failed` / `rate_limit` / `cancelled` / `error`, all issues it holds (`executionRunId` = run ID) are unlocked within 60 seconds.
- [ ] Issues locked by a run whose `updatedAt` is older than 30 minutes are cleared by the background sweep.
- [ ] A subsequent `POST /api/issues/{id}/checkout` on a previously-stale-locked issue succeeds without manual PATCH.
- [ ] No issues are incorrectly unlocked while their owning run is still active.
- [ ] The fix is backwards-compatible — no schema changes visible to agent code.

---

## Non-Goals

- This does not change the checkout API contract.
- This does not require any changes to the Tizzi application codebase.
- This does not address the root cause of why runs terminate abnormally (that is a separate concern).

---

## Impact if Not Fixed

- Delivery velocity is degraded every few hours when lock cascades occur.
- CEO/EM attention is drained on manual remediation instead of product decisions.
- Multi-agent parallelism reliability is undermined — agents cannot trust that checked-out issues will eventually become available.

---

## Suggested Implementation Path (for Paperclip team)

1. Add a `onRunStatusChange` hook in the run state machine that, on terminal transition, runs:  
   `UPDATE issues SET executionRunId = NULL, executionLockedAt = NULL WHERE executionRunId = $runId`
2. Add a scheduled job (cron, 5–10 min interval) that sweeps for issues where the associated run is terminal or `updatedAt` > TTL.
3. Deploy to staging, verify with a controlled run failure.
4. Deploy to production.

---

## References

- TIZA-673 — lock incident log
- TIZA-675 — prior incident (2026-04-01)
- TIZA-674 — circuit-breaker recovery
