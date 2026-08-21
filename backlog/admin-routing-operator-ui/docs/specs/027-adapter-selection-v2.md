---
title: "Adapter Selection V2"
description: "Specifies a deterministic adapter-routing subsystem for the live team optimiser, with explicit routing memory, candidate scoring, and a decision-to-apply audit chain that fits the existing Paperclip and pcli storage model."
created: "2026-03-31"
modified: "2026-03-31"
status: needs_review
type: feature
owner: product-manager
version: 1
tags:
  - pcli
  - live-optimiser
  - adapter-routing
  - auditability
  - observability
related:
  - 001-core-product-overview.md
  - adr/008-database-architecture
  - adr/021-documentation-standards
  - docs/pcli/paperclip-cli-architecture.md
  - docs/pcli/heartbeat-run-flow.md
  - docs/ERDs/adapter-selection-v2.md
authors:
  - product-manager
---

# Adapter Selection V2

## Overview

The current Live Optimiser can reroute agents between adapters, but adapter choice is still fragmented across rule handling, AI proposals, validation rewrites, and policy guards. That works for basic defensive fallback, but it becomes brittle under noisy operating conditions such as partial rate limiting, mixed failure modes, and transient blocked windows.

This spec defines Adapter Selection V2 as a dedicated routing subsystem for the pcli live optimiser. V2 introduces one deterministic selector, explicit routing memory, structured candidate scoring, and a clearer audit chain from decision intent to apply outcome to persisted config revision.

This spec is intentionally constrained by the existing architecture:

- Current live agent configuration remains in the Paperclip `agents` table.
- Persisted config diffs remain in the Paperclip `agent_config_revisions` table.
- Existing optimiser-owned operational state remains in pcli-owned Postgres tables such as `pcli_optimiser_decisions`, `pcli_run_metrics`, and `pcli_agent_health_state`.
- Adapter catalogs and model mappings are currently code-backed in `scripts/pcli-py/src/pcli/adapters.py`; V2 must not assume they are already normalised into database tables unless that work is explicitly included in scope.

## Goals

- Make one routing engine the single source of truth for all adapter switching decisions.
- Improve target selection quality using candidate filtering plus live operational evidence.
- Reduce oscillation with explicit routing memory, cooldowns, and return suppression.
- Preserve the existing agent health-state machine while separating it from routing hysteresis memory.
- Make each routing decision inspectable as a chain from evaluation to apply outcome to config revision.
- Keep the design compatible with the current Paperclip server and pcli table boundary.

## Non-Goals

- Redesigning the full Live Optimiser pipeline outside adapter selection.
- Replacing the existing agent health-state machine.
- Changing the definition of protected agents.
- Changing the business policy for OpenAI-locked agents.
- Replacing adaptive exploration, Thompson sampling, or config-performance learning outside the adapter-routing path.
- Mandating full DB normalisation of adapter and model catalogs in phase 1.
- Introducing machine-learning-based routing or opaque scoring models.

## Requirements

### Functional Requirements

| ID  | Requirement                                                                                                                                                                                                                                              | Priority |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| F1  | All adapter-changing paths in the live optimiser must go through one shared routing selector. No later stage may independently choose a different adapter.                                                                                               | Must     |
| F2  | The selector must build a candidate pool for an agent using policy constraints, health evidence, routing mode, blocked windows, and return-suppression state before selecting a target.                                                                  | Must     |
| F3  | Candidate ranking must consider more than static priority, including recent rate-limit evidence, recent failure burden, recent switch history, and temporary penalties from prior switch causes.                                                         | Must     |
| F4  | The system must maintain per-agent routing memory separate from the agent health-state machine. At minimum it must record previous adapter/model, last switch timestamp, last switch reason, return suppression, settle window, and blocked window data. | Must     |
| F5  | The selector must apply hysteresis rules so an agent does not immediately switch back to a recently abandoned adapter unless stronger disqualifying conditions leave no better valid option.                                                             | Must     |
| F6  | Adapter selection must occur before model normalisation. Once an adapter is selected, model repair must choose a valid model for that adapter without re-running adapter selection.                                                                      | Must     |
| F7  | Each evaluation must produce a structured decision record that includes current state, candidate set, exclusions, penalties, selected candidate, and a human-readable reason summary.                                                                    | Must     |
| F8  | Each apply attempt must record whether the intended change was applied, failed, or was logged in shadow mode. If a config revision is created, the apply record must link to that revision.                                                              | Must     |
| F9  | Human-readable optimiser output and memory notes must be derived from the same structured decision data as the persisted evaluation record.                                                                                                              | Must     |
| F10 | If the current adapter remains the best valid candidate after scoring and penalties, the selector must return `no_change`.                                                                                                                               | Must     |
| F11 | V2 must support shadow-mode or comparison-mode rollout where decisions are logged without mutating live agent config.                                                                                                                                    | Must     |
| F12 | Phase 1 must work with the current code-backed adapter catalog in `adapters.py`. A database-backed adapter catalog is optional follow-up work, not a prerequisite for the routing engine itself.                                                         | Should   |
| F13 | Adapter availability ownership must be explicit: manual override wins when present; otherwise availability is derived from trusted health evidence.                                                                                                      | Must     |
| F14 | The current live config source of truth must remain the Paperclip `agents` table; V2 must not create a parallel config authority.                                                                                                                        | Must     |

