# Adapter Decision Drilldown — Operator UI Wireframe

**Issue:** TIZA-589
**Author:** UI/UX Lead
**Date:** 2026-04-06
**Status:** Draft
**Spec:** docs/specs/027-adapter-selection-v2.md

---

## Summary

Operator-facing read-only UI for inspecting V2 adapter routing decisions. Progressive disclosure pattern: summary view is scannable across all agents, with opt-in drilldown per decision event within 2 interactions.

**Design principles:**

- **Summary first** — the default view must be immediately scannable without opening any drill-down
- **Progressive disclosure** — detail is always available but never imposed
- **Read-only** — no mutation of routing, cooldown, or policy state from this surface
- **Cognitive efficiency** — minimal chrome, dense information in structured tables, no decorative chrome
- **Accessible** — WCAG 2.0 AA; keyboard-navigable expand/collapse; status badges have text labels (not colour-only)

**Placement:** Operator settings tab or admin panel, not user-facing navigation. Accessible at `/settings?tab=routing` or equivalent operator route.

---

## Viewport strategy

This is operator-facing (not end-user-facing). Tablet and desktop are primary; phone is graceful degradation only. The information density required makes phone a secondary concern — key tables are horizontally scrollable on phone rather than collapsed.

---

## State 1 — Default Summary View

The entry state. All agents visible. Each agent row shows: current adapter, cooldown badge (if active), shadow-mode indicator (if active), last switch event with timestamp and reason.

### Phone (sm) — Horizontal scroll

```
┌───────────────────────────────────────────┐
│  [←] Adapter Routing Decisions            │  ← header
├───────────────────────────────────────────┤
│  Showing decisions for all agents  [⟳]    │  ← refresh; right-aligned
├───────────────────────────────────────────┤
│ ╔═════════════════════════════════════════╗ │
│ ║ Senior Engineer 1              [Active] ║ │  ← agent name + status badge
│ ╠═════════════════════════════════════════╣ │
│ ║ Current adapter: claude-sonnet-4.6      ║ │
│ ║ Last switch: 2h ago — circuit_breaker   ║ │
│ ║ codex_local → claude-sonnet-4.6         ║ │
│ ║                                         ║ │
│ ║ [No cooldown active]                    ║ │
│ ║                                         ║ │
│ ║ [ View decision timeline ›]             ║ │  ← tap → State 2 (agent drilldown)
│ ╚═════════════════════════════════════════╝ │
│                                             │
│ ╔═════════════════════════════════════════╗ │
│ ║ Senior Engineer 2              [Active] ║ │
│ ╠═════════════════════════════════════════╣ │
│ ║ Current adapter: claude-sonnet-4.6      ║ │
│ ║ Last switch: 4h ago — circuit_breaker   ║ │
│ ║ codex_local → claude-sonnet-4.6         ║ │
│ ║                                         ║ │
│ ║ ⏱ Cooldown: 12m remaining              ║ │  ← cooldown badge (text + duration)
│ ║ codex_local suppressed                  ║ │
│ ║                                         ║ │
│ ║ [ View decision timeline ›]             ║ │
│ ╚═════════════════════════════════════════╝ │
│                                             │
│ ╔═════════════════════════════════════════╗ │
│ ║ QA Lead                    [🔬 Shadow]  ║ │  ← shadow-mode badge
│ ╠═════════════════════════════════════════╣ │
│ ║ Current adapter: copilot_cli            ║ │
│ ║ Last decision: 20m ago — shadow         ║ │
│ ║ (no config change applied)              ║ │
│ ║                                         ║ │
│ ║ [No cooldown active]                    ║ │
│ ║                                         ║ │
│ ║ [ View decision timeline ›]             ║ │
│ ╚═════════════════════════════════════════╝ │
│                                             │
│  · · ·  (additional agents)                │
└───────────────────────────────────────────┘
```

