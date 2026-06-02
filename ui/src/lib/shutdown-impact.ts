import type { Agent, Company } from "@paperclipai/shared";

type ImpactAgent = Pick<Agent, "status">;

export interface ShutdownImpactGroup {
  company: Pick<Company, "id" | "name">;
  agents?: ImpactAgent[];
  isLoading?: boolean;
  isError?: boolean;
}

export interface ShutdownImpactSummary {
  companyCount: number;
  affectedAgentCount: number;
  runningAgentCount: number;
  alreadyPausedCount: number;
  terminatedCount: number;
  loadingCompanyCount: number;
  errorCompanyCount: number;
}

export function summarizeShutdownImpact(groups: ShutdownImpactGroup[]): ShutdownImpactSummary {
  return groups.reduce<ShutdownImpactSummary>(
    (summary, group) => {
      summary.companyCount += 1;
      if (group.isLoading) summary.loadingCompanyCount += 1;
      if (group.isError) summary.errorCompanyCount += 1;
      for (const agent of group.agents ?? []) {
        if (agent.status === "terminated") {
          summary.terminatedCount += 1;
        } else if (agent.status === "paused") {
          summary.alreadyPausedCount += 1;
        } else {
          summary.affectedAgentCount += 1;
          if (agent.status === "running") summary.runningAgentCount += 1;
        }
      }
      return summary;
    },
    {
      companyCount: 0,
      affectedAgentCount: 0,
      runningAgentCount: 0,
      alreadyPausedCount: 0,
      terminatedCount: 0,
      loadingCompanyCount: 0,
      errorCompanyCount: 0,
    },
  );
}
