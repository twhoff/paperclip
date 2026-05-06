import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, PauseCircle, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "./StatusBadge";
import { shutdownApi, type ShutdownState } from "../api/shutdown";
import { queryKeys } from "../lib/queryKeys";
import { useShutdownStatus } from "../hooks/useShutdownStatus";
import { useToast } from "../context/ToastContext";

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

interface BannerProps {
  state: ShutdownState;
}

function bannerClasses(phase: ShutdownState["phase"]) {
  if (phase === "drained") {
    return "border-b border-border bg-muted text-foreground";
  }
  return "border-b border-destructive/30 bg-destructive/10 text-foreground";
}

function DrainingDescription({ state }: BannerProps) {
  const now = useNow(1000);
  const deadline = state.deadline ? Date.parse(state.deadline) : null;
  const remaining = deadline !== null ? deadline - now : null;
  const count = state.inFlightAgentCount;
  const noun = count === 1 ? "agent" : "agents";
  return (
    <span>
      Draining {count} {noun}…
      {remaining !== null && (
        <span className="text-muted-foreground"> {formatRemaining(remaining)} remaining</span>
      )}
    </span>
  );
}

function ResumeButton({ from }: { from: "draining" | "drained" }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const resume = useMutation({
    mutationFn: () => shutdownApi.resume(),
    onSuccess: (state) => {
      queryClient.setQueryData(queryKeys.shutdown, state);
      pushToast({
        title: from === "draining" ? "Shutdown cancelled." : "Agents resumed.",
        tone: "success",
      });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Failed to resume";
      pushToast({ title: message, tone: "error" });
    },
  });
  return (
    <Button
      size="sm"
      variant={from === "drained" ? "default" : "outline"}
      onClick={() => resume.mutate()}
      disabled={resume.isPending}
    >
      {from === "drained" ? "Resume agents" : "Cancel shutdown"}
    </Button>
  );
}

function Icon({ phase }: { phase: ShutdownState["phase"] }) {
  if (phase === "stopping") return <AlertCircle className="size-4 text-destructive" />;
  if (phase === "drained") return <PauseCircle className="size-4 text-muted-foreground" />;
  return <Power className="size-4 text-amber-600 dark:text-amber-400 animate-pulse" />;
}

function PhaseDescription({ state }: BannerProps) {
  if (state.phase === "draining") return <DrainingDescription state={state} />;
  if (state.phase === "drained") {
    return (
      <span>
        All agents paused —{" "}
        <span className="text-muted-foreground">system available for manual use.</span>
      </span>
    );
  }
  return <span>Stopping server…</span>;
}

export function ShutdownBanner() {
  const { data: state } = useShutdownStatus();
  if (!state || state.phase === "idle") return null;

  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-2 ${bannerClasses(state.phase)}`}>
      <div className="flex items-center gap-2 text-sm">
        <Icon phase={state.phase} />
        <StatusBadge status={state.phase} />
        <PhaseDescription state={state} />
      </div>
      {state.phase !== "stopping" && (
        <ResumeButton from={state.phase === "draining" ? "draining" : "drained"} />
      )}
    </div>
  );
}
