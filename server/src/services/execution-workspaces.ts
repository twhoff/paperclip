import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces } from "@paperclipai/db";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { redactStatelessDiagnosticResponseValue } from "../log-redaction.js";

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;

export const EXECUTION_WORKSPACE_LIST_DEFAULT_LIMIT = 200;
export const EXECUTION_WORKSPACE_LIST_MAX_LIMIT = 500;

export function normalizeExecutionWorkspaceListLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) {
    return EXECUTION_WORKSPACE_LIST_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(EXECUTION_WORKSPACE_LIST_MAX_LIMIT, Math.trunc(limit)));
}

function toExecutionWorkspaceRecord(
  row: ExecutionWorkspaceRow | ExecutionWorkspace,
): ExecutionWorkspace {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    sourceIssueId: row.sourceIssueId ?? null,
    mode: row.mode as ExecutionWorkspace["mode"],
    strategyType: row.strategyType as ExecutionWorkspace["strategyType"],
    name: row.name,
    status: row.status as ExecutionWorkspace["status"],
    cwd: row.cwd ?? null,
    repoUrl: row.repoUrl ?? null,
    baseRef: row.baseRef ?? null,
    branchName: row.branchName ?? null,
    providerType: row.providerType as ExecutionWorkspace["providerType"],
    providerRef: row.providerRef ?? null,
    derivedFromExecutionWorkspaceId: row.derivedFromExecutionWorkspaceId ?? null,
    lastUsedAt: row.lastUsedAt,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? null,
    cleanupEligibleAt: row.cleanupEligibleAt ?? null,
    cleanupReason: row.cleanupReason ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecutionWorkspace(
  row: ExecutionWorkspaceRow | ExecutionWorkspace,
): ExecutionWorkspace {
  const redacted = redactStatelessDiagnosticResponseValue(toExecutionWorkspaceRecord(row), {
    enabled: false,
    extraDiagnosticKeys: ["cleanupReason"],
  });
  const metadata = redacted.metadata !== null
    && (typeof redacted.metadata !== "object" || Array.isArray(redacted.metadata))
    ? { redacted: redacted.metadata }
    : redacted.metadata;
  return { ...redacted, metadata } as ExecutionWorkspace;
}

export function executionWorkspaceService(db: Db) {
  return {
    list: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
      limit?: number;
    }) => {
      const conditions = [eq(executionWorkspaces.companyId, companyId)];
      if (filters?.projectId) conditions.push(eq(executionWorkspaces.projectId, filters.projectId));
      if (filters?.projectWorkspaceId) {
        conditions.push(eq(executionWorkspaces.projectWorkspaceId, filters.projectWorkspaceId));
      }
      if (filters?.issueId) conditions.push(eq(executionWorkspaces.sourceIssueId, filters.issueId));
      if (filters?.status) {
        const statuses = filters.status.split(",").map((value) => value.trim()).filter(Boolean);
        if (statuses.length === 1) conditions.push(eq(executionWorkspaces.status, statuses[0]!));
        else if (statuses.length > 1) conditions.push(inArray(executionWorkspaces.status, statuses));
      }
      if (filters?.reuseEligible) {
        conditions.push(inArray(executionWorkspaces.status, ["active", "idle", "in_review"]));
      }

      const rows = await db
        .select()
        .from(executionWorkspaces)
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt))
        .limit(normalizeExecutionWorkspaceListLimit(filters?.limit));
      return rows.map(toExecutionWorkspaceRecord);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspaceRecord(row) : null;
    },

    create: async (data: typeof executionWorkspaces.$inferInsert) => {
      const row = await db
        .insert(executionWorkspaces)
        .values(data)
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspaceRecord(row) : null;
    },

    update: async (id: string, patch: Partial<typeof executionWorkspaces.$inferInsert>) => {
      const row = await db
        .update(executionWorkspaces)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(executionWorkspaces.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspaceRecord(row) : null;
    },
  };
}

export { toExecutionWorkspace };