### Tablet / Desktop (md+) — Table layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Adapter Routing Decisions                                      [⟳ Refresh]  │
├────────────────┬────────────────────┬──────────────┬────────────────────────┤
│ Agent          │ Current adapter    │ Cooldown     │ Last switch            │
├────────────────┼────────────────────┼──────────────┼────────────────────────┤
│ SE 1           │ claude-sonnet-4.6  │ —            │ 2h ago circuit_breaker │
│                │                    │              │ codex_local → claude   │
│                │                    │              │ [ Details › ]          │
├────────────────┼────────────────────┼──────────────┼────────────────────────┤
│ SE 2           │ claude-sonnet-4.6  │ ⏱ 12m       │ 4h ago circuit_breaker │
│                │                    │ codex_local  │ codex_local → claude   │
│                │                    │ suppressed   │ [ Details › ]          │
├────────────────┼────────────────────┼──────────────┼────────────────────────┤
│ QA Lead 🔬     │ copilot_cli        │ —            │ 20m ago (shadow)       │
│ [Shadow mode]  │                    │              │ no config change       │
│                │                    │              │ [ Details › ]          │
├────────────────┼────────────────────┼──────────────┼────────────────────────┤
│ Lead Engineer  │ claude-sonnet-4.6  │ —            │ 1h ago policy_bind     │
│                │                    │              │ gpt-4.1 → claude       │
│                │                    │              │ [ Details › ]          │
└────────────────┴────────────────────┴──────────────┴────────────────────────┘
```

**Notes:**

- `[Details ›]` link within the last-switch cell opens the **agent decision timeline** (State 2). 1 interaction.
- Cooldown badge: `⏱ {N}m remaining` — icon + text. Never colour-only.
- Shadow mode badge: `🔬 Shadow` — visible on both agent name cell and last-decision cell.
- No cooldown active: renders `—` (em-dash), not empty.
- Table rows are clickable (full row click = same as `[ Details › ]`). `cursor-pointer`, `hover:bg-muted/40`.
- Keyboard: arrow keys navigate rows; Enter/Space activates.

---

## State 2 — Agent Decision Timeline

Accessed from State 1 by clicking any row or `[ Details › ]`. Shows the full decision history for a single agent.

```
┌──────────────────────────────────────────────────────────────┐
│  [← Back]  Decision Timeline: Senior Engineer 2              │
│            Current: claude-sonnet-4.6 · No cooldown active   │
├──────────────────────────────────────────────────────────────┤
│  Policy binding          [Inspect policies ›]                │  ← AC7, 1 interaction
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ─── Today 04:00 UTC ────────────────────────────────────── │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ● APPLIED    claude-sonnet-4.6  ←  codex_local        │  │  ← applied (bold dot)
│  │   Reason: circuit_breaker (10 consecutive failures)    │  │
│  │   Candidates evaluated: 3                              │  │
│  │   Duration in previous: 47m                            │  │
│  │   [ Expand candidate scores ▾ ]                        │  │  ← AC5, 1 interaction
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ─── Today 03:13 UTC ────────────────────────────────────── │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ● APPLIED    codex_local  ←  claude-sonnet-4.6         │  │
│  │   Reason: exploration (Thompson sampling)              │  │
│  │   Candidates evaluated: 2                              │  │
│  │   Duration in previous: 2h 15m                         │  │
│  │   [ Expand candidate scores ▾ ]                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ─── Yesterday ──────────────────────────────────────────── │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ ◌ SHADOW     gpt-4.1 would have been selected         │  │  ← shadow (open dot)
│  │   Reason: rate_limit_evidence (openai lower burden)    │  │
│  │   (No config change applied — shadow mode)             │  │
│  │   [ Expand candidate scores ▾ ]                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Notes:**

- `● APPLIED` — filled circle, `text-foreground`. Adapter actually changed.
- `◌ SHADOW` — open circle, `text-muted-foreground italic`. Decision logged, no config mutation.
- `─── Date ───` section dividers by day (or UTC date boundary).
- `[← Back]` returns to State 1. Browser `popstate` supported.
- `[ Inspect policies › ]` opens State 4 (policy binding) in 1 interaction.
- `[ Expand candidate scores ▾ ]` expands inline → State 3 (candidate scores). 1 interaction.
- `no_change` decisions are omitted from the timeline to reduce noise. (If the result was "no change needed", the last timeline event will be the last actual switch.)

