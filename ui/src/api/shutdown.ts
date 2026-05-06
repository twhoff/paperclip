import { api } from "./client";

export type ShutdownPhase = "idle" | "draining" | "drained" | "stopping";

export interface ShutdownState {
  phase: ShutdownPhase;
  startedAt: string | null;
  deadline: string | null;
  timeoutMs: number;
  exitProcess: boolean;
  inFlightAgentCount: number;
  inFlightAgentIds: string[];
  initiatorActorId: string | null;
}

export interface ShutdownInitiateBody {
  timeoutMs?: number;
  exitProcess?: boolean;
}

export const shutdownApi = {
  state: () => api.get<ShutdownState>("/system/shutdown"),
  initiate: (body: ShutdownInitiateBody) =>
    api.post<ShutdownState>("/system/shutdown", body),
  resume: () => api.post<ShutdownState>("/system/shutdown/resume", {}),
};
