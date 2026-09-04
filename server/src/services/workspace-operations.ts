import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { workspaceOperations } from "@paperclipai/db";
import type { WorkspaceOperation, WorkspaceOperationPhase, WorkspaceOperationStatus } from "@paperclipai/shared";
import { asc, desc, eq, inArray, isNull, or, and } from "drizzle-orm";
import { notFound } from "../errors.js";
import {
  createStreamingTextRedactor,
  materializeCurrentUserRedactionOptions,
  redactDiagnosticResponseValue,
  redactThrownDiagnosticError,
  type CurrentUserRedactionOptions,
} from "../log-redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  getWorkspaceOperationLogStore,
  type WorkspaceOperationLogHandle,
} from "./workspace-operation-log-store.js";
import {
  getSanitizedNdjsonLogCache,
  type SanitizedLogSource,
} from "./sanitized-log-cache.js";

type WorkspaceOperationRow = typeof workspaceOperations.$inferSelect;

export const WORKSPACE_OPERATION_LIST_DEFAULT_LIMIT = 200;
export const WORKSPACE_OPERATION_LIST_MAX_LIMIT = 500;

export function normalizeWorkspaceOperationListLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) {
    return WORKSPACE_OPERATION_LIST_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(WORKSPACE_OPERATION_LIST_MAX_LIMIT, Math.trunc(limit)));
}

function normalizeRedactedMetadata(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { redacted: value };
}

function toWorkspaceOperation(row: WorkspaceOperationRow): WorkspaceOperation {
  const redacted = redactDiagnosticResponseValue({
    id: row.id,
    companyId: row.companyId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    heartbeatRunId: row.heartbeatRunId ?? null,
    phase: row.phase as WorkspaceOperationPhase,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    status: row.status as WorkspaceOperationStatus,
    exitCode: row.exitCode ?? null,
    logStore: row.logStore ?? null,
    logRef: row.logRef ?? null,
    logBytes: row.logBytes ?? null,
    logSha256: row.logSha256 ?? null,
    logCompressed: row.logCompressed,
    stdoutExcerpt: row.stdoutExcerpt ?? null,
    stderrExcerpt: row.stderrExcerpt ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }, { enabled: false });
  return {
    ...redacted,
    metadata: normalizeRedactedMetadata(redacted.metadata),
  } as WorkspaceOperation;
}

function appendExcerpt(current: string, chunk: string) {
  return `${current}${chunk}`.slice(-4096);
}

function combineMetadata(
  base: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | null | undefined,
) {
  if (!base && !patch) return null;
  return {
    ...(base ?? {}),
    ...(patch ?? {}),
  };
}

export interface WorkspaceOperationRecorder {
  attachExecutionWorkspaceId(executionWorkspaceId: string | null): Promise<void>;
  recordOperation(input: {
    phase: WorkspaceOperationPhase;
    command?: string | null;
    cwd?: string | null;
    metadata?: Record<string, unknown> | null;
    run: () => Promise<{
      status?: WorkspaceOperationStatus;
      exitCode?: number | null;
      stdout?: string | null;
      stderr?: string | null;
      system?: string | null;
      metadata?: Record<string, unknown> | null;
    }>;
  }): Promise<WorkspaceOperation>;
}

