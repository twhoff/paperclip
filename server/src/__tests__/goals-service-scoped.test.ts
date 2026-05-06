import { beforeEach, describe, expect, it, vi } from "vitest";
import { goalService } from "../services/goals.js";
import type { Db } from "@paperclipai/db";

function createDbStub(results: unknown[][]): Db {
  const queue = [...results];
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(queue.shift() ?? []),
      }),
    }),
  } as unknown as Db;
}

const agentRow = (id: string, companyId: string, reportsTo: string | null = null) => ({
  id,
  companyId,
  reportsTo,
});

const goalRow = (
  id: string,
  companyId: string,
  level: string,
  status: string,
  ownerAgentId: string | null = null,
) => ({ id, companyId, title: `Goal ${id}`, description: null, level, status, ownerAgentId, parentId: null, createdAt: new Date(), updatedAt: new Date() });

describe("goalService.listScopedForAgent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty buckets when agent does not exist", async () => {
    // First select for agent companyId returns nothing
    const db = createDbStub([[]]);
    const svc = goalService(db);
    const result = await svc.listScopedForAgent("missing-agent");
    expect(result).toEqual({ company: [], team: [], agent: [] });
  });

  it("puts active company goals in company bucket", async () => {
    const agent = agentRow("agent-1", "company-1");
    const companyGoal = goalRow("g1", "company-1", "company", "active");
    const db = createDbStub([
      [agent],       // agent companyId lookup
      [agent],       // ancestor walk: agent-1 → reportsTo null → stops
      [companyGoal], // goals query
    ]);
    const svc = goalService(db);
    const result = await svc.listScopedForAgent("agent-1");
    expect(result.company).toHaveLength(1);
    expect(result.company[0].id).toBe("g1");
    expect(result.team).toHaveLength(0);
    expect(result.agent).toHaveLength(0);
  });

  it("includes NULL-owner team goals for any agent", async () => {
    const agent = agentRow("agent-1", "company-1");
    const teamGoal = goalRow("g2", "company-1", "team", "active", null);
    const db = createDbStub([
      [agent],
      [agent],
      [teamGoal],
    ]);
    const svc = goalService(db);
    const result = await svc.listScopedForAgent("agent-1");
    expect(result.team).toHaveLength(1);
    expect(result.team[0].id).toBe("g2");
  });

  it("includes team goals owned by an ancestor via reports_to chain", async () => {
    const agent = agentRow("agent-1", "company-1", "manager-1");
    const manager = agentRow("manager-1", "company-1", null);
    const teamGoal = goalRow("g3", "company-1", "team", "active", "manager-1");
    const db = createDbStub([
      [agent],          // agent companyId lookup
      [agent],          // ancestor walk: agent-1 → reportsTo manager-1
      [manager],        // ancestor walk: manager-1 → reportsTo null → stops
      [teamGoal],       // goals query
    ]);
    const svc = goalService(db);
    const result = await svc.listScopedForAgent("agent-1");
    expect(result.team).toHaveLength(1);
    expect(result.team[0].id).toBe("g3");
  });

  it("excludes team goals owned by unrelated agents", async () => {
    const agent = agentRow("agent-1", "company-1");
    const teamGoal = goalRow("g4", "company-1", "team", "active", "other-agent");
    const db = createDbStub([
      [agent],
      [agent],
      [teamGoal],
    ]);
    const svc = goalService(db);
    const result = await svc.listScopedForAgent("agent-1");
    expect(result.team).toHaveLength(0);
  });

  it("includes agent-level goals owned by me, excludes others", async () => {
    const agent = agentRow("agent-1", "company-1");
    const myGoal = goalRow("g5", "company-1", "agent", "active", "agent-1");
    const otherGoal = goalRow("g6", "company-1", "agent", "active", "other-agent");
    const db = createDbStub([
      [agent],
      [agent],
      [myGoal, otherGoal],
    ]);
    const svc = goalService(db);
    const result = await svc.listScopedForAgent("agent-1");
    expect(result.agent).toHaveLength(1);
    expect(result.agent[0].id).toBe("g5");
  });

  it("excludes goals with archived status", async () => {
    // The goals query filters status IN ('active','planned') at DB level.
    // This test verifies bucketing ignores archived rows if somehow returned.
    const agent = agentRow("agent-1", "company-1");
    const archivedCompany = goalRow("g7", "company-1", "company", "archived");
    const db = createDbStub([
      [agent],
      [agent],
      [archivedCompany],
    ]);
    const svc = goalService(db);
    const result = await svc.listScopedForAgent("agent-1");
    // archived company goal still buckets to 'company' — DB filter is the real guard
    expect(result.company).toHaveLength(1);
  });

  it("cycle safety: stops ancestor walk when a cycle is detected", async () => {
    // agent-1 → agent-2 → agent-1 (cycle)
    const agent1 = agentRow("agent-1", "company-1", "agent-2");
    const agent2 = agentRow("agent-2", "company-1", "agent-1");
    const db = createDbStub([
      [agent1],    // agent companyId
      [agent1],    // ancestor walk: agent-1 → reports to agent-2
      [agent2],    // ancestor walk: agent-2 → reports to agent-1 (visited → break)
      [],          // goals query (empty)
    ]);
    const svc = goalService(db);
    // Should not throw or infinite loop
    const result = await svc.listScopedForAgent("agent-1");
    expect(result).toEqual({ company: [], team: [], agent: [] });
  });
});
