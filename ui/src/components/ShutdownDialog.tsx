import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "../context/ToastContext";
import { shutdownApi } from "../api/shutdown";
import { queryKeys } from "../lib/queryKeys";

const DEFAULT_TIMEOUT_SECONDS = 120;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 600;

interface ShutdownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShutdownDialog({ open, onOpenChange }: ShutdownDialogProps) {
  const [timeoutSec, setTimeoutSec] = useState<number>(DEFAULT_TIMEOUT_SECONDS);
  const [exitProcess, setExitProcess] = useState<boolean>(false);
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const initiate = useMutation({
    mutationFn: async () => {
      const clamped = Math.min(
        MAX_TIMEOUT_SECONDS,
        Math.max(MIN_TIMEOUT_SECONDS, Math.floor(timeoutSec)),
      );
      return shutdownApi.initiate({
        timeoutMs: clamped * 1000,
        exitProcess,
      });
    },
    onSuccess: (state) => {
      queryClient.setQueryData(queryKeys.shutdown, state);
      void queryClient.invalidateQueries({ queryKey: queryKeys.shutdown });
      pushToast({
        title: exitProcess ? "Draining and stopping server…" : "Draining agents…",
        body: exitProcess
          ? "Agents will finish their current task, then the server will exit."
          : "Agents will finish their current task and pause. The system stays available.",
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

  const buttonLabel = exitProcess ? "Shut down agents & exit server" : "Shut down agents";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Shut down agents?</DialogTitle>
          <DialogDescription>
            All agents will finish their current task and pause. The system stays
            available so you can use it via pcli or Holly without agents triggering.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="shutdown-timeout" className="text-xs text-muted-foreground">
              Drain timeout (seconds) — after this, in-flight runs are force-cancelled.
            </Label>
            <Input
              id="shutdown-timeout"
              type="number"
              inputMode="numeric"
              min={MIN_TIMEOUT_SECONDS}
              max={MAX_TIMEOUT_SECONDS}
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(Number(e.target.value) || DEFAULT_TIMEOUT_SECONDS)}
              className="w-32"
            />
          </div>

          <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
            <Checkbox
              id="shutdown-exit-process"
              checked={exitProcess}
              onCheckedChange={(checked) => setExitProcess(checked === true)}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <Label htmlFor="shutdown-exit-process" className="text-sm font-medium cursor-pointer">
                Also stop the server process
              </Label>
              {exitProcess ? (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
                  <span>The UI will disconnect when shutdown completes.</span>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Leave unchecked to keep the server running so you can use pcli or Holly.
                </p>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={initiate.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => initiate.mutate()}
            disabled={initiate.isPending}
          >
            {initiate.isPending ? "Starting…" : buttonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
