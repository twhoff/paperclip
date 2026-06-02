import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock, PauseCircle, RotateCcw, ServerOff, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "../context/ToastContext";
import { agentsApi } from "../api/agents";
import { shutdownApi } from "../api/shutdown";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { summarizeShutdownImpact } from "../lib/shutdown-impact";
import { cn } from "../lib/utils";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 600;
const EXIT_CONFIRMATION = "STOP SERVER";

function clampTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.floor(value)));
}

function invalidateShutdownSurfaces(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.shutdown });
  void queryClient.invalidateQueries({ queryKey: ["agents"] });
  void queryClient.invalidateQueries({ queryKey: ["org"] });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  void queryClient.invalidateQueries({ queryKey: ["sidebar-badges"] });
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function ImpactMetric({
  icon: Icon,
  label,
  value,
  tone = "default",
}: {
  icon: typeof Users;
  label: string;
  value: string | number;
  tone?: "default" | "warning" | "muted";
}) {
  return (
    <div
      className={cn(
        "flex min-h-16 items-center gap-3 rounded-md border px-3 py-2",
        tone === "warning"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-200"
          : tone === "muted"
            ? "border-border bg-muted/30"
            : "border-border bg-background",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="text-base font-semibold leading-5">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

interface ShutdownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShutdownDialog({ open, onOpenChange }: ShutdownDialogProps) {
  const [timeoutSec, setTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SECONDS);
  const [reason, setReason] = useState("");
  const [exitProcess, setExitProcess] = useState<boolean>(false);
  const [exitConfirmation, setExitConfirmation] = useState("");
  const { companies } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const agentQueries = useQueries({
    queries: companies.map((company) => ({
      queryKey: queryKeys.agents.list(company.id),
      queryFn: () => agentsApi.list(company.id),
      enabled: open,
      staleTime: 5_000,
    })),
  });
  const impact = useMemo(
    () =>
      summarizeShutdownImpact(
        companies.map((company, index) => ({
          company,
          agents: agentQueries[index]?.data,
          isLoading: agentQueries[index]?.isLoading,
          isError: agentQueries[index]?.isError,
        })),
      ),
    [agentQueries, companies],
  );
  const clampedTimeoutSec = clampTimeoutSeconds(timeoutSec);
  const exitConfirmed = !exitProcess || exitConfirmation.trim().toUpperCase() === EXIT_CONFIRMATION;

  useEffect(() => {
    if (!open) return;
    setTimeoutSec(DEFAULT_TIMEOUT_SECONDS);
    setReason("");
    setExitProcess(false);
    setExitConfirmation("");
  }, [open]);

  const initiate = useMutation({
    mutationFn: async () => {
      return shutdownApi.initiate({
        timeoutMs: clampedTimeoutSec * 1000,
        exitProcess,
        reason: reason.trim() || null,
      });
    },
    onSuccess: (state) => {
      queryClient.setQueryData(queryKeys.shutdown, state);
      invalidateShutdownSurfaces(queryClient);
      pushToast({
        title: exitProcess ? "Drain started; server will stop." : "Drain started; agents will pause.",
        body: exitProcess
          ? "You can cancel while the drain is still running."
          : "The server stays available for manual work and resume.",
        tone: "info",
        ttlMs: 0,
      });
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed to start shutdown";
      pushToast({ title: message, tone: "error" });
    },
  });

  const buttonLabel = exitProcess ? "Drain agents, then stop server" : "Drain agents and pause";
  const affectedCopy =
    impact.loadingCompanyCount > 0
      ? "Checking agents..."
      : `${impact.affectedAgentCount} ${pluralize(impact.affectedAgentCount, "agent")} will be paused`;
  const submitDisabled = initiate.isPending || !exitConfirmed;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Shut down agent activity?</DialogTitle>
          <DialogDescription>
            Applies across every company in this instance. Agents stop accepting new work,
            current runs drain until the timeout, and shutdown-paused agents can be resumed later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <div className="grid gap-2 sm:grid-cols-4">
            <ImpactMetric icon={Users} label="Affected" value={affectedCopy} />
            <ImpactMetric
              icon={Clock}
              label="Running now"
              value={impact.loadingCompanyCount > 0 ? "..." : impact.runningAgentCount}
              tone={impact.runningAgentCount > 0 ? "warning" : "default"}
            />
            <ImpactMetric
              icon={PauseCircle}
              label="Already paused"
              value={impact.loadingCompanyCount > 0 ? "..." : impact.alreadyPausedCount}
              tone="muted"
            />
            <ImpactMetric icon={RotateCcw} label="Companies" value={impact.companyCount} tone="muted" />
          </div>

          {impact.errorCompanyCount > 0 && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Agent impact failed to load for {impact.errorCompanyCount}{" "}
              {pluralize(impact.errorCompanyCount, "company", "companies")}. Shutdown still applies globally.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
            <div className="space-y-2">
              <Label htmlFor="shutdown-timeout" className="text-sm font-medium">
                Drain timeout
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="shutdown-timeout"
                  type="number"
                  inputMode="numeric"
                  min={MIN_TIMEOUT_SECONDS}
                  max={MAX_TIMEOUT_SECONDS}
                  value={timeoutSec}
                  onChange={(e) => setTimeoutSec(Number(e.target.value) || DEFAULT_TIMEOUT_SECONDS)}
                  onBlur={() => setTimeoutSec(clampedTimeoutSec)}
                  className="w-28"
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Force-cancels remaining in-flight runs after {clampedTimeoutSec}s.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="shutdown-reason" className="text-sm font-medium">
                Reason
              </Label>
              <Textarea
                id="shutdown-reason"
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Maintenance, end of day, budget hold..."
                className="min-h-20 resize-none"
              />
              <p className="text-xs text-muted-foreground">
                Saved in shutdown activity logs. Optional.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Server behavior</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                aria-pressed={!exitProcess}
                onClick={() => {
                  setExitProcess(false);
                  setExitConfirmation("");
                }}
                className={cn(
                  "flex min-h-24 items-start gap-3 rounded-md border p-3 text-left transition-colors",
                  !exitProcess
                    ? "border-primary/50 bg-primary/10"
                    : "border-border bg-background hover:bg-accent/40",
                )}
              >
                <PauseCircle className="mt-0.5 size-4 shrink-0" />
                <span>
                  <span className="block text-sm font-medium">Keep server running</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Agents pause after drain. Board, pcli, Holly, and manual work stay available.
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-pressed={exitProcess}
                onClick={() => setExitProcess(true)}
                className={cn(
                  "flex min-h-24 items-start gap-3 rounded-md border p-3 text-left transition-colors",
                  exitProcess
                    ? "border-destructive/60 bg-destructive/10"
                    : "border-border bg-background hover:bg-accent/40",
                )}
              >
                <ServerOff className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span>
                  <span className="block text-sm font-medium">Stop server after drain</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    The UI disconnects after drain completes. You can cancel only while draining.
                  </span>
                </span>
              </button>
            </div>
          </div>

          {exitProcess && (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-3">
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>Stopping the server ends this UI session after the drain finishes.</span>
              </div>
              <Label htmlFor="shutdown-exit-confirmation" className="text-xs text-muted-foreground">
                Type {EXIT_CONFIRMATION} to enable server stop.
              </Label>
              <Input
                id="shutdown-exit-confirmation"
                value={exitConfirmation}
                onChange={(event) => setExitConfirmation(event.target.value)}
                autoComplete="off"
                aria-invalid={!exitConfirmed}
              />
            </div>
          )}

          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Cancel is available while draining. Resume is available after agents are paused.
            Terminated agents stay untouched.
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={initiate.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => initiate.mutate()}
            disabled={submitDisabled}
          >
            {initiate.isPending ? "Starting…" : buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
