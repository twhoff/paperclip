# Backlog — extracted from tizzi-app

**Status:** 🟡 ON HOLD — _not integrated, not scheduled. Snapshot for a future decision._
**Added:** 2026-06-18
**Origin:** extracted from the `tizzi-app` repo (Tizzi product) where this code/docs had been misfiled.
**Owner decision needed:** re-home into `paperclip/ui` (and `pcli`), or drop and keep only the git pointer.

---

## TL;DR

This folder holds Paperclip/pcli material that was living inside the **Tizzi product app** by mistake and was extracted out of it. None of it belongs in Tizzi (a household executive-function app); all of it is **agent-platform / dev-tooling**. It is parked here, unmodified, so the Paperclip team can decide whether to adopt it.

Two independent piles:

| Folder | What it is | Decision |
|---|---|---|
| [`admin-routing-operator-ui/`](./admin-routing-operator-ui) | A read-only **operator UI for the pcli live-team-optimiser's per-agent AI-backend routing decisions** (44 files: routes, API, service, DB pool, 7 components, 2 design docs). | Re-home into `paperclip/ui` if optimiser observability is wanted. |
| [`misc-platform-docs/`](./misc-platform-docs) | 5 **unrelated** Paperclip-platform docs that were also misfiled in Tizzi. | File each into Paperclip docs where appropriate, or drop. |

---

## 1. `admin-routing-operator-ui/` — the substantial piece

### What it does

The pcli **live team optimiser** (`pcli agents team auto optimise` / `run-live-optimise.sh`) continuously reroutes each agent between AI backends and models — e.g. `copilot_cli`↔`claude_local`, `gpt-4o`↔`claude-sonnet` — to balance **cost, quality, and availability**. It records every decision (chosen adapter, candidate scores, cooldowns, shadow-mode trials, switch reasons) into the pcli-owned Postgres tables `pcli_optimiser_decisions`, `pcli_optimiser_candidate_scores`, `pcli_optimiser_evaluations`, `pcli_optimiser_policies`, and `pcli_agent_routing_state`.

**The gap this fills:** that optimiser is a black box — it silently swaps your agents' models, but there is no way to _see or audit why_. This is the missing **observability layer**: a read-only operator console that shows, per agent, the current adapter/model, cooldown + shadow-mode badges, the last switch and its reason ("Cost threshold exceeded"), and a per-decision drilldown with the candidate-scoring breakdown and a decision timeline.

It is purely read-only — the service header states _"All data comes from the `pcli_*` tables in the paperclip database. No UI-side inference."_

### The two design docs (read these first)

- `docs/specs/027-adapter-selection-v2.md` — **"Adapter Selection V2"**: a proposed redesign of the optimiser's routing _engine_ (one deterministic selector, explicit routing memory, candidate scoring, a decision→apply→config-revision audit chain). Was `needs_review` — **proposed, never ratified**. This is a `pcli` backend concern.
- `docs/wireframes/adapter-decision-drilldown.md` — **TIZA-589**: the operator UI wireframe the code implements (summary-first, progressive disclosure, WCAG 2.0 AA, operator-only — _not_ end-user navigation).

### Current state — why it's ON HOLD

- **The engine exists** (in `pcli`: `src/pcli/ai_advisor.py`, `commands/agents_cmd.py`, the adaptive schema). It writes the `pcli_optimiser_*` tables today.
- **The UI was built once, in the wrong repo** (Tizzi, via TIZA-589), and has now been removed from there. It was **never integrated into `paperclip/ui`** — confirmed by search, nothing here references `routing-decisions`, `adapter-decision-drilldown`, or these components.
- **Spec-027 (the V2 engine) was never ratified**, so the UI may show today's optimiser output rather than a "V2" chain.

### To adopt it (rough shape, not a committed plan)

1. Decide whether per-agent routing observability is actually wanted operationally.
2. Port the surface into `paperclip/ui` — **note:** this code is **Next.js App Router (RSC + route handlers)**; `paperclip/ui` is a different stack, so the route/API/RSC pieces need adapting to its framework. The pure components (`CandidateScoreTable`, `DecisionTimeline`, `AgentSummaryRow`, badges, `PolicyBindingList`) port with light changes.
3. Re-point `src/lib/pcli-db.ts` at the Paperclip operational Postgres (it already reads `PAPERCLIP_DB_*` env: host, port `54329`, db `paperclip`).
4. Keep it operator/admin-gated (it exposes per-agent routing internals).

### Inventory

- **Routes:** `src/app/[locale]/admin/routing/{page,​[agentId]/page,​AdminRouting.stories}.tsx`
- **API:** `src/app/api/admin/routing/decisions/**` (+ tests)
- **Data:** `src/lib/pcli-db.ts`, `src/lib/services/routing-decisions.service.ts` (+ test)
- **Components:** `CooldownBadge`, `ShadowModeBadge`, `CandidateScoreTable`, `TimelineEvent`, `DecisionTimeline`, `AgentSummaryRow`, `PolicyBindingList` (each with stories + tests)

---

## 2. `misc-platform-docs/` — five unrelated docs

Each is a standalone Paperclip-platform topic, not part of the UI above and not related to each other. They were simply misfiled in Tizzi's `docs/`:

| File | Topic |
|---|---|
| `docs/adr/024-git-worktree-lifecycle-management.md` | pcli worktree session lifecycle (one task = one worktree) |
| `docs/adr/025-context-mode-copilot-adapter-fix.md` | context-mode MCP / Copilot CLI adapter cost fix for heartbeats |
| `docs/specs/033-paperclip-dashboard-parent-next-action-alerts.md` | the Paperclip dashboard's blocked-issue alert logic for leads |
| `docs/specs/034-goals-ai-open-work-context.md` | the goals-AI `gather_goals_context` work-status definition |
| `docs/specs/platform-682-stale-lock-ttl-requirements.md` | `executionRunId` stale-lock clearance + TTL sweep (control-plane) |

---

## Provenance

- Removed from `tizzi-app` under **TIZA-1218** (North Star corpus audit + ownership probe: a 5-scout / 3-judge pass unanimously found this is Paperclip pcli-optimiser tooling, not Tizzi).
- Recoverable from `tizzi-app` git history: state **before** removal is commit `eeb9c9b5`; the removal commit is `87ecce75`.
- This folder is a verbatim snapshot — files are unmodified from the extraction.
