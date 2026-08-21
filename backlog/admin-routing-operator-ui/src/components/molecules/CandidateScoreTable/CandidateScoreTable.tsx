import { cn } from "@/lib/cn";
import type { CandidateScoreBreakdown } from "@/lib/services/routing-decisions.service";

interface CandidateScoreTableProps {
  breakdown: CandidateScoreBreakdown;
}

/**
 * Molecule: CandidateScoreTable
 *
 * Renders the full candidate score breakdown for a routing evaluation event.
 * Revealed inline when the user expands a TimelineEvent (AC5, AC11).
 * Read-only. WCAG: role="table" with scope="col" on headers.
 */
export function CandidateScoreTable({ breakdown }: CandidateScoreTableProps) {
  const hasPenalties = breakdown.candidates.some(
    (c) =>
      c.healthPenalty !== 0 ||
      c.recentFailurePenalty !== 0 ||
      c.rateLimitPenalty !== 0 ||
      c.cooldownPenalty !== 0
  );

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Candidate scores at{" "}
        {new Date(breakdown.createdAt).toLocaleString("en-AU", {
          timeZone: "UTC",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZoneName: "short",
        })}
      </p>

      <div className="overflow-x-auto">
        <table role="table" className="w-full min-w-[28rem] text-xs">
          <thead>
            <tr className="border-border border-b text-start">
              <th scope="col" className="text-muted-foreground pe-4 pb-1.5 font-medium">
                Adapter
              </th>
              <th scope="col" className="text-muted-foreground pe-4 pb-1.5 font-medium">
                Score
              </th>
              <th scope="col" className="text-muted-foreground pb-1.5 font-medium">
                Notes
              </th>
            </tr>
          </thead>
          <tbody>
            {breakdown.candidates.map((c) => (
              <tr
                key={c.id}
                className={cn(
                  "border-border/50 border-b last:border-0",
                  c.selected && "bg-primary/5"
                )}
              >
                <td className="py-1.5 pe-4 font-mono">
                  {c.adapterName}
                  {c.modelId && <span className="text-muted-foreground ms-1">({c.modelId})</span>}
                </td>
                <td className="py-1.5 pe-4 tabular-nums">
                  {c.allowed ? (
                    <span className={cn(c.selected && "font-semibold")}>
                      {c.totalScore.toFixed(2)}
                      {c.selected && (
                        <span className="text-primary ms-1" aria-label="selected">
                          ★
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground font-medium">EXCLUDED</span>
                  )}
                </td>
                <td className="text-muted-foreground py-1.5">
                  {c.selected && !c.excludedReason && (
                    <span className="text-foreground font-medium">SELECTED ★</span>
                  )}
                  {c.excludedReason && <span>EXCLUDED — {c.excludedReason}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasPenalties && (
        <div>
          <p className="text-foreground mb-1 text-xs font-medium">Penalties applied:</p>
          <ul className="text-muted-foreground space-y-0.5 text-xs">
            {breakdown.candidates.flatMap((c) => {
              const items: React.ReactNode[] = [];
              if (c.healthPenalty !== 0)
                items.push(
                  <li key={`${String(c.id)}-health`}>
                    · {c.adapterName}: −{Math.abs(c.healthPenalty).toFixed(2)} health penalty
                  </li>
                );
              if (c.recentFailurePenalty !== 0)
                items.push(
                  <li key={`${String(c.id)}-failure`}>
                    · {c.adapterName}: −{Math.abs(c.recentFailurePenalty).toFixed(2)} recent failure
                    penalty
                  </li>
                );
              if (c.rateLimitPenalty !== 0)
                items.push(
                  <li key={`${String(c.id)}-ratelimit`}>
                    · {c.adapterName}: −{Math.abs(c.rateLimitPenalty).toFixed(2)} rate limit penalty
                  </li>
                );
              if (!c.allowed && c.excludedReason)
                items.push(
                  <li key={`${String(c.id)}-excluded`}>
                    · {c.adapterName}: −∞ (excluded — {c.excludedReason})
                  </li>
                );
              return items;
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
