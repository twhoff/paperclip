import { cn } from "@/lib/cn";
import type { PolicyBinding } from "@/lib/services/routing-decisions.service";

interface PolicyBindingListProps {
  policies: PolicyBinding[];
}

/**
 * Organism: PolicyBindingList
 *
 * Read-only list of policy cards for a single agent (State 4 in wireframe).
 * Shows each active policy with its binding state for this agent.
 * Positive framing: "NOT BOUND ✓" where possible (wireframe spec).
 * WCAG: each card is role="region" with aria-label.
 */
export function PolicyBindingList({ policies }: PolicyBindingListProps) {
  if (policies.length === 0) {
    return <p className="text-muted-foreground text-sm">No active policies configured.</p>;
  }

  return (
    <div className="space-y-3">
      {policies.map((policy) => (
        <PolicyCard key={policy.policyId} policy={policy} />
      ))}
      <p className="text-muted-foreground text-xs">
        Policy state is read-only. Changes require manual intervention via the operator config API.
      </p>
    </div>
  );
}

function PolicyCard({ policy }: { policy: PolicyBinding }) {
  const bound = policy.bound;

  return (
    <div
      role="region"
      aria-label={`Policy: ${policy.policyName}`}
      className={cn(
        "rounded-lg border p-4",
        bound ? "border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/20" : "border-border bg-card"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">Policy: {policy.policyName}</p>
          <p className="text-muted-foreground text-xs capitalize">
            {policy.policyType} · {policy.appliesTo}
          </p>
        </div>
        <StatusChip bound={bound} />
      </div>
      <PolicyImplication policy={policy} />
    </div>
  );
}

function StatusChip({ bound }: { bound: boolean }) {
  if (!bound) {
    return (
      <span
        className="border-border bg-muted/50 text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium"
        aria-label="Not bound"
      >
        NOT BOUND ✓
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
      aria-label="Bound — restriction active"
    >
      BOUND ⚠
    </span>
  );
}

function PolicyImplication({ policy }: { policy: PolicyBinding }) {
  if (!policy.bound) {
    // Derive a positive implication per policy type
    const implications: Record<string, string> = {
      "openai-locked": "No restriction on OpenAI adapters",
      "copilot-cli-only": "Can route to any available adapter",
      "manual-override": "Routing decisions managed by V2 selector",
    };
    const implication = implications[policy.policyName] ?? "No active restriction from this policy";

    return <p className="text-muted-foreground mt-1.5 text-xs">Implication: {implication}</p>;
  }

  return (
    <p className="mt-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">
      Implication: Routing constrained by this policy binding.
    </p>
  );
}
