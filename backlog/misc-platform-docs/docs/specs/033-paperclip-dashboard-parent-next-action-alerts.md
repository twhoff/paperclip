---
title: "Dashboard parent next-action alerts for blocked child issues"
description: "Specify how the Paperclip dashboard should surface blocked child issues on parent issue alerts so managers see the real blocker instead of a vague waiting or stale state."
created: "2026-03-25"
modified: "2026-03-25"
status: needs_review
type: feature
owner: product-manager
version: 1
tags:
  - paperclip
  - dashboard
  - issue-management
  - alerts
related:
  - 001-core-product-overview.md
  - TIZA-247
  - 003-dashboard.md
authors:
  - product-manager
---

# Dashboard parent next-action alerts for blocked child issues

## Overview

The Paperclip dashboard currently generates parent-level next-action alerts when child issues are in backlog or actively progressing. Blocked child issues fall through that logic, so a parent can appear to be merely waiting or stale even when the real next step is to unblock a specific child issue.

This spec defines the product behaviour for surfacing blocked child issues clearly on the parent alert so managers can intervene quickly and direct the right owner.

## Goals

- Make blocked child issues visible at the parent issue level in the dashboard
- Show the most actionable next step for managers and leads
- Prevent blocked child issues from being hidden behind vague parent waiting states

## Non-Goals

- Changing the underlying issue lifecycle or blocked-state semantics
- Auto-reassigning or auto-unblocking issues
- Redesigning the broader dashboard layout beyond this alert logic

## Requirements

### Functional Requirements

| ID  | Requirement                                                                                                                                                                     | Priority |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F1  | When a parent issue has one or more child issues in `blocked`, the dashboard must generate a parent-level alert that explicitly indicates blocked child work exists.            | Must     |
| F2  | The alert must include the blocked child issue identifier(s) so the manager can trace the blocker quickly.                                                                      | Must     |
| F3  | When a blocked child issue has an assignee, the alert must name that assignee as the person who needs to unblock or escalate.                                                   | Must     |
| F4  | When a blocked child issue has no assignee, the alert must state that someone needs to unblock it rather than implying clear ownership.                                         | Must     |
| F5  | Blocked-child alerts must take precedence over passive “waiting on sub-issues” messaging for the same parent.                                                                   | Must     |
| F6  | If a parent has both blocked and backlog children, the dashboard should prioritise the blocked-child alert as the primary next action because it reflects an active impediment. | Should   |
| F7  | The alert should cap the number of child identifiers shown inline and summarise any remainder to keep the dashboard scannable.                                                  | Should   |

### Non-Functional Requirements

| ID  | Requirement                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------- |
| N1  | Alert text must stay concise enough for terminal dashboard scanning.                                                       |
| N2  | The added logic must preserve the existing dashboard refresh and render performance characteristics.                       |
| N3  | Regression coverage must verify blocked-child alert behaviour for assigned, unassigned, and mixed-status child issue sets. |

## Acceptance Criteria

- [ ] A parent issue with at least one blocked child shows a parent-level alert that explicitly references blocked child work.
- [ ] The alert includes at least one blocked child identifier and does not degrade into a generic stale-parent message.
- [ ] Assigned blocked children name the responsible assignee in the alert.
- [ ] Unassigned blocked children produce wording that makes missing ownership obvious.
- [ ] A parent with only in-progress, todo, or in-review children still uses the existing waiting-state messaging.
- [ ] Automated tests cover blocked-only and blocked-plus-backlog child scenarios.

## Design Notes

- Severity should be treated as action-required rather than informational because blocked child work represents an active delivery risk.
- The parent alert should help a manager decide what to do next in one glance: unblock, assign, or escalate.
- If multiple blocked children exist, the wording should stay short and favour the first few identifiers plus a remainder count.

## Open Questions

- [ ] Should blocked-child alerts always outrank backlog-child alerts, or should the dashboard render both when the parent has mixed child states?
- [ ] Should the parent alert surface the most recent blocker reason when that data is cheaply available?

## Changelog

| Version | Date       | Author          | Change        |
| ------- | ---------- | --------------- | ------------- |
| 1       | 2026-03-25 | product-manager | Initial draft |
