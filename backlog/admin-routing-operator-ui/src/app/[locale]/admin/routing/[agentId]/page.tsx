"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { DecisionTimeline } from "@/components/organisms/DecisionTimeline";
import { PolicyBindingList } from "@/components/organisms/PolicyBindingList";
import { CooldownBadge } from "@/components/atoms/CooldownBadge";
import { ShadowModeBadge } from "@/components/atoms/ShadowModeBadge";
import type {
  DecisionEvent,
  CooldownState,
  PolicyBinding,
} from "@/lib/services/routing-decisions.service";

interface AgentTimelinePageProps {
  params: Promise<{ agentId: string }>;
}

type PoliciesView = "hidden" | "loading" | "loaded" | "error";

/**
 * Page: /admin/routing/[agentId] — Agent Decision Timeline (State 2)
 *
 * Full timeline for one agent. Supports inline candidate score expansion
 * (State 3, within TimelineEvent). Policy binding viewer (State 4)
 * accessible via "Inspect policies" button — 1 interaction from this view.
 * AC1–AC15.
 */
export default function AgentTimelinePage({ params }: AgentTimelinePageProps) {
  const { agentId } = use(params);

  const [events, setEvents] = useState<DecisionEvent[]>([]);
  const [cooldown, setCooldown] = useState<CooldownState | null>(null);
  const [currentAdapter, setCurrentAdapter] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [policies, setPolicies] = useState<PolicyBinding[]>([]);
  const [policiesView, setPoliciesView] = useState<PoliciesView>("hidden");

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/admin/routing/decisions/${agentId}`);
        if (!res.ok) throw new Error("Failed to load timeline");
        const data = (await res.json()) as DecisionEvent[];
        setEvents(data);
        const firstEvent = data[0];
        if (firstEvent) {
          setAgentName(firstEvent.afterAdapter ?? agentId);
          setCurrentAdapter(firstEvent.afterAdapter);
          // Extract cooldown from the summary endpoint for this agent
          const summaryRes = await fetch("/api/admin/routing/decisions");
          if (summaryRes.ok) {
            const summaries = (await summaryRes.json()) as {
              agentId: string;
              agentName: string;
              currentAdapter: string | null;
              cooldown: CooldownState | null;
            }[];
            const me = summaries.find((s) => s.agentId === agentId);
            if (me) {
              setAgentName(me.agentName);
              setCurrentAdapter(me.currentAdapter);
              setCooldown(me.cooldown);
            }
          }
        }
      } catch {
        setError("Could not load agent timeline.");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [agentId]);

  async function loadPolicies() {
    if (policiesView === "loaded") {
      setPoliciesView("hidden");
      return;
    }
    setPoliciesView("loading");
    try {
      const res = await fetch(`/api/admin/routing/decisions/${agentId}/policies`);
      if (!res.ok) throw new Error("Failed to load policies");
      const data = (await res.json()) as PolicyBinding[];
      setPolicies(data);
      setPoliciesView("loaded");
    } catch {
      setPoliciesView("error");
    }
  }

  const activeShadow = events[0]?.shadowMode;

  return (
    <div className="space-y-6">
      {/* Back navigation */}
      <div>
        <Link
          href="/admin/routing"
          className="text-muted-foreground hover:text-foreground focus-visible:outline-ring text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          ← Back
        </Link>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Decision Timeline: {agentName || agentId}</h1>
          {currentAdapter && (
            <p className="text-muted-foreground mt-0.5 text-sm">
              Current: <span className="text-foreground font-mono">{currentAdapter}</span>
              {cooldown ? null : " · No cooldown active"}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {activeShadow && <ShadowModeBadge />}
          {cooldown && <CooldownBadge cooldown={cooldown} />}
        </div>
      </div>

      {/* Policy binding access (Interaction 1 → State 4) */}
      <div className="border-border bg-card flex items-center gap-3 rounded-lg border px-4 py-2.5">
        <span className="text-muted-foreground text-sm">Policy binding</span>
        <button
          type="button"
          onClick={() => {
            void loadPolicies();
          }}
          disabled={policiesView === "loading"}
          className="text-primary focus-visible:outline-ring ml-auto text-sm underline hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
        >
          {policiesView === "loading"
            ? "Loading…"
            : policiesView === "loaded"
              ? "Hide policies ▴"
              : "Inspect policies ›"}
        </button>
      </div>

      {policiesView === "error" && (
        <p className="text-destructive text-sm" role="alert">
          Could not load policy bindings.
        </p>
      )}

      {policiesView === "loaded" && (
        <section aria-label="Policy bindings">
          <PolicyBindingList policies={policies} />
        </section>
      )}

      {/* Timeline */}
      {loading && <p className="text-muted-foreground text-sm">Loading timeline…</p>}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && <DecisionTimeline agentId={agentId} events={events} />}
    </div>
  );
}