---

## State 3 — Candidate Score Breakdown (inline expand)

Expanded inline within a timeline event row. Activated via `[ Expand candidate scores ▾ ]`. Collapse via `[ ▴ ]`.

```
┌────────────────────────────────────────────────────────────────┐
│ ● APPLIED    claude-sonnet-4.6  ←  codex_local                 │
│   Reason: circuit_breaker (10 consecutive failures)            │
│   Candidates evaluated: 3                                      │
│   Duration in previous: 47m                                    │
│   [ Collapse ▴ ]                                               │
│                                                                │
│   ┌──────────────────────────────────────────────────────┐     │
│   │ Candidate scores at 2026-04-06 04:00:17 UTC          │     │
│   ├──────────────────┬────────────┬──────────────────────┤     │
│   │ Adapter          │ Score      │ Notes                │     │
│   ├──────────────────┼────────────┼──────────────────────┤     │
│   │ claude-sonnet-4.6│  0.92 ★    │ SELECTED             │     │
│   │ gpt-5.4-mini     │  0.61      │ —                    │     │
│   │ codex_local      │  EXCLUDED  │ circuit_breaker ×10  │     │
│   └──────────────────┴────────────┴──────────────────────┘     │
│                                                                │
│   Penalties applied:                                           │
│   · codex_local: −0.40 circuit_breaker penalty                 │
│   · codex_local: −∞ (excluded — consecutive failure limit)     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Notes:**

- Selected candidate: `★` marker + `SELECTED` note in table.
- Excluded candidates: `EXCLUDED` label with reason, score cell shows `EXCLUDED` not a number.
- Penalties listed below the table as a bullet list (not a separate column — avoid overflow on phone).
- This panel is scrollable on phone if content overflows.
- WCAG: `role="region"` with `aria-label="Candidate scores for {timestamp}"`.

---

## State 4 — Policy Binding Viewer

Accessed from State 2 via `[ Inspect policies › ]`. Shows active policy bindings for the agent. Read-only.

```
┌──────────────────────────────────────────────────────────────┐
│  [← Timeline]  Policy Bindings: Senior Engineer 2            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Policy: openai-locked                                  │  │
│  │ Status: NOT BOUND ✓                                    │  │  ← clear positive framing
│  │ Implication: No restriction on OpenAI adapters         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Policy: copilot-cli-only                               │  │
│  │ Status: NOT BOUND ✓                                    │  │
│  │ Implication: Can route to any available adapter        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Policy: manual-override                                │  │
│  │ Status: NOT ACTIVE ✓                                   │  │
│  │ Implication: Routing decisions managed by V2 selector  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  Policy state is read-only. Changes require manual          │
│  intervention via the operator config API.                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Notes:**

- Positive status framing where possible (`NOT BOUND ✓`) — avoids alarm fatigue for non-issues.
- If a binding IS active: `BOUND ⚠` + clear implication (e.g. "Agent restricted to OpenAI adapters only").
- Read-only disclaimer at bottom.
- `[← Timeline]` returns to State 2.

---

## State 5 — Cooldown Drilldown (inline expand)

Accessed from State 1 by clicking a `⏱ Cooldown` badge. Expands within the summary row (phone) or as a popover (tablet/desktop). Alternatively, a `[ View cooldown rule › ]` link appears in the cooldown cell on hover/focus.

