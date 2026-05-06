import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, goals } from "@paperclipai/db";

type GoalReader = Pick<Db, "select">;

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export type GoalRow = typeof goals.$inferSelect;

export type ScopedGoals = {
  company: GoalRow[];
  team: GoalRow[];
  agent: GoalRow[];
};

async function getReportsToAncestors(db: Db, agentId: string): Promise<Set<string>> {
  const visited = new Set<string>([agentId]);
  let cursor: string | null = agentId;
  let hops = 0;
  while (cursor && hops < 8) {
    const reportsToRow: { reportsTo: string | null } | null = await db
      .select({ reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.id, cursor))
      .then((rows) => rows[0] ?? null);
    if (!reportsToRow?.reportsTo || visited.has(reportsToRow.reportsTo)) break;
    visited.add(reportsToRow.reportsTo);
    cursor = reportsToRow.reportsTo;
    hops++;
  }
  return visited;
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) =>
      db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof goals.$inferInsert>) =>
      db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listActiveCompanyGoals: (companyId: string) =>
      db
        .select()
        .from(goals)
        .where(
          and(
            eq(goals.companyId, companyId),
            eq(goals.level, "company"),
            eq(goals.status, "active"),
          ),
        )
        .orderBy(asc(goals.createdAt)),

    listScopedForAgent: async (agentId: string): Promise<ScopedGoals> => {
      const agentRow = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agentRow) return { company: [], team: [], agent: [] };

      const ancestorSet = await getReportsToAncestors(db, agentId);

      const allGoals = await db
        .select()
        .from(goals)
        .where(
          and(
            eq(goals.companyId, agentRow.companyId),
            inArray(goals.level, ["company", "team", "agent"]),
            inArray(goals.status, ["active", "planned"]),
          ),
        );

      const result: ScopedGoals = { company: [], team: [], agent: [] };
      for (const goal of allGoals) {
        if (goal.level === "company") {
          result.company.push(goal);
        } else if (goal.level === "team") {
          if (!goal.ownerAgentId || ancestorSet.has(goal.ownerAgentId)) {
            result.team.push(goal);
          }
        } else if (goal.level === "agent" && goal.ownerAgentId === agentId) {
          result.agent.push(goal);
        }
      }
      return result;
    },
  };
}