### Non-Functional Requirements

| ID  | Requirement                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------- |
| N1  | Given the same input context, policy constraints, and routing memory, the selector must produce the same result.      |
| N2  | The decision chain must be explainable enough that an operator can see why a winner beat the alternatives.            |
| N3  | The system must materially reduce immediate routing oscillation compared with V1.                                     |
| N4  | Routing state must remain lightweight and operationally cheap to query and maintain.                                  |
| N5  | The design must preserve the current storage boundary between Paperclip-owned tables and pcli-owned optimiser tables. |
| N6  | The scoring model must remain bounded and understandable; it must not become an unreviewable penalty dump.            |
| N7  | Shadow-mode divergence, cooldown activity, and apply failures must be measurable.                                     |

## Acceptance Criteria

- [ ] AC1 — Rule-triggered fallback, blocked-window reroutes, and lock-correction reroutes all use the same routing selector.
- [ ] AC2 — Validation no longer performs independent adapter rewrites; it validates legality and normalises the selected adapter/model result.
- [ ] AC3 — A routing evaluation persists the candidate set, exclusions, penalties, selected candidate, and explanation summary in a structured decision payload.
- [ ] AC4 — An apply record exists for each attempted V2 mutation and links to the resulting config revision when a revision is written.
- [ ] AC5 — The agent health-state machine remains separate from routing memory; health transitions still use the existing `pcli_agent_health_state` model.
- [ ] AC6 — Run evidence continues to use `pcli_run_metrics` without adding optimiser switch rationale into that table.
- [ ] AC7 — The selector honours manual adapter availability overrides over derived health availability.
- [ ] AC8 — Shadow mode can log V2 decisions without modifying the current config in `agents`.
- [ ] AC9 — Tests cover candidate exclusion, scoring, cooldown handling, no-change outcomes, and decision/apply/revision linkage.

## Design Notes

### Current Architecture Constraints

V2 must fit the existing storage and runtime model rather than replacing it.

- `agents` is the live config source of truth for `adapter_type`, `adapter_config`, and `runtime_config`.
- `agent_config_revisions` is the persisted audit log for before/after config changes.
- `pcli_optimiser_decisions` already stores evaluation-level snapshots and is used for impact measurement.
- `pcli_run_metrics` already mixes run evidence with config snapshot fields for per-config performance analysis.
- `pcli_agent_health_state` already implements a real health-state machine with structured reason codes, expiry windows, and escalation.

This means V2 should refine and extend those boundaries, not invent a second competing set of authorities.

### Conceptual Data Model

The target conceptual model is captured in [docs/ERDs/adapter-selection-v2.md](docs/ERDs/adapter-selection-v2.md).

Key concepts:

- Adapter catalog and adapter-model support
- Adapter health evidence
- Agent routing memory
- Existing agent health-state machine
- Policy constraints and policy binding
- Routing evaluation
- Candidate scoring
- Apply outcome
- Config revision linkage

### Source of Truth Rules

- Current agent config: `agents`
- Routing memory: new routing-memory record, separate from health state
- Health-state machine: `pcli_agent_health_state`
- Decision intent: extended `pcli_optimiser_decisions`
- Apply result: new apply-outcome record
- Persisted config revision: `agent_config_revisions`
- Adapter availability status: manual override if set, otherwise trusted derived health state

### Routing Flow

1. Gather current agent config, routing memory, agent health state, adapter health evidence, recent run evidence, blocked-window inputs, and relevant policy constraints.
2. Build the allowed candidate pool.
3. Apply hard exclusions.
4. Score remaining candidates using bounded, explainable penalties and preferences.
5. Select the best candidate or `no_change`.
6. Normalise the model for the chosen adapter.
7. Persist the evaluation record.
8. Attempt apply and persist apply outcome.
9. If config changes are written, link the apply record to the config revision row.
10. Emit human-readable output derived from the same decision payload.

### Rollout Constraint

The initial implementation should not require a full DB-backed adapter catalog. The routing engine can read its adapter/model support information from the existing code-backed catalog while producing structured evaluation and apply records. Catalog normalisation can be a later phase if still justified.

## Open Questions

- [ ] What exact thresholds define recent failure burden and rate-limit penalty in the first rollout?
- [ ] What default cooldown lengths should apply for rate limit, transient failure, and blocked-window exits?
- [ ] Should different agent classes receive different settle windows, or should V2 start with one global default?
- [ ] Should adapter catalog normalisation into DB tables be explicitly scoped into V2, or deferred until after routing stability is proven?
- [x] How much candidate-score detail should be exposed by default in operator-facing UI versus expanded drilldown views?
      **Resolved (2026-04-02, PM):** Progressive disclosure. Default view shows routing timeline events, cooldown state badge (with remaining duration), and shadow-mode indicators. Candidate score breakdowns are drill-down only (expand per decision event). Policy binding viewer is accessible per agent via expand, not shown inline by default. All detail is reachable within 2 interactions. See TIZA-589 PM decision comment.

## Changelog

| Version | Date       | Author          | Change                                                                                   |
| ------- | ---------- | --------------- | ---------------------------------------------------------------------------------------- |
| 1       | 2026-03-31 | product-manager | Initial repo-accurate draft for Adapter Selection V2.                                    |
| 2       | 2026-04-02 | product-manager | Resolved open question: operator UI drilldown scope — progressive disclosure (Branch A). |
