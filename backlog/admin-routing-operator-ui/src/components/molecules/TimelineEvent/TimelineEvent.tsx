"use client";

import { useState, useId } from "react";
import { cn } from "@/lib/cn";
import { CandidateScoreTable } from "@/components/molecules/CandidateScoreTable";
import type { DecisionEvent } from "@/lib/services/routing-decisions.service";
import type { CandidateScoreBreakdown } from "@/lib/services/routing-decisions.service";

interface TimelineEventProps {
  event: DecisionEvent;
  agentId: string;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-AU", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

/**
 * Molecule: TimelineEvent
 *
 * Renders a single routing decision event in the agent timeline.
 * Supports inline expansion of candidate scores (AC5).
 * Applied events: filled circle ●; shadow events: open circle ◌.
 * Keyboard-accessible expand/collapse with aria-expanded + aria-controls.
 */
export function TimelineEvent({ event, agentId }: TimelineEventProps) {
  const [expanded, setExpanded] = useState(false);
  const [scores, setScores] = useState<CandidateScoreBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  const isShadow = event.shadowMode;

  async function handleExpand() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (scores) {
      setExpanded(true);
      return;
    }
    if (!event.evaluationId) {
      setExpanded(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/routing/decisions/${agentId}/evaluation/${String(event.evaluationId)}`
      );
      if (!res.ok) throw new Error("Failed to load scores");
      const data = (await res.json()) as CandidateScoreBreakdown;
      setScores(data);
      setExpanded(true);
    } catch {
      setError("Could not load candidate scores.");
    } finally {
      setLoading(false);
    }
  }

  const adapterChange = event.afterAdapter
    ? `${event.afterAdapter}${event.afterModel ? ` (${event.afterModel})` : ""} ← ${event.beforeAdapter ?? "?"}`
    : null;

  return (
    <li
      className={cn(
        "rounded-lg border p-3 transition-colors",
        isShadow ? "border-border/50 bg-muted/20" : "border-border bg-card"
      )}
    >
      <div className="flex items-start gap-2.5">
        {/* Applied/shadow indicator */}
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 flex-shrink-0 text-base leading-none",
            isShadow ? "text-muted-foreground" : "text-foreground"
          )}
        >
          {isShadow ? "◌" : "●"}
        </span>

        <div className="min-w-0 flex-1">
          {/* Header row */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span
              className={cn(
                "text-xs font-semibold tracking-wide uppercase",
                isShadow ? "text-muted-foreground italic" : "text-foreground"
              )}
            >
              {isShadow ? "SHADOW" : "APPLIED"}
            </span>
            {adapterChange && (
              <span className="text-foreground font-mono text-xs">{adapterChange}</span>
            )}
          </div>

          {/* Reason */}
          {event.reason && (
            <p className="text-muted-foreground mt-0.5 text-xs">Reason: {event.reason}</p>
          )}

          {/* Metadata */}
          <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            <span>{formatTimestamp(event.createdAt)}</span>
            {event.candidateCount > 0 && <span>Candidates evaluated: {event.candidateCount}</span>}
          </div>

          {/* Expand trigger */}
          {event.evaluationId && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => {
                void handleExpand();
              }}
              disabled={loading}
              className={cn(
                "mt-2 text-xs underline hover:no-underline",
                "focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
                "disabled:opacity-50"
              )}
            >
              {loading ? "Loading…" : expanded ? "Collapse ▴" : "Expand candidate scores ▾"}
            </button>
          )}

          {error && <p className="text-destructive mt-1 text-xs">{error}</p>}

          {/* Candidate scores panel */}
          {expanded && (
            <div
              id={panelId}
              role="region"
              aria-label={`Candidate scores for ${formatTimestamp(event.createdAt)}`}
              className="mt-3"
            >
              {scores ? (
                <CandidateScoreTable breakdown={scores} />
              ) : (
                <p className="text-muted-foreground text-xs">No candidate score data available.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
