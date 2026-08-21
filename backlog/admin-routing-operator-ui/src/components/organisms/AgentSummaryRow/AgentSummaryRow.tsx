import Link from "next/link";
import { cn } from "@/lib/cn";
import { CooldownBadge } from "@/components/atoms/CooldownBadge";
import { ShadowModeBadge } from "@/components/atoms/ShadowModeBadge";
import type { AgentSummary } from "@/lib/services/routing-decisions.service";

interface AgentSummaryRowProps {
  agent: AgentSummary;
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
}

/**
 * Organism: AgentSummaryRow
 *
 * One row in the routing decisions summary table (State 1 in wireframe).
 * Shows: agent name, current adapter, cooldown badge (when active),
 * shadow-mode badge (when active), last switch with relative timestamp.
 * Full-row click navigates to the agent timeline (State 2).
 *
 * Phone: renders as a stacked card.
 * Tablet+: renders as a table row (coordination with parent table).
 */
export function AgentSummaryRow({ agent }: AgentSummaryRowProps) {
  const href = `/admin/routing/${agent.agentId}`;

  return (
    <>
      {/* Phone layout: stacked card */}
      <div className="sm:hidden">
        <Link
          href={href}
          className={cn(
            "border-border bg-card block rounded-lg border p-4",
            "hover:bg-muted/40 focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
            "transition-colors"
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-foreground font-medium">{agent.agentName}</span>
            <div className="flex flex-wrap justify-end gap-1">
              {agent.shadowMode && <ShadowModeBadge />}
              {agent.cooldown && <CooldownBadge cooldown={agent.cooldown} />}
              {!agent.cooldown && !agent.shadowMode && (
                <span className="text-muted-foreground text-xs">Active</span>
              )}
            </div>
          </div>
          <div className="text-muted-foreground mt-2 space-y-0.5 text-xs">
            <div>
              Current adapter:{" "}
              <span className="text-foreground font-mono">{agent.currentAdapter ?? "—"}</span>
            </div>
            {agent.lastSwitchAt && (
              <div>
                Last switch: {formatRelativeTime(agent.lastSwitchAt)}
                {agent.lastSwitchReason && ` — ${agent.lastSwitchReason}`}
              </div>
            )}
            {agent.previousAdapter && agent.currentAdapter && (
              <div className="font-mono">
                {agent.previousAdapter} → {agent.currentAdapter}
              </div>
            )}
          </div>
          <div className="text-primary mt-3 text-xs font-medium">View decision timeline ›</div>
        </Link>
      </div>

      {/* Tablet/Desktop layout: table row */}
      <tr
        className={cn(
          "border-border hidden border-b last:border-b-0 sm:table-row",
          "hover:bg-muted/40 cursor-pointer transition-colors"
        )}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            window.location.href = href;
          }
        }}
        role="row"
        onClick={() => {
          window.location.href = href;
        }}
        aria-label={`View decision timeline for ${agent.agentName}`}
      >
        {/* Agent name + shadow badge */}
        <td className="py-3 pe-4 align-top">
          <div className="flex flex-col gap-1">
            <span className="text-foreground font-medium">{agent.agentName}</span>
            {agent.shadowMode && <ShadowModeBadge />}
          </div>
        </td>

        {/* Current adapter */}
        <td className="py-3 pe-4 align-top">
          <span className="font-mono text-sm">{agent.currentAdapter ?? "—"}</span>
          {agent.currentModel && (
            <div className="text-muted-foreground text-xs">{agent.currentModel}</div>
          )}
        </td>

        {/* Cooldown */}
        <td className="py-3 pe-4 align-top">
          {agent.cooldown ? (
            <CooldownBadge cooldown={agent.cooldown} />
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
          )}
        </td>

        {/* Last switch */}
        <td className="py-3 align-top">
          <div className="space-y-0.5 text-sm">
            {agent.lastSwitchAt ? (
              <>
                <div className="text-muted-foreground">
                  {formatRelativeTime(agent.lastSwitchAt)}
                  {agent.lastSwitchReason && ` — ${agent.lastSwitchReason}`}
                </div>
                {agent.previousAdapter && agent.currentAdapter && (
                  <div className="font-mono text-xs">
                    {agent.previousAdapter} → {agent.currentAdapter}
                  </div>
                )}
                <Link
                  href={href}
                  className="text-primary focus-visible:outline-ring block text-xs hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                >
                  Details ›
                </Link>
              </>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        </td>
      </tr>
    </>
  );
}
