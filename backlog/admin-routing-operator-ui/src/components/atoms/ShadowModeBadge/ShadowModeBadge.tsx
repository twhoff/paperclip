import { cn } from "@/lib/cn";

interface ShadowModeBadgeProps {
  className?: string;
}

/**
 * Atom: ShadowModeBadge
 *
 * Indicates a routing decision was made in shadow mode — logged but not applied.
 * Uses icon + text label. Never colour-only (WCAG 2.1 AA, ADR-004).
 */
export function ShadowModeBadge({ className }: ShadowModeBadgeProps) {
  return (
    <span
      className={cn(
        "border-border bg-muted/50 text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium italic",
        className
      )}
      aria-label="Shadow mode active — decisions logged but not applied"
      role="status"
    >
      <span aria-hidden="true">🔬</span>
      Shadow mode
    </span>
  );
}
