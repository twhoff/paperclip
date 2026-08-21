"use client";

import { useState, useId, useRef } from "react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/atoms/Button";
import type { CooldownState } from "@/lib/services/routing-decisions.service";

interface CooldownBadgeProps {
  cooldown: CooldownState;
  className?: string;
}

function formatRemaining(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${String(hours)}h ${String(rem)}m` : `${String(hours)}h`;
}

/**
 * Atom: CooldownBadge
 *
 * Displays an active cooldown with remaining duration.
 * Clickable — parent controls popover state via onToggle.
 * Uses icon + text, never colour-only (WCAG 2.1 AA, ADR-004).
 *
 * Colour is driven by the semantic `--color-warning*` tokens (ADR-002/ADR-018),
 * NOT raw `amber-*`/`dark:` utilities. The Tailwind `dark:` variant keys off the
 * OS `prefers-color-scheme`, so it ignored Storybook's colorMode toggle and the
 * badge rendered its dark treatment under a light story; the warning tokens
 * follow `data-mode`, so the badge now tracks light/dark correctly.
 */
export function CooldownBadge({ cooldown, className }: CooldownBadgeProps) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const remaining = formatRemaining(cooldown.remainingMs);
  const suppressedLabel = cooldown.suppressedAdapter
    ? `${cooldown.suppressedAdapter} suppressed`
    : "adapter suppressed";

  return (
    <div className="relative inline-block">
      <Button
        ref={buttonRef}
        id={triggerId}
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Cooldown active: ${remaining} remaining, ${suppressedLabel}`}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
        className={cn(
          "border-warning-border bg-warning text-warning-foreground hover:bg-warning-border/40 h-auto cursor-pointer gap-1 rounded-full border px-2 py-0.5 text-xs",
          className
        )}
      >
        <span aria-hidden="true">⏱</span>
        {remaining} remaining
      </Button>

      {open && (
        <>
          {/* Backdrop for closing */}
          <div
            className="fixed inset-0 z-40"
            aria-hidden="true"
            onClick={() => {
              setOpen(false);
            }}
          />
          <div
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${panelId}-heading`}
            className={cn(
              "border-border bg-popover absolute top-full left-0 z-50 mt-1.5 w-72 rounded-lg border p-4 shadow-lg",
              "text-popover-foreground text-sm"
            )}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                buttonRef.current?.focus();
              }
            }}
          >
            <h3 id={`${panelId}-heading`} className="text-foreground mb-3 font-semibold">
              Cooldown active
            </h3>
            <dl className="space-y-1.5 text-xs">
              {cooldown.suppressedAdapter && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Suppressed adapter</dt>
                  <dd className="font-mono">{cooldown.suppressedAdapter}</dd>
                </div>
              )}
              {cooldown.lastSwitchReason && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Rule triggered</dt>
                  <dd>{cooldown.lastSwitchReason}</dd>
                </div>
              )}
              {cooldown.lastSwitchAt && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Entered at</dt>
                  <dd>{new Date(cooldown.lastSwitchAt).toUTCString()}</dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Remaining</dt>
                <dd className="font-medium">{remaining}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Expires</dt>
                <dd>{new Date(cooldown.returnSuppressedUntil).toUTCString()}</dd>
              </div>
            </dl>
            <p className="text-muted-foreground mt-3 text-xs">
              After expiry, re-evaluation applies standard return-suppression rules.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-foreground mt-3 h-auto px-1 py-0 text-xs font-normal underline hover:bg-transparent hover:no-underline"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
            >
              Close
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
