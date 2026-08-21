"use client";

import { useEffect, useState, useCallback } from "react";
import { AgentSummaryRow } from "@/components/organisms/AgentSummaryRow";
import type { AgentSummary } from "@/lib/services/routing-decisions.service";

/**
 * Page: /admin/routing — Adapter Routing Decisions (State 1)
 *
 * Summary view: one row per agent with current adapter, cooldown badge,
 * shadow-mode indicator, and last switch event.
 * Full-row click navigates to the agent decision timeline.
 * AC1–AC4, AC9, AC10, AC14, AC15.
 */
export default function RoutingDecisionsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/routing/decisions");
      if (!res.ok) throw new Error("Failed to load routing decisions");
      const data = (await res.json()) as AgentSummary[];
      setAgents(data);
      setLastRefreshed(new Date());
    } catch {
      setError("Could not load routing decisions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Adapter Routing Decisions</h1>
        <div className="flex items-center gap-3">
          {lastRefreshed && (
            <span className="text-muted-foreground text-xs">
              Updated {lastRefreshed.toLocaleTimeString("en-AU", { hour12: false })}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              void load();
            }}
            disabled={loading}
            className="border-border bg-card hover:bg-muted focus-visible:outline-ring rounded-md border px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}

      {!error && agents.length === 0 && !loading && (
        <p className="text-muted-foreground text-sm">No routing decisions recorded yet.</p>
      )}

      {agents.length > 0 && (
        <>
          {/* Phone: stacked cards (hidden sm+) */}
          <div className="space-y-3 sm:hidden">
            {agents.map((agent) => (
              <AgentSummaryRow key={agent.agentId} agent={agent} />
            ))}
          </div>

          {/* Tablet/Desktop: table */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm" role="table">
              <thead>
                <tr className="border-border border-b text-left">
                  <th scope="col" className="text-muted-foreground pr-4 pb-2 font-medium">
                    Agent
                  </th>
                  <th scope="col" className="text-muted-foreground pr-4 pb-2 font-medium">
                    Current adapter
                  </th>
                  <th scope="col" className="text-muted-foreground pr-4 pb-2 font-medium">
                    Cooldown
                  </th>
                  <th scope="col" className="text-muted-foreground pb-2 font-medium">
                    Last switch
                  </th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <AgentSummaryRow key={agent.agentId} agent={agent} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