export function workspaceOperationService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const logStore = getWorkspaceOperationLogStore();
  const sanitizedLogCache = getSanitizedNdjsonLogCache();
  const sanitizedWorkspaceLogSource = (
    handle: WorkspaceOperationLogHandle,
  ): SanitizedLogSource => ({
    namespace: "workspace-operation",
    owner: logStore,
    logRef: handle.logRef,
  });
  const appendWorkspaceLog = async (
    handle: WorkspaceOperationLogHandle,
    event: Parameters<typeof logStore.append>[1],
  ) => {
    const source = sanitizedWorkspaceLogSource(handle);
    sanitizedLogCache.invalidate(source);
    try {
      await logStore.append(handle, event);
    } finally {
      sanitizedLogCache.invalidate(source);
    }
  };
  const finalizeWorkspaceLog = async (handle: WorkspaceOperationLogHandle) => {
    const source = sanitizedWorkspaceLogSource(handle);
    sanitizedLogCache.invalidate(source);
    try {
      return await logStore.finalize(handle);
    } finally {
      sanitizedLogCache.invalidate(source);
    }
  };
  const discardWorkspaceLog = async (handle: WorkspaceOperationLogHandle) => {
    const source = sanitizedWorkspaceLogSource(handle);
    sanitizedLogCache.invalidate(source);
    try {
      await logStore.discard(handle);
    } finally {
      sanitizedLogCache.invalidate(source);
    }
  };

  async function getById(id: string) {
    const row = await db
      .select()
      .from(workspaceOperations)
      .where(eq(workspaceOperations.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? toWorkspaceOperation(row) : null;
  }

  return {
    getById,

    createRecorder(input: {
      companyId: string;
      heartbeatRunId?: string | null;
      executionWorkspaceId?: string | null;
      redactionOptions?: CurrentUserRedactionOptions;
    }): WorkspaceOperationRecorder {
      let executionWorkspaceId = input.executionWorkspaceId ?? null;
      const createdIds: string[] = [];
      const recorderRedactionOptions = input.redactionOptions
        ? materializeCurrentUserRedactionOptions(input.redactionOptions)
        : null;

      return {
        async attachExecutionWorkspaceId(nextExecutionWorkspaceId) {
          executionWorkspaceId = nextExecutionWorkspaceId ?? null;
          if (!executionWorkspaceId || createdIds.length === 0) return;
          await db
            .update(workspaceOperations)
            .set({
              executionWorkspaceId,
              updatedAt: new Date(),
            })
            .where(inArray(workspaceOperations.id, createdIds));
        },

        async recordOperation(recordInput) {
          const currentUserRedactionOptions = materializeCurrentUserRedactionOptions({
            ...recorderRedactionOptions,
            enabled:
              recorderRedactionOptions?.enabled
              ?? (await instanceSettings.getGeneral()).censorUsernameInLogs,
          });
          const startedAt = new Date();
          const id = randomUUID();
          const handle = await logStore.begin({
            companyId: input.companyId,
            operationId: id,
          });
          sanitizedLogCache.invalidate(sanitizedWorkspaceLogSource(handle));

          let stdoutExcerpt = "";
          let stderrExcerpt = "";
          const streamRedactors = {
            stdout: createStreamingTextRedactor(currentUserRedactionOptions),
            stderr: createStreamingTextRedactor(currentUserRedactionOptions),
            system: createStreamingTextRedactor(currentUserRedactionOptions),
          };
          const appendSanitized = async (
            stream: "stdout" | "stderr" | "system",
            sanitizedChunk: string,
          ) => {
            if (!sanitizedChunk) return;
            if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
            if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
            await appendWorkspaceLog(handle, {
              stream,
              chunk: sanitizedChunk,
              ts: new Date().toISOString(),
            });
          };
          const append = async (
            stream: "stdout" | "stderr" | "system",
            chunk: string | null | undefined,
          ) => {
            if (!chunk) return;
            await appendSanitized(stream, streamRedactors[stream].push(chunk));
          };
          const flushRedactors = async () => {
            for (const stream of ["system", "stdout", "stderr"] as const) {
              await appendSanitized(stream, streamRedactors[stream].flush());
            }
          };

          const initialDiagnostics = redactDiagnosticResponseValue({
            command: recordInput.command ?? null,
            cwd: recordInput.cwd ?? null,
            metadata: recordInput.metadata ?? null,
          }, currentUserRedactionOptions);
          try {
            await db.insert(workspaceOperations).values({
              id,
              companyId: input.companyId,
              executionWorkspaceId,
              heartbeatRunId: input.heartbeatRunId ?? null,
              phase: recordInput.phase,
              command: initialDiagnostics.command,
              cwd: initialDiagnostics.cwd,
              status: "running",
              logStore: handle.store,
              logRef: handle.logRef,
              metadata: normalizeRedactedMetadata(initialDiagnostics.metadata),
              startedAt,
            });
          } catch (error) {
            await discardWorkspaceLog(handle).catch(() => undefined);
            throw error;
          }
          createdIds.push(id);

          try {
            const result = await recordInput.run();
            await append("system", result.system ?? null);
            await append("stdout", result.stdout ?? null);
            await append("stderr", result.stderr ?? null);
            await flushRedactors();
            const finalized = await finalizeWorkspaceLog(handle);
            const finishedAt = new Date();
            const completedDiagnostics = redactDiagnosticResponseValue({
              command: recordInput.command ?? null,
              cwd: recordInput.cwd ?? null,
              stdoutExcerpt: stdoutExcerpt || null,
              stderrExcerpt: stderrExcerpt || null,
              metadata: combineMetadata(recordInput.metadata, result.metadata),
            }, currentUserRedactionOptions);
            const row = await db
              .update(workspaceOperations)
              .set({
                executionWorkspaceId,
                command: completedDiagnostics.command,
                cwd: completedDiagnostics.cwd,
                status: result.status ?? "succeeded",
                exitCode: result.exitCode ?? null,
                stdoutExcerpt: completedDiagnostics.stdoutExcerpt,
                stderrExcerpt: completedDiagnostics.stderrExcerpt,
                logBytes: finalized.bytes,
                logSha256: finalized.sha256,
                logCompressed: finalized.compressed,
                metadata: normalizeRedactedMetadata(completedDiagnostics.metadata),
                finishedAt,
                updatedAt: finishedAt,
              })
              .where(eq(workspaceOperations.id, id))
              .returning()
              .then((rows) => rows[0] ?? null);
            if (!row) throw notFound("Workspace operation not found");
            return toWorkspaceOperation(row);
          } catch (error) {
            const failureDiagnostic = redactThrownDiagnosticError(
              error,
              currentUserRedactionOptions,
              {
                fallbackMessage: "Workspace operation failed",
                includeStack: true,
              },
            );
            await append("stderr", failureDiagnostic.message)
              .catch(() => undefined);
            await flushRedactors().catch(() => undefined);
            const finalized = await finalizeWorkspaceLog(handle).catch(() => null);
            const finishedAt = new Date();
            const failedDiagnostics = redactDiagnosticResponseValue({
              command: recordInput.command ?? null,
              cwd: recordInput.cwd ?? null,
              stdoutExcerpt: stdoutExcerpt || null,
              stderrExcerpt: stderrExcerpt || null,
              metadata: recordInput.metadata ?? null,
            }, currentUserRedactionOptions);
            await db
              .update(workspaceOperations)
              .set({
                executionWorkspaceId,
                command: failedDiagnostics.command,
                cwd: failedDiagnostics.cwd,
                status: "failed",
                stdoutExcerpt: failedDiagnostics.stdoutExcerpt,
                stderrExcerpt: failedDiagnostics.stderrExcerpt,
                logBytes: finalized?.bytes ?? null,
                logSha256: finalized?.sha256 ?? null,
                logCompressed: finalized?.compressed ?? false,
                metadata: normalizeRedactedMetadata(failedDiagnostics.metadata),
                finishedAt,
                updatedAt: finishedAt,
              })
              .where(eq(workspaceOperations.id, id));
            const sanitizedError = new Error(failureDiagnostic.message);
            sanitizedError.name = failureDiagnostic.name ?? "Error";
            if (failureDiagnostic.stack) sanitizedError.stack = failureDiagnostic.stack;
            throw sanitizedError;
          }
        },
      };
    },

    listForRun: async (
      runId: string,
      executionWorkspaceId?: string | null,
      limit?: number,
    ) => {
      const conditions = [eq(workspaceOperations.heartbeatRunId, runId)];
      if (executionWorkspaceId) {
        const cleanupCondition = and(
          eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId)!,
          isNull(workspaceOperations.heartbeatRunId),
        )!;
        if (cleanupCondition) conditions.push(cleanupCondition);
      }

      const rows = await db
        .select()
        .from(workspaceOperations)
        .where(conditions.length === 1 ? conditions[0]! : or(...conditions)!)
        .orderBy(asc(workspaceOperations.startedAt), asc(workspaceOperations.createdAt), asc(workspaceOperations.id))
        .limit(normalizeWorkspaceOperationListLimit(limit));

      return rows.map(toWorkspaceOperation);
    },

    listForExecutionWorkspace: async (executionWorkspaceId: string, limit?: number) => {
      const rows = await db
        .select()
        .from(workspaceOperations)
        .where(eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId))
        .orderBy(desc(workspaceOperations.startedAt), desc(workspaceOperations.createdAt))
        .limit(normalizeWorkspaceOperationListLimit(limit));
      return rows.map(toWorkspaceOperation);
    },

    readLog: async (operationId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const operation = await getById(operationId);
      if (!operation) throw notFound("Workspace operation not found");
      if (!operation.logStore || !operation.logRef) throw notFound("Workspace operation log not found");

      const handle = {
        store: operation.logStore as "local_file",
        logRef: operation.logRef,
      } satisfies WorkspaceOperationLogHandle;
      const result = await sanitizedLogCache.read({
        source: sanitizedWorkspaceLogSource(handle),
        readSource: (options) => logStore.read(handle, options),
        range: opts,
        redactionOptions: {
          enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
        },
      });

      return {
        operationId,
        store: operation.logStore,
        logRef: operation.logRef,
        ...result,
      };
    },
  };
}

export { toWorkspaceOperation };