```
┌──────────────────────────────────────────────────────────────┐
│  Cooldown: codex_local — Senior Engineer 2                   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Rule triggered: circuit_breaker                             │
│  Duration: 30 minutes                                        │
│  Entered: 2026-04-06 04:00:17 UTC                            │
│  Remaining: 12 minutes                                       │
│  Suppressed adapters: codex_local                            │
│                                                              │
│  Effect: codex_local excluded from candidate pool until      │
│  cooldown expires. After expiry, re-evaluation applies       │
│  standard return-suppression rules.                          │
│                                                              │
│  [ Close ]                                                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Notes:**

- This is a lightweight overlay / accordion — not a full-page navigation.
- On tablet/desktop: renders as a popover anchored to the cooldown badge (role="dialog", aria-modal).
- On phone: accordion expand below the cooldown badge row.
- `[ Close ]` dismisses. Escape key also closes. Focus returns to badge on close (ADR-004).

---

## Navigation map

```
State 1 (Summary: all agents)
  │
  ├─ Click row / [ Details › ]  ──────────────→  State 2 (Agent timeline)
  │                                                   │
  │                                                   ├─ [ Expand scores ▾ ]  → State 3 (Candidate scores, inline)
  │                                                   │
  │                                                   └─ [ Inspect policies › ] → State 4 (Policy bindings)
  │
  └─ Click cooldown badge  ────────────────────→  State 5 (Cooldown drilldown, overlay)
```

All paths from State 1 reach full detail within 2 interactions. ✓ AC8.

---

## Accessibility annotations

| Element                 | ARIA / focus rule                                                            |
| ----------------------- | ---------------------------------------------------------------------------- |
| Summary table rows      | `role="row"`, `tabIndex={0}`, `onKeyDown` Enter/Space = activate             |
| Status badges           | `aria-label="Cooldown active: 12 minutes remaining, codex_local suppressed"` |
| Shadow-mode badge       | `aria-label="Shadow mode active — decisions logged but not applied"`         |
| Expand/collapse buttons | `aria-expanded`, `aria-controls` pointing to expanded panel ID               |
| Candidate score tables  | `role="table"`, `scope="col"` on headers                                     |
| Policy binding panels   | `role="region"`, `aria-label="Policy: {name}"`                               |
| Cooldown popover        | `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to heading  |
| Close (popover)         | Focus returns to triggering badge on close                                   |
| Colour usage            | All status indicators use text labels, not colour alone                      |

---

## Copy / labelling guide

| UI element             | Copy                                     |
| ---------------------- | ---------------------------------------- |
| Section heading        | `Adapter Routing Decisions`              |
| Refresh button         | `Refresh` (visible label, not icon-only) |
| Timeline applied event | `APPLIED`                                |
| Timeline shadow event  | `SHADOW`                                 |
| No cooldown            | `—` (em-dash)                            |
| Cooldown badge         | `⏱ {N}m remaining`                       |
| Shadow badge           | `🔬 Shadow mode`                         |
| Excluded candidate     | `EXCLUDED — {reason}`                    |
| Selected candidate     | `SELECTED ★`                             |
| Expand link            | `Expand candidate scores`                |
| Collapse link          | `Collapse`                               |
| Policy inspect link    | `Inspect policies`                       |
| Back navigation        | `← Back` / `← Timeline`                  |

---

## Component inventory

| Component               | Atomic level | Notes                                                                    |
| ----------------------- | ------------ | ------------------------------------------------------------------------ |
| `AgentSummaryRow`       | Organism     | One row per agent in summary table; contains all badges and trigger link |
| `CooldownBadge`         | Molecule     | Icon + duration text; click triggers State 5                             |
| `ShadowModeBadge`       | Atom         | Icon + label; no interaction                                             |
| `DecisionTimeline`      | Organism     | Ordered list of timeline events for one agent                            |
| `TimelineEvent`         | Molecule     | Applied or shadow event card; contains expand trigger                    |
| `CandidateScoreTable`   | Organism     | Inline expandable; table of candidates + penalties                       |
| `PolicyBindingList`     | Organism     | List of policy cards per agent                                           |
| `CooldownDetail`        | Molecule     | Popover/accordion detail panel for cooldown rules                        |
| `DecisionDrilldownPage` | Template     | Wraps agent timeline view with back navigation                           |

---

## Responsive summary

| Viewport            | Layout                                                  | Notes                                |
| ------------------- | ------------------------------------------------------- | ------------------------------------ |
| phone (< 640px)     | Stacked agent cards; horizontal scroll on table rows    | Primary interaction via card tap     |
| tablet (640–1024px) | Summary table with moderate column widths               | Full table visible                   |
| desktop (1024px+)   | Full-width summary table; side-by-side where beneficial | Most comfortable operator experience |
