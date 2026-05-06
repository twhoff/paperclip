import { useQuery } from "@tanstack/react-query";
import { shutdownApi, type ShutdownState } from "../api/shutdown";
import { queryKeys } from "../lib/queryKeys";

export function useShutdownStatus() {
  return useQuery<ShutdownState>({
    queryKey: queryKeys.shutdown,
    queryFn: () => shutdownApi.state(),
    refetchInterval: (query) => {
      const phase = query.state.data?.phase;
      if (phase && phase !== "idle") return 1000;
      return 5000;
    },
    staleTime: 0,
  });
}
