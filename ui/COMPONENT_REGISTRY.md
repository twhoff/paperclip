# Paperclip UI Component Registry

Shared primitives added or modified by engineers must be documented here. Include the entry in the same commit as the component change.

---

## ShutdownDialog

- **File:** `ui/src/components/ShutdownDialog.tsx`
- **Added in:** GRO-685 (commit b6a789ca)
- **Props:**
  ```typescript
  interface ShutdownDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }
  ```
- **Internal state:** `timeoutSec` (default 120, clamped 10–600), `exitProcess` (default false)
- **Variants:**
  - Default: agents drain only; server stays up
  - `exitProcess=true` (checkbox checked): destructive warning "The UI will disconnect" shown; server exits after drain
- **Board-only:** rendered exclusively for `pcli_board` actor sessions
- **Checkbox ID:** `#shutdown-exit-process` (for Playwright targeting)

---

## ShutdownBanner

- **File:** `ui/src/components/ShutdownBanner.tsx`
- **Added in:** GRO-685 (commit b6a789ca)
- **Props:** none (zero-prop component)
- **Behaviour:** Polls `GET /api/system/shutdown` every 2 s via `useShutdownStatus` hook; renders nothing when `phase === "idle"`
- **States:**
  - `draining` — amber pulse icon + "Draining N agents… Xs remaining" + Cancel button
  - `drained` — pause icon + "All agents paused" + "Resume agents" button (default variant)
  - `stopping` — red alert icon + "Stopping server…"
- **Board-only:** hidden for non-board sessions (parent `Layout.tsx` guards render)
