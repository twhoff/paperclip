---
title: "Goals AI open-work context coverage"
description: "Define which issue statuses count as open work for goals AI context gathering so review, alignment, suggestion, and closure flows do not ignore blocked or in-review work."
created: "2026-03-25"
modified: "2026-03-25"
status: needs_review
type: feature
owner: product-manager
version: 1
tags:
  - paperclip
  - goals
  - ai
  - issue-management
related:
  - 001-core-product-overview.md
  - TIZA-245
authors:
  - product-manager
---

# Goals AI open-work context coverage

## Overview

The goals AI workflows depend on `gather_goals_context` to decide what work is still active against company goals. Today that helper keeps `backlog`, `todo`, and `in_progress` issues, but drops `blocked` and `in_review`. That gives the AI an incomplete picture of real open work and can lead to misleading health analysis, alignment suggestions, or closure recommendations.

This spec defines the status coverage for “open work” in goals AI so the system reflects delivery reality instead of an artificially narrow subset.

## Goals

- Ensure goals AI sees all meaningful open work linked to goals
- Prevent blocked or in-review work from being treated as if it no longer exists
- Keep goal review, alignment, suggestion, and closure flows consistent with dashboard and workflow concepts of active work

## Non-Goals

- Changing the semantic meaning of issue statuses across Paperclip
- Including `done` or `cancelled` issues in open-work context
- Redesigning the goals AI prompts beyond the status-coverage correction

## Requirements

### Functional Requirements

| ID  | Requirement                                                                                                                                                                                        | Priority |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F1  | `gather_goals_context` must treat `backlog`, `todo`, `in_progress`, `blocked`, and `in_review` as open work for goals AI context assembly.                                                         | Must     |
| F2  | `done` and `cancelled` issues must remain excluded from goals AI open-work context.                                                                                                                | Must     |
| F3  | The resulting context must preserve blocked and in-review issues for all goals AI flows that rely on `gather_goals_context`, including review, alignment, suggestion, and closure analysis.        | Must     |
| F4  | Summary statistics derived from goals AI context must count blocked and in-review issues within total open issues and goal-linked open work.                                                       | Must     |
| F5  | The implementation should continue fetching issues without server-side multi-status query params and apply the status filter client-side, preserving compatibility with the current API behaviour. | Must     |
| F6  | Regression tests should explicitly prove that blocked and in-review issues remain in the gathered context.                                                                                         | Must     |

### Non-Functional Requirements

| ID  | Requirement                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------- |
| N1  | The change must not materially increase goals AI context gathering latency or API round-trips.                                |
| N2  | Test coverage must protect against future narrowing of the open-status set.                                                   |
| N3  | The open-work definition used by goals AI should remain understandable to operators reading command output and code comments. |

## Acceptance Criteria

- [ ] A blocked issue returned by the issues endpoint is preserved in goals AI context and counted as open work.
- [ ] An in-review issue returned by the issues endpoint is preserved in goals AI context and counted as open work.
- [ ] Done and cancelled issues are still excluded from goals AI open-work context.
- [ ] Goals AI commands that consume gathered context no longer risk treating blocked-only or in-review-only goal work as cleared.
- [ ] Regression tests cover mixed issue-status payloads and fail if blocked or in-review statuses are filtered out.
- [ ] The implementation continues to fetch issues without adding server-side status query params.

## Design Notes

- For strategic AI workflows, blocked work is still open work because it continues to affect goal health and delivery risk.
- In-review work is also still open work because it is not yet verified or complete.
- This is primarily a context-integrity correction, not a product-surface redesign.

## Open Questions

- [ ] Should the goals AI review output explicitly call out the presence of blocked work as a separate risk signal once the context is corrected?
- [ ] Are there any other Paperclip features still using a narrower open-status definition than dashboard and workflow views?

## Changelog

| Version | Date       | Author          | Change        |
| ------- | ---------- | --------------- | ------------- |
| 1       | 2026-03-25 | product-manager | Initial draft |
