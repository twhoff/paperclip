import { TimelineEvent } from "@/components/molecules/TimelineEvent";
import type { DecisionEvent } from "@/lib/services/routing-decisions.service";

interface DecisionTimelineProps {
  agentId: string;
  events: DecisionEvent[];
}

function groupByDay(events: DecisionEvent[]): [string, DecisionEvent[]][] {
  const groups = new Map<string, DecisionEvent[]>();
  for (const event of events) {
    const date = new Date(event.createdAt);
    const label = isToday(date)
      ? "Today"
      : isYesterday(date)
        ? "Yesterday"
        : date.toLocaleDateString("en-AU", {
            timeZone: "UTC",
            day: "numeric",
            month: "short",
            year: "numeric",
          });
    const group = groups.get(label) ?? [];
    group.push(event);
    groups.set(label, group);
  }
  return Array.from(groups.entries());
}

function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate()
  );
}

function isYesterday(date: Date): boolean {
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return (
    date.getUTCFullYear() === yesterday.getUTCFullYear() &&
    date.getUTCMonth() === yesterday.getUTCMonth() &&
    date.getUTCDate() === yesterday.getUTCDate()
  );
}

/**
 * Organism: DecisionTimeline
 *
 * Renders the full ordered decision history for a single agent (State 2).
 * Groups events by day with visual dividers.
 * Each event is individually expandable for candidate scores (AC5).
 * Applied events: ● APPLIED. Shadow events: ◌ SHADOW (AC3).
 */
export function DecisionTimeline({ agentId, events }: DecisionTimelineProps) {
  if (events.length === 0) {
    return <p className="text-muted-foreground text-sm">No routing decisions recorded yet.</p>;
  }

  const groups = groupByDay(events);

  return (
    <div className="space-y-6">
      {groups.map(([label, dayEvents]) => (
        <section key={label}>
          <div className="mb-3 flex items-center gap-3">
            <div className="bg-border h-px flex-1" />
            <span className="text-muted-foreground text-xs font-medium">{label} UTC</span>
            <div className="bg-border h-px flex-1" />
          </div>
          <ul className="space-y-2" aria-label={`Routing events — ${label}`}>
            {dayEvents.map((event) => (
              <TimelineEvent key={event.id} event={event} agentId={agentId} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
