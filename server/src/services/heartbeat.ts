import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { BillingType } from "@paperclipai/shared";
import {
  agents,
  agentEmulationSessions,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  batchQueueEntries,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { badRequest, conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { agentService } from "./agents.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import {
  runActivityRegistry,
  chunkHasMeaningfulActivity,
  type ActivitySource,
} from "./run-activity-registry.js";

// Run statuses that mean the run has stopped progressing. Used to drop the
// run from the in-memory activity registry so the map doesn't grow forever.
const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec, UsageSummary } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { parseObject, asString, asBoolean, asNumber, appendWithCap, MAX_EXCERPT_BYTES } from "../adapters/utils.js";
import { costService } from "./costs.js";
import { companySkillService } from "./company-skills.js";
import { budgetService, type BudgetEnforcementScope } from "./budgets.js";
import { secretService } from "./secrets.js";
import { resolveDefaultAgentWorkspaceDir, resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import {
  heartbeatRunSummaryResultJson,
  summarizeHeartbeatRunResultJson,
} from "./heartbeat-run-summary.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  sanitizeRuntimeServiceBaseEnv,
} from "./workspace-runtime.js";
import { issueService } from "./issues.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  gateProjectExecutionWorkspacePolicy,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import {
  materializeCurrentUserRedactionOptions,
  OrderedStreamingTextRedactor,
  redactCurrentUserText,
  redactCurrentUserValue,
  redactDiagnosticResponseValue,
  redactStatelessDiagnosticResponseValue,
  redactStatelessDiagnosticValue,
  redactThrownDiagnosticError,
  SECRET_REDACTION_TOKEN,
  type CurrentUserRedactionOptions,
} from "../log-redaction.js";
import {
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@paperclipai/adapter-utils";
import {
  collectSensitiveEnvValues,
  isLocalAdapterProcessTerminationError,
  LocalAdapterProcessTerminationError,
  terminateLocalAdapterProcess,
} from "@paperclipai/adapter-utils/server-utils";
import { adapterStatusService } from "./adapter-status.js";
import {
  getSanitizedNdjsonLogCache,
  type SanitizedLogSource,
} from "./sanitized-log-cache.js";
import { createAsyncLogGate } from "./async-log-gate.js";
import { sharedTransientExecutionContextStore } from "./transient-execution-context-store.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const HEARTBEAT_IDEMPOTENCY_KEY_MAX_BYTES = 255;
const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;
export const HEARTBEAT_RUN_LIST_DEFAULT_LIMIT = 200;
export const HEARTBEAT_RUN_LIST_MAX_LIMIT = 1000;
export const AGENT_TASK_SESSION_LIST_DEFAULT_LIMIT = 100;
export const AGENT_TASK_SESSION_LIST_MAX_LIMIT = 500;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const deferredWakeTransientContextKey = (wakeupRequestId: string) =>
  `deferred-wakeup:${wakeupRequestId}`;
const DETACHED_PROCESS_ERROR_CODE = "process_detached";
const PROCESS_TERMINATION_PENDING_ERROR_CODE = "process_termination_pending";
const PROCESS_TERMINATION_PENDING_ERROR_MESSAGE =
  "Local adapter process tree termination could not be verified";
const PROCESS_TERMINATION_RECOVERY_LIMIT = 100;

// Error codes eligible for automatic retry, with max attempts and delay before retry
const RETRY_POLICY: Record<string, { maxRetries: number; delayMs: number }> = {
  process_lost: { maxRetries: 1, delayMs: 0 },
  adapter_failed: { maxRetries: 1, delayMs: 30_000 },
  rate_limit: { maxRetries: 2, delayMs: 60_000 },
  copilot_auth_required: { maxRetries: 1, delayMs: 10_000 },
  claude_auth_required: { maxRetries: 1, delayMs: 10_000 },
};
const startLocksByAgent = new Map<string, Promise<void>>();
const runLaunchLocksByRunId = new Map<string, Promise<void>>();
const runExecutionCoordinationByRunId = new Map<string, RunExecutionCoordination>();
const RUN_LAUNCH_HANDSHAKE_MAX_MS = 15_000;
const RUN_CANCELLATION_GRACE_MAX_MS = 5_000;
const RUN_CANCELLATION_KILL_WAIT_MS = 5_000;
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const execFile = promisify(execFileCallback);

export function normalizeHeartbeatRunListLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) {
    return HEARTBEAT_RUN_LIST_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(HEARTBEAT_RUN_LIST_MAX_LIMIT, Math.trunc(limit)));
}

export function normalizeAgentTaskSessionListLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) {
    return AGENT_TASK_SESSION_LIST_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(AGENT_TASK_SESSION_LIST_MAX_LIMIT, Math.trunc(limit)));
}

type HeartbeatRunStatusSource = Pick<
  typeof heartbeatRuns.$inferSelect,
  | "id"
  | "agentId"
  | "status"
  | "invocationSource"
  | "triggerDetail"
  | "error"
  | "errorCode"
  | "startedAt"
  | "finishedAt"
>;

export function buildHeartbeatRunStatusPayload(run: HeartbeatRunStatusSource) {
  return redactStatelessDiagnosticResponseValue({
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    error: run.error ?? null,
    errorCode: run.errorCode ?? null,
    startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
  }, { enabled: false });
}

export function redactAdapterResultForPersistence<T extends AdapterExecutionResult>(
  result: T,
  opts?: CurrentUserRedactionOptions,
): T {
  return redactStatelessDiagnosticResponseValue({ payload: result }, opts).payload;
}

export function prepareAdapterResultViews<T extends AdapterExecutionResult>(
  result: T,
  opts?: CurrentUserRedactionOptions,
) {
  const resolvedOptions = materializeCurrentUserRedactionOptions(opts);
  return {
    operational: result,
    credentialSafe: redactDiagnosticResponseValue(
      { payload: result },
      { ...resolvedOptions, enabled: false },
    ).payload,
    persisted: redactAdapterResultForPersistence(result, resolvedOptions),
  };
}

export function buildAdapterInvocationEventPayload<T extends AdapterInvocationMeta>(
  meta: T,
  secretKeys: ReadonlySet<string>,
  opts?: CurrentUserRedactionOptions,
): T {
  const sanitizedMeta = redactDiagnosticResponseValue(
    { payload: meta },
    opts,
  ).payload;
  if (
    sanitizedMeta.env &&
    typeof sanitizedMeta.env === "object" &&
    !Array.isArray(sanitizedMeta.env)
  ) {
    for (const key of secretKeys) {
      if (key in sanitizedMeta.env) sanitizedMeta.env[key] = SECRET_REDACTION_TOKEN;
    }
  }
  return sanitizedMeta;
}

export function sanitizeWakeupExecutionInput<T extends Record<string, unknown>>(
  value: T,
  opts?: CurrentUserRedactionOptions,
): T {
  const credentialOnlyOptions = materializeCurrentUserRedactionOptions({
    ...opts,
    enabled: false,
  });
  return redactDiagnosticResponseValue(value, {
    ...credentialOnlyOptions,
    extraDiagnosticKeys: ["reason", "payload", "contextSnapshot", "idempotencyKey"],
  });
}

export function buildExecutionWorkspaceCleanupFailureLog<
  T extends Record<string, unknown> & { cleanupError: unknown },
>(
  input: T,
  opts?: CurrentUserRedactionOptions,
): Omit<T, "cleanupError"> & { cleanupError: string } {
  const cleanupError = redactThrownDiagnosticError(input.cleanupError, opts, {
    fallbackMessage: "Execution workspace cleanup failed",
  });
  const projected = {
    ...input,
    cleanupError: cleanupError.message,
  } as Omit<T, "cleanupError"> & { cleanupError: string };
  return redactDiagnosticResponseValue({ payload: projected }, opts).payload;
}

export function buildSessionHandoffMarkdown(
  input: {
    sessionId: string;
    issueId: string | null;
    reason: string;
    latestTextSummary: string | null;
  },
  opts?: CurrentUserRedactionOptions,
) {
  const projected = parseObject(
    redactDiagnosticResponseValue({ payload: input }, opts).payload,
  );
  const sessionId = readNonEmptyString(projected.sessionId) ?? SECRET_REDACTION_TOKEN;
  const issueId = readNonEmptyString(projected.issueId);
  const reason =
    readNonEmptyString(projected.reason) ?? "session rotation threshold reached";
  const latestTextSummary = readNonEmptyString(projected.latestTextSummary);

  return [
    "Paperclip session handoff:",
    `- Previous session: ${sessionId}`,
    issueId ? `- Issue: ${issueId}` : "",
    `- Rotation reason: ${reason}`,
    latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
    "Continue from the current task state. Rebuild only the minimum context you need.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildLastRunSummaryPayload(
  input: {
    runId: string;
    status: string;
    errorCode: string | null;
    error: string | null;
    durationMs: number | null;
    issueId: string | null;
    lastEvents: Array<{ type: string; message: string | null; level: string | null }>;
  },
  opts?: CurrentUserRedactionOptions,
) {
  return redactStatelessDiagnosticResponseValue(input, opts);
}

export function redactHeartbeatRunEventContent<
  T extends { message?: string | null; payload?: Record<string, unknown> | null },
>(event: T, opts?: CurrentUserRedactionOptions): T {
  return redactStatelessDiagnosticResponseValue(event, opts);
}

function redactPersistedEventChunks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPersistedEventChunks);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      key.toLowerCase() === "chunk" && typeof entry === "string"
        ? SECRET_REDACTION_TOKEN
        : redactPersistedEventChunks(entry),
    ]),
  );
}

function redactPersistedHeartbeatEvent(event: typeof heartbeatRunEvents.$inferSelect) {
  const redacted = redactHeartbeatRunEventContent(event, { enabled: false });
  return {
    ...redacted,
    payload: redactPersistedEventChunks(redacted.payload) as Record<string, unknown> | null,
  };
}

const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const trimmed = repoUrl?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

async function ensureManagedProjectWorkspace(input: {
  companyId: string;
  projectId: string;
  repoUrl: string | null;
}): Promise<{ cwd: string; warning: string | null }> {
  const cwd = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
  });
  await fs.mkdir(path.dirname(cwd), { recursive: true });
  const stats = await fs.stat(cwd).catch(() => null);

  if (!input.repoUrl) {
    if (!stats) {
      await fs.mkdir(cwd, { recursive: true });
    }
    return { cwd, warning: null };
  }

  const gitDirExists = await fs
    .stat(path.resolve(cwd, ".git"))
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (gitDirExists) {
    return { cwd, warning: null };
  }

  if (stats) {
    const entries = await fs.readdir(cwd).catch(() => []);
    if (entries.length > 0) {
      return {
        cwd,
        warning: `Managed workspace path "${cwd}" already exists but is not a git checkout. Using it as-is.`,
      };
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }

  try {
    await execFile("git", ["clone", input.repoUrl, cwd], {
      env: sanitizeRuntimeServiceBaseEnv(process.env),
      timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
    });
    return { cwd, warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare managed checkout for "${input.repoUrl}" at "${cwd}": ${reason}`);
  }
}

const heartbeatRunListColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRunSummaryResultJson,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: sql<string | null>`NULL`.as("stdoutExcerpt"),
  stderrExcerpt: sql<string | null>`NULL`.as("stderrExcerpt"),
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  processPid: heartbeatRuns.processPid,
  processStartedAt: heartbeatRuns.processStartedAt,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  processLossRetryCount: heartbeatRuns.processLossRetryCount,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

type RunLaunchPhase = "preparing" | "launching" | "spawned" | "settled";

type RunExecutionCoordination = {
  agentId: string;
  phase: RunLaunchPhase;
  cancellationWon: boolean;
  terminationProven: boolean | null;
  launchBoundary: Promise<void>;
  resolveLaunchBoundary: () => void;
  executionSettled: Promise<void>;
  resolveExecutionSettled: () => void;
};

function createRunExecutionCoordination(runId: string, agentId: string) {
  if (runExecutionCoordinationByRunId.has(runId)) return null;
  let resolveLaunchBoundary!: () => void;
  let resolveExecutionSettled!: () => void;
  const coordination: RunExecutionCoordination = {
    agentId,
    phase: "preparing",
    cancellationWon: false,
    terminationProven: null,
    launchBoundary: new Promise<void>((resolve) => {
      resolveLaunchBoundary = resolve;
    }),
    resolveLaunchBoundary: () => resolveLaunchBoundary(),
    executionSettled: new Promise<void>((resolve) => {
      resolveExecutionSettled = resolve;
    }),
    resolveExecutionSettled: () => resolveExecutionSettled(),
  };
  runExecutionCoordinationByRunId.set(runId, coordination);
  return coordination;
}

function finishRunExecutionCoordination(
  runId: string,
  coordination: RunExecutionCoordination,
) {
  coordination.phase = "settled";
  coordination.resolveLaunchBoundary();
  coordination.resolveExecutionSettled();
  if (runExecutionCoordinationByRunId.get(runId) === coordination) {
    runExecutionCoordinationByRunId.delete(runId);
  }
}

async function withRunLaunchLock<T>(runId: string, fn: () => Promise<T>) {
  const previous = runLaunchLocksByRunId.get(runId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  runLaunchLocksByRunId.set(runId, marker);
  try {
    return await run;
  } finally {
    if (runLaunchLocksByRunId.get(runId) === marker) {
      runLaunchLocksByRunId.delete(runId);
    }
  }
}

async function waitForPromiseWithTimeout(promise: Promise<void>, timeoutMs: number) {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    timer.unref?.();
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system" | "adapter_probe";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
};

type ProjectWorkspaceCandidate = {
  id: string;
};

export function prioritizeProjectWorkspaceCandidatesForRun<T extends ProjectWorkspaceCandidate>(
  rows: T[],
  preferredWorkspaceId: string | null | undefined,
): T[] {
  if (!preferredWorkspaceId) return rows;
  const preferredIndex = rows.findIndex((row) => row.id === preferredWorkspaceId);
  if (preferredIndex <= 0) return rows;
  return [rows[preferredIndex]!, ...rows.slice(0, preferredIndex), ...rows.slice(preferredIndex + 1)];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = readNonEmptyString(value);
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

function resolveLedgerBiller(result: AdapterExecutionResult): string {
  return readNonEmptyString(result.biller) ?? readNonEmptyString(result.provider) ?? "unknown";
}

function normalizeBilledCostCents(costUsd: number | null | undefined, billingType: BillingType): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

/**
 * Resolve cost in cents for an adapter result.
 *
 * - If the adapter reports raw units (e.g. Warp credits via costRawUnits),
 *   look up the company's biller_unit_prices rule and convert to USD cents.
 * - Otherwise fall back to costUsd → cents directly.
 */
async function resolveAdapterCostCents(
  db: Db,
  companyId: string,
  result: AdapterExecutionResult,
  billingType: BillingType,
  biller: string,
): Promise<{ costCents: number; rawUnits: string | null; rawUnitType: string | null; unitPriceId: string | null }> {
  if (result.costRawUnits != null && typeof result.costRawUnits === "number" && Number.isFinite(result.costRawUnits)) {
    const costs = costService(db);
    const rule = await costs.lookupBillerUnitPrice(companyId, biller, billingType);
    if (rule) {
      const usdPerUnit = Number(rule.unitPriceUsd);
      const costCents = Math.max(0, Math.round(result.costRawUnits * usdPerUnit * 100));
      return {
        costCents,
        rawUnits: String(result.costRawUnits),
        rawUnitType: result.costRawUnitType ?? rule.unitType,
        unitPriceId: rule.id,
      };
    }
    logger.warn(
      { companyId, biller, billingType, rawUnits: result.costRawUnits },
      "no biller_unit_prices rule found for credit-denominated adapter result; cost recorded as 0",
    );
    return {
      costCents: 0,
      rawUnits: String(result.costRawUnits),
      rawUnitType: result.costRawUnitType ?? null,
      unitPriceId: null,
    };
  }
  return {
    costCents: normalizeBilledCostCents(result.costUsd, billingType),
    rawUnits: null,
    rawUnitType: null,
    unitPriceId: null,
  };
}

async function resolveLedgerScopeForRun(
  db: Db,
  companyId: string,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);

  if (!contextIssueId) {
    return {
      issueId: null,
      projectId: contextProjectId,
    };
  }

  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(and(eq(issues.id, contextIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  return {
    issueId: issue?.id ?? null,
    projectId: issue?.projectId ?? contextProjectId,
  };
}

function normalizeUsageTotals(usage: UsageSummary | null | undefined): UsageTotals | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(0, Math.floor(asNumber(usage.cachedInputTokens, 0))),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

export function buildHeartbeatUsageJson(input: {
  normalizedUsage: UsageTotals | null | undefined;
  rawUsage: UsageTotals | null | undefined;
  derivedFromSessionTotals: boolean;
  persistedSessionId: string | null | undefined;
  sessionReused: boolean;
  taskSessionReused: boolean;
  freshSession: boolean;
  sessionRotated: boolean;
  sessionRotationReason: string | null;
  adapterResult: AdapterExecutionResult;
  costUsdForUsage: number | null;
  resolvedCost: { rawUnits: string | null; rawUnitType: string | null };
}) {
  const premiumRequests =
    typeof input.adapterResult.premiumRequests === "number"
      && Number.isFinite(input.adapterResult.premiumRequests)
      ? Math.max(0, Math.floor(input.adapterResult.premiumRequests))
      : null;

  const shouldPersistUsage =
    input.normalizedUsage != null
    || input.adapterResult.costUsd != null
    || input.adapterResult.costRawUnits != null
    || input.costUsdForUsage != null
    || input.resolvedCost.rawUnits != null
    || premiumRequests != null;

  if (!shouldPersistUsage) return null;

  return {
    ...(input.normalizedUsage ?? {}),
    ...(input.rawUsage ? {
      rawInputTokens: input.rawUsage.inputTokens,
      rawCachedInputTokens: input.rawUsage.cachedInputTokens,
      rawOutputTokens: input.rawUsage.outputTokens,
    } : {}),
    ...(input.derivedFromSessionTotals ? { usageSource: "session_delta" } : {}),
    ...(input.persistedSessionId ? { persistedSessionId: input.persistedSessionId } : {}),
    sessionReused: input.sessionReused,
    taskSessionReused: input.taskSessionReused,
    freshSession: input.freshSession,
    sessionRotated: input.sessionRotated,
    sessionRotationReason: input.sessionRotationReason,
    provider: readNonEmptyString(input.adapterResult.provider) ?? "unknown",
    biller: resolveLedgerBiller(input.adapterResult),
    model: readNonEmptyString(input.adapterResult.model) ?? "unknown",
    ...(premiumRequests != null ? { premiumRequests } : {}),
    ...(input.costUsdForUsage != null ? { costUsd: input.costUsdForUsage } : {}),
    ...(input.resolvedCost.rawUnits != null
      ? {
        costRawUnits: Number(input.resolvedCost.rawUnits),
        costRawUnitType: input.resolvedCost.rawUnitType,
      }
      : {}),
    billingType: normalizeLedgerBillingType(input.adapterResult.billingType),
  } as Record<string, unknown>;
}

function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

function deriveNormalizedUsageDelta(current: UsageTotals | null, previous: UsageTotals | null): UsageTotals | null {
  if (!current) return null;
  if (!previous) return { ...current };

  const inputTokens = current.inputTokens >= previous.inputTokens
    ? current.inputTokens - previous.inputTokens
    : current.inputTokens;
  const cachedInputTokens = current.cachedInputTokens >= previous.cachedInputTokens
    ? current.cachedInputTokens - previous.cachedInputTokens
    : current.cachedInputTokens;
  const outputTokens = current.outputTokens >= previous.outputTokens
    ? current.outputTokens - previous.outputTokens
    : current.outputTokens;

  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.adapterType, agent.runtimeConfig).policy;
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  agentId: string;
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { agentId, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (!previousSessionId || !previousCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (resolvedWorkspace.source !== "project_primary") {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const projectCwd = readNonEmptyString(resolvedWorkspace.cwd);
  if (!projectCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const fallbackAgentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
  if (path.resolve(previousCwd) !== path.resolve(fallbackAgentHomeCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (path.resolve(projectCwd) === path.resolve(previousCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);
  if (
    previousWorkspaceId &&
    resolvedWorkspace.workspaceId &&
    previousWorkspaceId !== resolvedWorkspace.workspaceId
  ) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: projectCwd,
  };
  if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
  if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
  if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;

  return {
    sessionParams: migratedSessionParams,
    warning:
      `Project workspace "${projectCwd}" is now available. ` +
      `Attempting to resume session "${previousSessionId}" that was previously saved in fallback workspace "${previousCwd}".`,
  };
}

function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return true;
  return false;
}

export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[paperclip] ${warning}\n`,
  };
}

/**
 * Returns the legacy session ID from runtime state only when the stored adapter
 * type matches the current adapter type. If the adapter family has changed, the
 * persisted session ID is incompatible and must not be forwarded to the new
 * adapter as a resume target.
 */
export function resolveRuntimeSessionFallback(
  runtime: { sessionId: string | null; adapterType: string },
  currentAdapterType: string,
): string | null {
  if (runtime.adapterType !== currentAdapterType) return null;
  return runtime.sessionId;
}

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  return null;
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

export function prepareWakeupExecutionViews(
  input: {
    contextSnapshot: Record<string, unknown>;
    reason: string | null;
    source: WakeupOptions["source"];
    triggerDetail: WakeupOptions["triggerDetail"] | null;
    payload: Record<string, unknown> | null;
    idempotencyKey?: string | null;
  },
  opts?: CurrentUserRedactionOptions,
) {
  const operationalInput = {
    ...input,
    contextSnapshot: { ...input.contextSnapshot },
    payload: input.payload ? { ...input.payload } : null,
  };
  const enriched = enrichWakeContextSnapshot(operationalInput);
  return {
    operational: {
      ...enriched,
      reason: operationalInput.reason,
      payload: operationalInput.payload,
      triggerDetail: operationalInput.triggerDetail,
      idempotencyKey: operationalInput.idempotencyKey,
    },
    persisted: sanitizeWakeupExecutionInput(
      {
        reason: operationalInput.reason,
        payload: operationalInput.payload,
        triggerDetail: operationalInput.triggerDetail,
        idempotencyKey: operationalInput.idempotencyKey,
        contextSnapshot: enriched.contextSnapshot,
      },
      opts,
    ),
  };
}

export function resolveHeartbeatExecutionContext(
  persistedContextSnapshot: unknown,
  transientContextSnapshot?: Record<string, unknown> | null,
): Record<string, unknown> {
  return transientContextSnapshot ?? parseObject(persistedContextSnapshot);
}

function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const commentId = deriveCommentId(incoming, null);
  if (commentId) {
    merged.commentId = commentId;
    merged.wakeCommentId = commentId;
  }
  return merged;
}

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

function isRecordedProcessTreeAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPERM") return true;
    }
  }
  return isProcessAlive(pid);
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

export function heartbeatService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });
  const transientExecutionContextsByRunId = sharedTransientExecutionContextStore;
  const stageTransientExecutionContext = (
    key: string,
    context: Record<string, unknown>,
  ) => {
    const reservation = transientExecutionContextsByRunId.stage(key, context);
    if (!reservation) {
      throw new Error("Unable to reserve bounded transient execution context");
    }
    return reservation;
  };

  const runLogStore = getRunLogStore();
  const sanitizedLogCache = getSanitizedNdjsonLogCache();
  const sanitizedRunLogSource = (handle: RunLogHandle): SanitizedLogSource => ({
    namespace: "heartbeat-run",
    owner: runLogStore,
    logRef: handle.logRef,
  });
  const appendRunLog = async (
    handle: RunLogHandle,
    event: Parameters<typeof runLogStore.append>[1],
  ) => {
    const source = sanitizedRunLogSource(handle);
    sanitizedLogCache.invalidate(source);
    try {
      await runLogStore.append(handle, event);
    } finally {
      sanitizedLogCache.invalidate(source);
    }
  };
  const finalizeRunLog = async (handle: RunLogHandle) => {
    const source = sanitizedRunLogSource(handle);
    sanitizedLogCache.invalidate(source);
    try {
      return await runLogStore.finalize(handle);
    } finally {
      sanitizedLogCache.invalidate(source);
    }
  };
  const secretsSvc = secretService(db);
  const companySkills = companySkillService(db);
  const issuesSvc = issueService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const activeRunExecutions = new Set<string>();
  const budgetHooks = {
    cancelWorkForScope: cancelBudgetScopeWork,
  };
  const budgets = budgetService(db, budgetHooks);
  const adapterStatusSvc = adapterStatusService(db);
  const agentsSvc = agentService(db);

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function terminateRegisteredRunProcess(runId: string) {
    const running = runningProcesses.get(runId);
    if (!running) return true;
    const graceMs = Math.min(
      RUN_CANCELLATION_GRACE_MAX_MS,
      Math.max(0, running.graceSec * 1000),
    );
    const exited = await terminateLocalAdapterProcess(running.child, {
      processGroup: running.processGroup === true,
      graceMs,
      killWaitMs: RUN_CANCELLATION_KILL_WAIT_MS,
    });
    if (exited && runningProcesses.get(runId) === running) {
      runningProcesses.delete(runId);
    }
    return exited;
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestRunForSession(
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null; requireNonZeroUsage?: boolean },
  ) {
    const conditions = [
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    if (opts?.requireNonZeroUsage) {
      // Skip runs that recorded no token usage (e.g. quick failures) — they don't
      // advance the session context and must not be used as a delta baseline.
      conditions.push(
        sql`COALESCE((${heartbeatRuns.usageJson}->>'rawInputTokens')::numeric, (${heartbeatRuns.usageJson}->>'inputTokens')::numeric, 0) > 0`,
      );
    }
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getOldestRunForSession(agentId: string, sessionId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveNormalizedUsageForSession(input: {
    agentId: string;
    runId: string;
    sessionId: string | null;
    rawUsage: UsageTotals | null;
  }) {
    const { agentId, runId, sessionId, rawUsage } = input;
    if (!sessionId || !rawUsage) {
      return {
        normalizedUsage: rawUsage,
        previousRawUsage: null as UsageTotals | null,
        derivedFromSessionTotals: false,
      };
    }

    const previousRun = await getLatestRunForSession(agentId, sessionId, {
      excludeRunId: runId,
      requireNonZeroUsage: true,
    });
    const previousRawUsage = readRawUsageTotals(previousRun?.usageJson);
    return {
      normalizedUsage: deriveNormalizedUsageDelta(rawUsage, previousRawUsage),
      previousRawUsage,
      derivedFromSessionTotals: previousRawUsage !== null,
    };
  }

  async function evaluateSessionCompaction(input: {
    agent: typeof agents.$inferSelect;
    sessionId: string | null;
    issueId: string | null;
  }): Promise<SessionCompactionDecision> {
    const { agent, sessionId, issueId } = input;
    if (!sessionId) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const policy = parseSessionCompactionPolicy(agent);
    if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const fetchLimit = Math.max(policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0, 4);
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(fetchLimit);

    if (runs.length === 0) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const latestRun = runs[0] ?? null;
    const oldestRun =
      policy.maxSessionAgeHours > 0
        ? await getOldestRunForSession(agent.id, sessionId)
        : runs[runs.length - 1] ?? latestRun;
    const latestRawUsage = readRawUsageTotals(latestRun?.usageJson);
    const sessionAgeHours =
      latestRun && oldestRun
        ? Math.max(
            0,
            (new Date(latestRun.createdAt).getTime() - new Date(oldestRun.createdAt).getTime()) / (1000 * 60 * 60),
          )
        : 0;

    let reason: string | null = null;
    if (policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
      reason = `session exceeded ${policy.maxSessionRuns} runs`;
    } else if (
      policy.maxRawInputTokens > 0 &&
      latestRawUsage &&
      latestRawUsage.inputTokens >= policy.maxRawInputTokens
    ) {
      reason =
        `session raw input reached ${formatCount(latestRawUsage.inputTokens)} tokens ` +
        `(threshold ${formatCount(policy.maxRawInputTokens)})`;
    } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
      reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
    }

    if (!reason || !latestRun) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: latestRun?.id ?? null,
      };
    }

    const latestSummary = summarizeHeartbeatRunResultJson(latestRun.resultJson);
    const rawLatestTextSummary =
      readNonEmptyString(latestSummary?.summary) ??
      readNonEmptyString(latestSummary?.result) ??
      readNonEmptyString(latestSummary?.message) ??
      readNonEmptyString(latestRun.error);
    const handoffMarkdown = buildSessionHandoffMarkdown(
      {
        sessionId,
        issueId,
        reason,
        latestTextSummary: rawLatestTextSummary,
      },
      await getCurrentUserRedactionOptions(),
    );

    return {
      rotate: true,
      reason,
      handoffMarkdown,
      previousRunId: latestRun.id,
    };
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    if (taskKey) {
      const codec = getAdapterSessionCodec(agent.adapterType);
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun ? resolveRuntimeSessionFallback(runtimeForRun, agent.adapterType) : null;
  }

  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const contextProjectWorkspaceId = readNonEmptyString(context.projectWorkspaceId);
    const issueProjectRef = issueId
      ? await db
          .select({
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueProjectId = issueProjectRef?.projectId ?? null;
    const preferredProjectWorkspaceId =
      issueProjectRef?.projectWorkspaceId ?? contextProjectWorkspaceId ?? null;
    const resolvedProjectId = issueProjectId ?? contextProjectId;
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

    const unorderedProjectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, agent.companyId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];
    const projectWorkspaceRows = prioritizeProjectWorkspaceCandidatesForRun(
      unorderedProjectWorkspaceRows,
      preferredProjectWorkspaceId,
    );

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      const preferredWorkspace = preferredProjectWorkspaceId
        ? projectWorkspaceRows.find((workspace) => workspace.id === preferredProjectWorkspaceId) ?? null
        : null;
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      let preferredWorkspaceWarning: string | null = null;
      if (preferredProjectWorkspaceId && !preferredWorkspace) {
        preferredWorkspaceWarning =
          `Selected project workspace "${preferredProjectWorkspaceId}" is not available on this project.`;
      }
      for (const workspace of projectWorkspaceRows) {
        let projectCwd = readNonEmptyString(workspace.cwd);
        let managedWorkspaceWarning: string | null = null;
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) {
          try {
            const managedWorkspace = await ensureManagedProjectWorkspace({
              companyId: agent.companyId,
              projectId: workspaceProjectId ?? resolvedProjectId ?? workspace.projectId,
              repoUrl: readNonEmptyString(workspace.repoUrl),
            });
            projectCwd = managedWorkspace.cwd;
            managedWorkspaceWarning = managedWorkspace.warning;
          } catch (error) {
            if (preferredWorkspace?.id === workspace.id) {
              preferredWorkspaceWarning = error instanceof Error ? error.message : String(error);
            }
            continue;
          }
        }
        hasConfiguredProjectCwd = true;
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary" as const,
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
            warnings: [preferredWorkspaceWarning, managedWorkspaceWarning].filter(
              (value): value is string => Boolean(value),
            ),
          };
        }
        if (preferredWorkspace?.id === workspace.id) {
          preferredWorkspaceWarning =
            `Selected project workspace path "${projectCwd}" is not available yet.`;
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
      await fs.mkdir(fallbackCwd, { recursive: true });
      const warnings: string[] = [];
      if (preferredWorkspaceWarning) {
        warnings.push(preferredWorkspaceWarning);
      }
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fallbackCwd}" for this run.`
            : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project workspace has no local cwd configured. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      }
      return {
        cwd: fallbackCwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
        warnings,
      };
    }

    if (workspaceProjectId) {
      const managedWorkspace = await ensureManagedProjectWorkspace({
        companyId: agent.companyId,
        projectId: workspaceProjectId,
        repoUrl: null,
      });
      return {
        cwd: managedWorkspace.cwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        workspaceHints,
        warnings: managedWorkspace.warning ? [managedWorkspace.warning] : [],
      };
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    if (sessionCwd) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session" as const,
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
          warnings: [],
        };
      }
    }

    const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(cwd, { recursive: true });
    const warnings: string[] = [];
    if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
      );
    } else {
      warnings.push(
        `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
      );
    }
    return {
      cwd,
      source: "agent_home" as const,
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
    };
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  /**
   * Intercept batch queue signals from adapter and insert into batch_queue_entries.
   * Transforms sessionParams to replace batchQueue with batchPending flags.
   * Returns { entryId, transformedParams } or null if no batch queue signal.
   */
  async function processBatchQueueSignal(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    runId: string;
    sessionParams: Record<string, unknown> | null;
    redactionOptions: CurrentUserRedactionOptions;
  }): Promise<{ entryId: string; transformedParams: Record<string, unknown> } | null> {
    if (!input.sessionParams) return null;

    const batchQueue = parseObject(input.sessionParams.batchQueue);
    if (Object.keys(batchQueue).length === 0) return null;

    const customId = asString(batchQueue.customId, "");
    const requestParamsJson = parseObject(batchQueue.requestParamsJson);
    if (!customId || Object.keys(requestParamsJson).length === 0) return null;

    // Extract the snapshot and queue time for restoration
    const sessionParamsSnapshot = parseObject(input.sessionParams.sessionParamsSnapshot);
    const batchQueuedAt = asString(input.sessionParams.batchQueuedAt, new Date().toISOString());
    const persistedBatchFields = redactDiagnosticResponseValue(
      {
        payload: {
          customId,
          requestParamsJson,
          sessionParamsSnapshot,
        },
      },
      { ...input.redactionOptions, enabled: false },
    ).payload;
    const persistedCustomId = asString(persistedBatchFields.customId, "");
    const persistedRequestParamsJson = parseObject(persistedBatchFields.requestParamsJson);
    const persistedSessionParamsSnapshot = parseObject(
      persistedBatchFields.sessionParamsSnapshot,
    );
    const hasSessionParamsSnapshot = Object.keys(sessionParamsSnapshot).length > 0;
    if (
      persistedCustomId !== customId ||
      !/^pclp_[0-9a-f]{32}$/.test(persistedCustomId) ||
      Object.keys(persistedRequestParamsJson).length === 0 ||
      (hasSessionParamsSnapshot && Object.keys(persistedSessionParamsSnapshot).length === 0)
    ) {
      logger.warn(
        { runId: input.runId, companyId: input.companyId, agentId: input.agentId },
        "batch queue signal rejected by persistence boundary",
      );
      return null;
    }

    try {
      // INSERT into batch_queue_entries
      const result = await db
        .insert(batchQueueEntries)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          customId: persistedCustomId,
          adapterType: input.adapterType,
          taskKey: input.taskKey,
          runId: input.runId,
          requestParamsJson: persistedRequestParamsJson,
          sessionParamsSnapshotJson:
            Object.keys(persistedSessionParamsSnapshot).length > 0
              ? persistedSessionParamsSnapshot
              : null,
          status: "pending",
        })
        .returning();

      if (!result || result.length === 0) {
        logger.warn({ runId: input.runId }, "batch queue entry insert returned no rows");
        return null;
      }

      const entry = result[0];

      // Transform sessionParams: remove batchQueue, add batchPending flags
      const transformedParams: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input.sessionParams)) {
        if (key !== "batchQueue" && key !== "sessionParamsSnapshot") {
          transformedParams[key] = value;
        }
      }
      transformedParams.batchPending = true;
      transformedParams.batchEntryId = entry.id;
      transformedParams.batchQueuedAt = batchQueuedAt;

      logger.debug(
        { entryId: entry.id, companyId: input.companyId, agentId: input.agentId },
        "batch queue entry created and sessionParams transformed",
      );

      return {
        entryId: entry.id,
        transformedParams,
      };
    } catch {
      logger.error(
        { runId: input.runId, companyId: input.companyId, agentId: input.agentId },
        "failed to process batch queue signal",
      );
      return null;
    }
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(heartbeatRuns.id, runId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated && TERMINAL_RUN_STATUSES.has(status)) {
      runActivityRegistry.clear(runId);
      transientExecutionContextsByRunId.delete(runId);
    }

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: buildHeartbeatRunStatusPayload(updated),
      });
    }

    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const sanitizedEvent = redactHeartbeatRunEventContent(
      { message: event.message, payload: event.payload },
      currentUserRedactionOptions,
    );
    const sanitizedMessage = sanitizedEvent.message;
    const sanitizedPayload = sanitizedEvent.payload;

    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
    });
    runActivityRegistry.record(run.id, "db_event");

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: sanitizedMessage ?? null,
        payload: sanitizedPayload ?? null,
      },
    });
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function persistRunProcessMetadata(
    runId: string,
    meta: { pid: number; startedAt: string },
  ) {
    const startedAt = new Date(meta.startedAt);
    return db
      .update(heartbeatRuns)
      .set({
        processPid: meta.pid,
        processStartedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, runId),
          eq(heartbeatRuns.status, "running"),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearDetachedRunWarning(runId: string) {
    const updated = await db
      .update(heartbeatRuns)
      .set({
        error: null,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.errorCode, DETACHED_PROCESS_ERROR_CODE)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;

    await appendRunEvent(updated, await nextRunEventSeq(updated.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Detached child process reported activity; cleared detached warning",
    });
    return updated;
  }

  async function enqueueRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    errorCode: string,
    now: Date,
    options?: {
      operationalContextSnapshot?: Record<string, unknown>;
      redactionOptions?: CurrentUserRedactionOptions;
    },
  ) {
    const policy = RETRY_POLICY[errorCode];
    if (!policy) return null;

    const retryCount = run.processLossRetryCount ?? 0;
    if (retryCount >= policy.maxRetries) return null;

    const contextSnapshot = parseObject(run.contextSnapshot);
    const operationalContextSnapshot = options?.operationalContextSnapshot ?? contextSnapshot;
    const issueId = readNonEmptyString(operationalContextSnapshot.issueId);
    const taskKey = deriveTaskKey(operationalContextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const scheduledAt = policy.delayMs > 0 ? new Date(now.getTime() + policy.delayMs) : null;
    const retryOperationalContextSnapshot = {
      ...operationalContextSnapshot,
      retryOfRunId: run.id,
      wakeReason: `${errorCode}_retry`,
      retryReason: errorCode,
      ...(scheduledAt ? { retryNotBeforeAt: scheduledAt.toISOString() } : {}),
    };
    const retryContextSnapshot = sanitizeWakeupExecutionInput(
      { contextSnapshot: retryOperationalContextSnapshot },
      options?.redactionOptions ?? (await getCurrentUserRedactionOptions()),
    ).contextSnapshot;

    const retryContextReservation: {
      current: ReturnType<typeof stageTransientExecutionContext> | null;
    } = { current: null };
    let queued: typeof heartbeatRuns.$inferSelect;
    try {
      queued = await db.transaction(async (tx) => {
        const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: `${errorCode}_retry`,
          payload: {
            ...(issueId ? { issueId } : {}),
            retryOfRunId: run.id,
          },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

        const retryRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: retryContextSnapshot,
          sessionIdBefore: sessionBefore,
          retryOfRunId: run.id,
          processLossRetryCount: retryCount + 1,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

        await tx
        .update(agentWakeupRequests)
        .set({
          runId: retryRun.id,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        if (issueId) {
          await tx
          .update(issues)
          .set({
            executionRunId: retryRun.id,
            executionAgentNameKey: normalizeAgentNameKey(agent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
        }

        retryContextReservation.current = stageTransientExecutionContext(
          retryRun.id,
          retryOperationalContextSnapshot,
        );
        return retryRun;
      });
      retryContextReservation.current?.commit();
    } catch (error) {
      retryContextReservation.current?.rollback();
      throw error;
    }

    publishLiveEvent({
      companyId: queued.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: queued.id,
        agentId: queued.agentId,
        invocationSource: queued.invocationSource,
        triggerDetail: queued.triggerDetail,
        wakeupRequestId: queued.wakeupRequestId,
      },
    });

    const delayNote = policy.delayMs > 0 ? ` (delay ${Math.round(policy.delayMs / 1000)}s)` : "";
    await appendRunEvent(queued, 1, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: `Queued automatic retry for ${errorCode} (attempt ${retryCount + 1}/${policy.maxRetries})${delayNote}`,
      payload: {
        retryOfRunId: run.id,
        errorCode,
        retryCount: retryCount + 1,
      },
    });

    return queued;
  }

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    };
  }

  async function countRunningRunsForAgent(agentId: string) {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          or(
            eq(heartbeatRuns.status, "running"),
            eq(heartbeatRuns.errorCode, PROCESS_TERMINATION_PENDING_ERROR_CODE),
          ),
        ),
      );
    const activeRunIds = new Set(rows.map(({ id }) => id));
    for (const [runId, coordination] of runExecutionCoordinationByRunId) {
      if (coordination.agentId === agentId && coordination.phase !== "settled") {
        activeRunIds.add(runId);
      }
    }
    return activeRunIds.size;
  }

  async function hasActiveEmulation(agentId: string) {
    return db
      .select({ id: agentEmulationSessions.id })
      .from(agentEmulationSessions)
      .where(
        and(
          eq(agentEmulationSessions.agentId, agentId),
          isNull(agentEmulationSessions.endedAt),
          gt(agentEmulationSessions.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
  }

  type QueueClaimDisposition =
    | { kind: "claimed"; run: typeof heartbeatRuns.$inferSelect }
    | { kind: "cancel"; reason: string }
    | { kind: "skip" };

  async function claimQueuedRun(
    run: typeof heartbeatRuns.$inferSelect,
    reserveExecution?: () => Promise<boolean>,
  ): Promise<QueueClaimDisposition> {
    if (run.status !== "queued") return { kind: "skip" };
    const agent = await getAgent(run.agentId);
    if (!agent) {
      return { kind: "cancel", reason: "Cancelled because the agent no longer exists" };
    }
    if (await hasActiveEmulation(run.agentId)) {
      return { kind: "skip" };
    }
    if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
      return { kind: "cancel", reason: "Cancelled because the agent is not invokable" };
    }

    const context = resolveHeartbeatExecutionContext(
      run.contextSnapshot,
      transientExecutionContextsByRunId.get(run.id),
    );

    // Safety gate for delayed retries: if retryNotBeforeAt is in the future, skip claiming
    const retryNotBeforeAt = readNonEmptyString(context.retryNotBeforeAt);
    if (retryNotBeforeAt && new Date(retryNotBeforeAt) > new Date()) {
      return { kind: "skip" };
    }

    const budgetBlock = await budgets.getInvocationBlock(run.companyId, run.agentId, {
      issueId: readNonEmptyString(context.issueId),
      projectId: readNonEmptyString(context.projectId),
    });
    if (budgetBlock) {
      return { kind: "cancel", reason: budgetBlock.reason };
    }

    if (reserveExecution && !(await reserveExecution())) return { kind: "skip" };

    const claimedAt = new Date();
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${run.agentId}, 0))`,
      );
      const activeEmulation = await tx
        .select({ id: agentEmulationSessions.id })
        .from(agentEmulationSessions)
        .where(
          and(
            eq(agentEmulationSessions.agentId, run.agentId),
            isNull(agentEmulationSessions.endedAt),
            gt(agentEmulationSessions.expiresAt, new Date()),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (activeEmulation) return null;

      return tx
        .update(heartbeatRuns)
        .set({
          status: "running",
          startedAt: run.startedAt ?? claimedAt,
          updatedAt: claimedAt,
        })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
        .returning()
        .then((rows) => rows[0] ?? null);
    });
    if (!claimed) return { kind: "skip" };

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: buildHeartbeatRunStatusPayload(claimed),
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    return { kind: "claimed", run: claimed };
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }
    if (await hasActiveEmulation(agentId)) {
      return;
    }

    const runningCount = await countRunningRunsForAgent(agentId);

    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  /**
   * Build a summary of the agent's most recent run if it failed.
   * Injected into the next run's context so the agent knows what happened.
   */
  async function buildLastRunSummary(agentId: string, currentRunId: string) {
    const previousRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.id} != ${currentRunId}`,
          eq(heartbeatRuns.status, "failed"),
          isNotNull(heartbeatRuns.startedAt),
        ),
      )      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!previousRun || previousRun.status !== "failed") return null;

    const startMs = previousRun.startedAt ? new Date(previousRun.startedAt).getTime() : 0;
    const endMs = previousRun.finishedAt ? new Date(previousRun.finishedAt).getTime() : 0;
    const durationMs = startMs && endMs ? endMs - startMs : null;

    // Fetch the last few events from the failed run for context
    const events = await db
      .select({
        eventType: heartbeatRunEvents.eventType,
        message: heartbeatRunEvents.message,
        level: heartbeatRunEvents.level,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, previousRun.id))
      .orderBy(desc(heartbeatRunEvents.seq))
      .limit(5);

    return buildLastRunSummaryPayload({
      runId: previousRun.id,
      status: previousRun.status,
      errorCode: previousRun.errorCode ?? null,
      error: previousRun.error ?? null,
      durationMs,
      issueId: readNonEmptyString(previousRun.issueId) ?? null,
      lastEvents: events.reverse().map((e) => ({
        type: e.eventType,
        message: e.message,
        level: e.level,
      })),
    }, await getCurrentUserRedactionOptions());
  }

  async function killAndFinalizeAsTimeout(
    run: typeof heartbeatRuns.$inferSelect,
    now: Date,
    timeoutMessage: string,
    extraPayload: Record<string, unknown>,
  ) {
    const transition = await withRunLaunchLock(run.id, async () => {
      const current = await getRun(run.id);
      if (current?.status !== "running" && current?.status !== "queued") return null;
      const timedOutRun = await setRunStatus(run.id, "failed", {
        error: timeoutMessage,
        errorCode: "timeout",
        finishedAt: now,
      });
      if (!timedOutRun) return null;
      const coordination = runExecutionCoordinationByRunId.get(run.id) ?? null;
      if (coordination) coordination.cancellationWon = true;
      let processTerminated = await terminateRegisteredRunProcess(run.id);
      if (!runningProcesses.has(run.id) && run.processPid && isProcessAlive(run.processPid)) {
        try {
          process.kill(run.processPid, "SIGTERM");
          const exitedAfterTerm = await waitForPromiseWithTimeout(
            new Promise<void>((resolve) => {
              const poll = setInterval(() => {
                if (!isProcessAlive(run.processPid!)) {
                  clearInterval(poll);
                  resolve();
                }
              }, 25);
              poll.unref?.();
            }),
            RUN_CANCELLATION_GRACE_MAX_MS,
          );
          if (!exitedAfterTerm && isProcessAlive(run.processPid)) {
            process.kill(run.processPid, "SIGKILL");
          }
          processTerminated = !isProcessAlive(run.processPid);
        } catch {
          processTerminated = !isProcessAlive(run.processPid);
        }
      }
      if (coordination) coordination.terminationProven = processTerminated;
      const persistedTimedOutRun = processTerminated
        ? timedOutRun
        : await db
            .update(heartbeatRuns)
            .set({
              errorCode: PROCESS_TERMINATION_PENDING_ERROR_CODE,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(heartbeatRuns.id, timedOutRun.id),
                eq(heartbeatRuns.status, timedOutRun.status),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? timedOutRun);
      return { timedOutRun: persistedTimedOutRun, coordination, processTerminated };
    });
    if (!transition) return false;
    const { timedOutRun, coordination, processTerminated } = transition;
    if (coordination) await coordination.executionSettled;
    if (!processTerminated) return false;
    await setWakeupStatus(run.wakeupRequestId, "failed", {
      finishedAt: now,
      error: timeoutMessage,
    });
    await appendRunEvent(timedOutRun, await nextRunEventSeq(timedOutRun.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "error",
      message: timeoutMessage,
      payload: { ...(run.processPid ? { processPid: run.processPid } : {}), ...extraPayload },
    });
    await releaseIssueExecutionAndPromote(timedOutRun);
    await finalizeAgentStatus(run.agentId, "timed_out");
    activeRunExecutions.delete(run.id);
    await startNextQueuedRunForAgent(run.agentId);
    return true;
  }

  async function getLastRunEventAt(runId: string): Promise<Date | null> {
    const [row] = await db
      .select({ createdAt: heartbeatRunEvents.createdAt })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .orderBy(desc(heartbeatRunEvents.seq))
      .limit(1);
    return row?.createdAt ? new Date(row.createdAt) : null;
  }

  async function reapOrphanedRuns(opts?: {
    staleThresholdMs?: number;
    maxRunDurationMs?: number;
    eventSilenceThresholdMs?: number;
  }) {
    const emulationReap = await agentsSvc.reapEmulations({ isProcessAlive });
    if (emulationReap.expired > 0 || emulationReap.deadClients > 0) {
      logger.warn(emulationReap, "reaped external agent emulation leases");
    }
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const maxRunDurationMs = opts?.maxRunDurationMs ?? 0;
    const eventSilenceThresholdMs = opts?.eventSilenceThresholdMs ?? 0;
    const now = new Date();

    const recoveredTerminations = await db
      .select({ run: heartbeatRuns, adapterType: agents.adapterType })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.errorCode, PROCESS_TERMINATION_PENDING_ERROR_CODE),
          inArray(heartbeatRuns.status, ["cancelled", "failed"]),
        ),
      )
      .orderBy(asc(heartbeatRuns.updatedAt))
      .limit(PROCESS_TERMINATION_RECOVERY_LIMIT);
    const reaped: string[] = [];
    for (const { run: pendingRun, adapterType } of recoveredTerminations) {
      if (
        activeRunExecutions.has(pendingRun.id) ||
        runExecutionCoordinationByRunId.has(pendingRun.id)
      ) {
        continue;
      }
      const registeredProcessTerminated = runningProcesses.has(pendingRun.id)
        ? await terminateRegisteredRunProcess(pendingRun.id).catch(() => false)
        : null;
      if (registeredProcessTerminated === false) {
        continue;
      }
      if (
        registeredProcessTerminated === null &&
        isTrackedLocalChildProcessAdapter(adapterType) &&
        pendingRun.processPid !== null &&
        isRecordedProcessTreeAlive(pendingRun.processPid)
      ) {
        continue;
      }
      const recoveredErrorCode =
        pendingRun.status === "cancelled"
          ? "cancelled"
          : pendingRun.error === PROCESS_TERMINATION_PENDING_ERROR_MESSAGE
            ? "adapter_failed"
            : "timeout";
      const recovered = await db
        .update(heartbeatRuns)
        .set({
          errorCode: recoveredErrorCode,
          processPid: null,
          processStartedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(heartbeatRuns.id, pendingRun.id),
            eq(heartbeatRuns.status, pendingRun.status),
            eq(heartbeatRuns.errorCode, PROCESS_TERMINATION_PENDING_ERROR_CODE),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!recovered) continue;
      try {
        await setWakeupStatus(
          recovered.wakeupRequestId,
          recovered.status === "cancelled" ? "cancelled" : "failed",
          { finishedAt: recovered.finishedAt ?? now, error: recovered.error },
        );
        await releaseIssueExecutionAndPromote(recovered);
      } catch (error) {
        await db
          .update(heartbeatRuns)
          .set({
            errorCode: PROCESS_TERMINATION_PENDING_ERROR_CODE,
            processPid: pendingRun.processPid,
            processStartedAt: pendingRun.processStartedAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(heartbeatRuns.id, recovered.id),
              eq(heartbeatRuns.status, recovered.status),
              eq(heartbeatRuns.errorCode, recoveredErrorCode),
            ),
          );
        throw error;
      }
      await appendRunEvent(recovered, await nextRunEventSeq(recovered.id), {
        eventType: "lifecycle",
        stream: "system",
        level: recovered.status === "cancelled" ? "warn" : "error",
        message: "process termination confirmed; queued work may resume",
      }).catch(() => undefined);
      await finalizeAgentStatus(
        recovered.agentId,
        recovered.status === "cancelled" ? "cancelled" : "failed",
      );
      await startNextQueuedRunForAgent(recovered.agentId);
      reaped.push(recovered.id);
    }

    // Find all runs stuck in "running" state (queued runs are legitimately waiting; resumeQueuedRuns handles them)
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        adapterType: agents.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.status, "running"));

    for (const { run, adapterType } of activeRuns) {
      // Apply staleness threshold to avoid false positives on very fresh runs.
      // This applies to the in-memory-tracked path too: a run that was just claimed
      // shouldn't be touched even if duration/silence thresholds would otherwise fire.
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      const tracksLocalChild = isTrackedLocalChildProcessAdapter(adapterType);
      const pidAlive = tracksLocalChild && !!run.processPid && isProcessAlive(run.processPid);

      // 1) Hard duration timeout. Fires regardless of in-memory tracking — a wedged
      //    in-memory pump (e.g. ctx_execute waiting on a backgrounded next-server
      //    that never closes its stdout) must not be able to bypass this cap.
      if (pidAlive && maxRunDurationMs > 0) {
        const runStartTime = run.processStartedAt
          ? new Date(run.processStartedAt).getTime()
          : run.startedAt
            ? new Date(run.startedAt).getTime()
            : 0;
        if (runStartTime > 0 && now.getTime() - runStartTime > maxRunDurationMs) {
          const durationMin = Math.round((now.getTime() - runStartTime) / 60_000);
          const maxMin = Math.round(maxRunDurationMs / 60_000);
          logger.warn(
            { runId: run.id, pid: run.processPid, durationMin },
            `killing hung process after ${durationMin}min (max ${maxMin}min)`,
          );
          const finalized = await killAndFinalizeAsTimeout(
            run,
            now,
            `Run exceeded max duration of ${maxMin}min; process killed`,
            { durationMin, maxDurationMin: maxMin, reason: "max_duration" },
          );
          if (finalized) reaped.push(run.id);
          continue;
        }
      }

      // 2) Idle watchdog. If the run has produced no meaningful activity
      //    for `eventSilenceThresholdMs`, the adapter pump is stuck. Kill
      //    regardless of in-memory tracking — same wedge mode, different
      //    signal.
      //
      //    Activity is sourced from two places that update the in-memory
      //    `runActivityRegistry`:
      //      * `stream`   — meaningful adapter stdout JSON events (see
      //                     `chunkHasMeaningfulActivity`).
      //      * `db_event` — any row written to `heartbeat_run_events` via
      //                     `appendRunEvent`.
      //    When the registry has no entry for this run (e.g. after a server
      //    restart) we fall back to the persisted `heartbeat_run_events`
      //    timestamp directly. The fallback path is intentionally narrower
      //    than the original behaviour: it still reaps genuinely idle runs,
      //    but it no longer kills runs that are mid-task with active stream
      //    output. A single watchdog tick performs at most one fallback DB
      //    query per run and never reads the run log files from disk.
      if (pidAlive && eventSilenceThresholdMs > 0) {
        const activity = runActivityRegistry.get(run.id);
        let lastActivityAt: Date | null = null;
        let lastActivitySource: ActivitySource | "run_started" | null = null;
        if (activity) {
          lastActivityAt = activity.lastActivityAt;
          lastActivitySource = activity.lastActivitySource;
        } else {
          const lastEventAt = await getLastRunEventAt(run.id);
          if (lastEventAt) {
            lastActivityAt = lastEventAt;
            lastActivitySource = "db_event";
          } else if (run.startedAt) {
            lastActivityAt = new Date(run.startedAt);
            lastActivitySource = "run_started";
          }
        }
        if (lastActivityAt && lastActivitySource) {
          const observedIdleMs = now.getTime() - lastActivityAt.getTime();
          if (observedIdleMs > eventSilenceThresholdMs) {
            const observedIdleMin = Math.round(observedIdleMs / 60_000);
            const thresholdMin = Math.round(eventSilenceThresholdMs / 60_000);
            const timeoutMessage = `Run idle for ${observedIdleMin}min since last ${lastActivitySource} activity (threshold ${thresholdMin}min); process killed`;
            logger.warn(
              {
                runId: run.id,
                agentId: run.agentId,
                adapter: adapterType,
                pid: run.processPid,
                lastActivityAt: lastActivityAt.toISOString(),
                lastActivitySource,
                idleThresholdMs: eventSilenceThresholdMs,
                observedIdleMs,
              },
              timeoutMessage,
            );
            const finalized = await killAndFinalizeAsTimeout(
              run,
              now,
              timeoutMessage,
              {
                runId: run.id,
                agentId: run.agentId,
                adapter: adapterType,
                lastActivityAt: lastActivityAt.toISOString(),
                lastActivitySource,
                idleThresholdMs: eventSilenceThresholdMs,
                observedIdleMs,
                reason: "idle_timeout",
              },
            );
            if (finalized) reaped.push(run.id);
            continue;
          }
        }
      }

      // From here on we only handle the case where the server has lost the
      // in-memory handle. Runs that the server is still actively driving and
      // that have not tripped a watchdog above are left alone.
      if (
        runningProcesses.has(run.id) ||
        activeRunExecutions.has(run.id) ||
        runExecutionCoordinationByRunId.has(run.id)
      ) continue;

      if (tracksLocalChild && run.processPid && isProcessAlive(run.processPid)) {
        if (run.errorCode !== DETACHED_PROCESS_ERROR_CODE) {
          const detachedMessage = `Lost in-memory process handle, but child pid ${run.processPid} is still alive`;
          const detachedRun = await setRunStatus(run.id, "running", {
            error: detachedMessage,
            errorCode: DETACHED_PROCESS_ERROR_CODE,
          });
          if (detachedRun) {
            await appendRunEvent(detachedRun, await nextRunEventSeq(detachedRun.id), {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: detachedMessage,
              payload: {
                processPid: run.processPid,
              },
            });
          }
        }
        continue;
      }

      const baseMessage = run.processPid
        ? `Process lost -- child pid ${run.processPid} is no longer running`
        : "Process lost -- server may have restarted";

      const finalizedRun = await setRunStatus(run.id, "failed", {
        error: baseMessage,
        errorCode: "process_lost",
        finishedAt: now,
      });
      if (!finalizedRun) {
        runningProcesses.delete(run.id);
        continue;
      }
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: baseMessage,
      });

      let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
      const agent = await getAgent(run.agentId);
      if (agent) {
        retriedRun = await enqueueRetry(finalizedRun, agent, "process_lost", now);
      }
      if (!retriedRun) {
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: retriedRun
          ? `${baseMessage}; queued retry ${retriedRun.id}`
          : baseMessage,
        payload: {
          ...(run.processPid ? { processPid: run.processPid } : {}),
          ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
        },
      });

      await finalizeAgentStatus(run.agentId, "failed");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  async function resumeQueuedRuns() {
    const queuedRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));

    const agentIds = [...new Set(queuedRuns.map((r) => r.agentId))];
    logger.info({ agentCount: agentIds.length, queuedCount: queuedRuns.length }, "resumeQueuedRuns: found queued runs");
    for (const agentId of agentIds) {
      try {
        const result = await startNextQueuedRunForAgent(agentId);
        logger.info({ agentId, claimedCount: Array.isArray(result) ? result.length : 0 }, "resumeQueuedRuns: startNextQueuedRunForAgent completed");
      } catch {
        logger.error({ agentId }, "resumeQueuedRuns: startNextQueuedRunForAgent threw");
      }
    }
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
    normalizedUsage?: UsageTotals | null,
    preResolvedCost?: { costCents: number; rawUnits: string | null; rawUnitType: string | null; unitPriceId: string | null },
    redactionOptions?: CurrentUserRedactionOptions,
  ) {
    await ensureRuntimeState(agent);
    const usage = normalizedUsage ?? normalizeUsageTotals(result.usage);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const billingType = normalizeLedgerBillingType(result.billingType);
    const provider = result.provider ?? "unknown";
    const biller = resolveLedgerBiller(result);
    const { costCents: additionalCostCents, rawUnits, rawUnitType, unitPriceId } =
      preResolvedCost ?? await resolveAdapterCostCents(db, agent.companyId, result, billingType, biller);
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
    const ledgerScope = await resolveLedgerScopeForRun(db, agent.companyId, run);

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError:
          result.errorMessage == null
            ? null
            : redactStatelessDiagnosticValue(result.errorMessage, redactionOptions),
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      const costs = costService(db, budgetHooks);
      await costs.createEvent(agent.companyId, {
        heartbeatRunId: run.id,
        agentId: agent.id,
        issueId: ledgerScope.issueId,
        projectId: ledgerScope.projectId,
        provider,
        biller,
        billingType,
        model: result.model ?? "unknown",
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costCents: additionalCostCents,
        rawUnits: rawUnits ?? undefined,
        rawUnitType: rawUnitType ?? undefined,
        unitPriceId: unitPriceId ?? undefined,
        occurredAt: new Date(),
      });
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    const plan = await withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return { claimed: [], blocked: [] };
      if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
        return { claimed: [], blocked: [] };
      }
      if (await hasActiveEmulation(agentId)) return { claimed: [], blocked: [] };
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return { claimed: [], blocked: [] };

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt));
      if (queuedRuns.length === 0) return { claimed: [], blocked: [] };

      const claimed: Array<{
        run: typeof heartbeatRuns.$inferSelect;
        coordination: RunExecutionCoordination;
      }> = [];
      const blocked: Array<{ runId: string; reason: string }> = [];
      for (const queuedRun of queuedRuns) {
        if (claimed.length >= availableSlots) break;
        let coordination: RunExecutionCoordination | null = null;
        let disposition: QueueClaimDisposition;
        try {
          disposition = await claimQueuedRun(queuedRun, async () => {
            coordination = await withRunLaunchLock(queuedRun.id, async () => {
              const current = await getRun(queuedRun.id);
              if (current?.status !== "queued") return null;
              return createRunExecutionCoordination(queuedRun.id, queuedRun.agentId);
            });
            return coordination !== null;
          });
        } catch (error) {
          if (coordination) finishRunExecutionCoordination(queuedRun.id, coordination);
          throw error;
        }
        if (disposition.kind === "cancel") {
          blocked.push({ runId: queuedRun.id, reason: disposition.reason });
          continue;
        }
        if (disposition.kind !== "claimed") {
          if (coordination) finishRunExecutionCoordination(queuedRun.id, coordination);
          continue;
        }
        if (!coordination) {
          throw new Error(`Claimed heartbeat run ${queuedRun.id} without launch ownership`);
        }
        claimed.push({ run: disposition.run, coordination });
      }
      return { claimed, blocked };
    });

    for (const claimed of plan.claimed) {
      void executeRun(claimed.run.id, claimed.coordination).catch(() => {
        logger.error({ runId: claimed.run.id }, "queued heartbeat execution failed");
      });
    }
    for (const blocked of plan.blocked) {
      await cancelRunInternal(blocked.runId, blocked.reason);
    }
    return plan.claimed.map(({ run }) => run);
  }

  async function executeRun(
    runId: string,
    executionCoordination: RunExecutionCoordination,
  ) {
    const preparedRun = await withRunLaunchLock(runId, async () => {
        if (runExecutionCoordinationByRunId.get(runId) !== executionCoordination) return null;
        const candidate = await getRun(runId);
        return candidate?.status === "running" ? candidate : null;
      }).catch((error) => {
        finishRunExecutionCoordination(runId, executionCoordination);
        throw error;
      });
    if (!preparedRun) {
      transientExecutionContextsByRunId.delete(runId);
      finishRunExecutionCoordination(runId, executionCoordination);
      return;
    }
    let run = preparedRun;

    activeRunExecutions.add(run.id);
    let setupRedactionOptions: CurrentUserRedactionOptions | null = null;
    let operationalContextForRetry: Record<string, unknown> | undefined;
    const launchHandshakeFailure: {
      run: typeof heartbeatRuns.$inferSelect | null;
      processTerminated: boolean;
    } = { run: null, processTerminated: true };

    try {
    const context = resolveHeartbeatExecutionContext(
      run.contextSnapshot,
      transientExecutionContextsByRunId.take(run.id),
    );
    operationalContextForRetry = context;
    const agent = await getAgent(run.agentId);
    if (!agent) {
      const failedRun = await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      if (!failedRun) return;
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      await releaseIssueExecutionAndPromote(failedRun);
      return;
    }
    const runtime = await ensureRuntimeState(agent);
    const taskKey = deriveTaskKey(context, null);
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);
    const issueContext = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            executionWorkspaceId: issues.executionWorkspaceId,
            executionWorkspacePreference: issues.executionWorkspacePreference,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
            executionWorkspaceSettings: issues.executionWorkspaceSettings,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueAssigneeOverrides =
      issueContext && issueContext.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueContext.assigneeAdapterOverrides,
          )
        : null;
    const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
    const issueExecutionWorkspaceSettings = isolatedWorkspacesEnabled
      ? parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings)
      : null;
    const contextProjectId = readNonEmptyString(context.projectId);
    const executionProjectId = issueContext?.projectId ?? contextProjectId;
    const projectExecutionWorkspacePolicy = executionProjectId
      ? await db
          .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
          .from(projects)
          .where(and(eq(projects.id, executionProjectId), eq(projects.companyId, agent.companyId)))
          .then((rows) =>
            gateProjectExecutionWorkspacePolicy(
              parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy),
              isolatedWorkspacesEnabled,
            ))
      : null;
    const taskSession = taskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, taskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const previousSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null),
    );
    const config = parseObject(agent.adapterConfig);
    const executionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: executionWorkspaceMode !== "agent_default" },
    );
    const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
      agentConfig: config,
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      mode: executionWorkspaceMode,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const mergedConfig = issueAssigneeOverrides?.adapterConfig
      ? { ...workspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
      : workspaceManagedConfig;
    const { config: resolvedConfig, secretKeys } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      mergedConfig,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId);
    const runtimeConfig = {
      ...resolvedConfig,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
    const adapterEnv = Object.fromEntries(
      Object.entries(parseObject(resolvedConfig.env)).filter(
        (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
    const adapter = getServerAdapter(agent.adapterType);
    const authToken = adapter.supportsLocalAgentJwt
      ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
      : null;
    const configuredSecretValues = Array.from(secretKeys)
      .map((key) => adapterEnv[key])
      .filter((value): value is string => typeof value === "string");
    const runRedactionOptions: CurrentUserRedactionOptions = {
      ...(await getCurrentUserRedactionOptions()),
      secretValues: [
        ...collectSensitiveEnvValues(process.env),
        ...collectSensitiveEnvValues(adapterEnv),
        ...configuredSecretValues,
        ...(authToken ? [authToken] : []),
      ],
    };
    setupRedactionOptions = runRedactionOptions;
    const buildPersistedContextSnapshot = () =>
      sanitizeWakeupExecutionInput(
        { contextSnapshot: context },
        runRedactionOptions,
      ).contextSnapshot;
    const issueRef = issueContext
      ? {
          id: issueContext.id,
          identifier: issueContext.identifier,
          title: issueContext.title,
          projectId: issueContext.projectId,
          projectWorkspaceId: issueContext.projectWorkspaceId,
          executionWorkspaceId: issueContext.executionWorkspaceId,
          executionWorkspacePreference: issueContext.executionWorkspacePreference,
        }
      : null;
    const existingExecutionWorkspace =
      issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
    const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
      companyId: agent.companyId,
      heartbeatRunId: run.id,
      executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
      redactionOptions: runRedactionOptions,
    });
    const executionWorkspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: resolvedWorkspace.cwd,
        source: resolvedWorkspace.source,
        projectId: resolvedWorkspace.projectId,
        workspaceId: resolvedWorkspace.workspaceId,
        repoUrl: resolvedWorkspace.repoUrl,
        repoRef: resolvedWorkspace.repoRef,
      },
      config: runtimeConfig,
      issue: issueRef,
      agent: {
        id: agent.id,
        name: agent.name,
        companyId: agent.companyId,
      },
      recorder: workspaceOperationRecorder,
    });
    const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
    const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
    const shouldReuseExisting =
      issueRef?.executionWorkspacePreference === "reuse_existing" &&
      existingExecutionWorkspace &&
      existingExecutionWorkspace.status !== "archived";
    let persistedExecutionWorkspace = null;
    try {
      persistedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
        ? await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: executionWorkspace.branchName,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            status: "active",
            lastUsedAt: new Date(),
            metadata: {
              ...(existingExecutionWorkspace.metadata ?? {}),
              source: executionWorkspace.source,
              createdByRuntime: executionWorkspace.created,
            },
          })
        : resolvedProjectId
          ? await executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                executionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : executionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : executionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
              name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: executionWorkspace.branchName,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: {
                source: executionWorkspace.source,
                createdByRuntime: executionWorkspace.created,
              },
            })
          : null;
    } catch (error) {
      if (executionWorkspace.created) {
        try {
          await cleanupExecutionWorkspaceArtifacts({
            workspace: {
              id: existingExecutionWorkspace?.id ?? `transient-${run.id}`,
              cwd: executionWorkspace.cwd,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              branchName: executionWorkspace.branchName,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              metadata: {
                createdByRuntime: true,
                source: executionWorkspace.source,
              },
            },
            projectWorkspace: {
              cwd: resolvedWorkspace.cwd,
              cleanupCommand: null,
            },
            teardownCommand: projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
            recorder: workspaceOperationRecorder,
            redactionOptions: runRedactionOptions,
          });
        } catch (cleanupError) {
          logger.warn(
            buildExecutionWorkspaceCleanupFailureLog(
              {
                runId: run.id,
                issueId,
                executionWorkspaceCwd: executionWorkspace.cwd,
                cleanupError,
              },
              runRedactionOptions,
            ),
            "Failed to cleanup realized execution workspace after persistence failure",
          );
        }
      }
      throw error;
    }
    await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
    if (
      existingExecutionWorkspace &&
      persistedExecutionWorkspace &&
      existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
      existingExecutionWorkspace.status === "active"
    ) {
      await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
        status: "idle",
        cleanupReason: null,
      });
    }
    if (issueId && persistedExecutionWorkspace && issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
      await issuesSvc.update(issueId, {
        executionWorkspaceId: persistedExecutionWorkspace.id,
        ...(resolvedProjectWorkspaceId ? { projectWorkspaceId: resolvedProjectWorkspaceId } : {}),
      });
    }
    if (persistedExecutionWorkspace) {
      context.executionWorkspaceId = persistedExecutionWorkspace.id;
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: buildPersistedContextSnapshot(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.status, "running"),
          ),
        );
    }
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace: {
        ...resolvedWorkspace,
        cwd: executionWorkspace.cwd,
      },
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...executionWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];
    context.paperclipWorkspace = {
      cwd: executionWorkspace.cwd,
      source: executionWorkspace.source,
      mode: executionWorkspaceMode,
      strategy: executionWorkspace.strategy,
      projectId: executionWorkspace.projectId,
      workspaceId: executionWorkspace.workspaceId,
      repoUrl: executionWorkspace.repoUrl,
      repoRef: executionWorkspace.repoRef,
      branchName: executionWorkspace.branchName,
      worktreePath: executionWorkspace.worktreePath,
      agentHome: await (async () => {
        const home = resolveDefaultAgentWorkspaceDir(agent.id);
        await fs.mkdir(home, { recursive: true });
        return home;
      })(),
      ...(readNonEmptyString(resolvedConfig.instructionsRootPath)
        ? { instructionsRootPath: resolvedConfig.instructionsRootPath }
        : {}),
    };
    context.paperclipWorkspaces = resolvedWorkspace.workspaceHints;
    const runtimeServiceIntents = (() => {
      const runtimeConfig = parseObject(resolvedConfig.workspaceRuntime);
      return Array.isArray(runtimeConfig.services)
        ? runtimeConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();
    if (runtimeServiceIntents.length > 0) {
      context.paperclipRuntimeServiceIntents = runtimeServiceIntents;
    } else {
      delete context.paperclipRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }
    const runtimeSessionFallback =
      taskKey || resetTaskSession ? null : resolveRuntimeSessionFallback(runtime, agent.adapterType);
    let previousSessionDisplayId = truncateDisplayId(
      taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    let runtimeSessionIdForAdapter =
      readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback;
    let runtimeSessionParamsForAdapter = runtimeSessionParams;

    const sessionCompaction = await evaluateSessionCompaction({
      agent,
      sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
      issueId,
    });
    if (sessionCompaction.rotate) {
      context.paperclipSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
      context.paperclipSessionRotationReason = sessionCompaction.reason;
      context.paperclipPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      if (sessionCompaction.reason) {
        runtimeWorkspaceWarnings.push(
          `Starting a fresh session because ${sessionCompaction.reason}.`,
        );
      }
    } else {
      delete context.paperclipSessionHandoffMarkdown;
      delete context.paperclipSessionRotationReason;
      delete context.paperclipPreviousSessionId;
    }

    // Build last-run summary if previous run for this agent failed
    // This gives the agent visibility into what happened before it died
    const lastRunSummary = await buildLastRunSummary(agent.id, run.id);
    if (lastRunSummary) {
      context.paperclipLastRunSummary = lastRunSummary;
    }

    const runtimeForAdapter = {
      sessionId: runtimeSessionIdForAdapter,
      sessionParams: runtimeSessionParamsForAdapter,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    let seq = 1;
    let handle: RunLogHandle | null = null;
    let stdoutExcerpt = "";
    let stderrExcerpt = "";
    let flushRunLogRedactors = async () => {};
    let closeAndDrainRunLog = async () => {
      await flushRunLogRedactors();
    };
    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          contextSnapshot: buildPersistedContextSnapshot(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!runningWithSession) return;
      run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      handle = await runLogStore.begin({
        companyId: run.companyId,
        agentId: run.agentId,
        runId,
      });
      sanitizedLogCache.invalidate(sanitizedRunLogSource(handle));

      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.status, "running"),
          ),
        );

      const streamRedactor = new OrderedStreamingTextRedactor<"stdout" | "stderr">(
        runRedactionOptions,
      );
      const runLogGate = createAsyncLogGate();
      const appendSanitizedLog = async (stream: "stdout" | "stderr", sanitizedChunk: string) => {
        if (!sanitizedChunk) return;
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
        // Update the watchdog activity signal on meaningful stream events
        // before any DB/log work — see `run-activity-registry.ts` for the
        // definition of "meaningful". Stderr is intentionally ignored so that
        // recurring noise (e.g. codex_models_manager refresh errors) cannot
        // keep a dead adapter alive.
        if (stream === "stdout") {
          const meaningful = chunkHasMeaningfulActivity(stream, sanitizedChunk);
          if (meaningful.meaningful) {
            runActivityRegistry.record(run.id, "stream");
          }
        }
        const ts = new Date().toISOString();

        if (handle) {
          await appendRunLog(handle, {
            stream,
            chunk: sanitizedChunk,
            ts,
          });
        }

        const payloadChunk =
          sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : sanitizedChunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            ts,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== sanitizedChunk.length,
          },
        });
      };
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        await runLogGate.run(async () => {
          for (const redacted of streamRedactor.push(stream, chunk)) {
            await appendSanitizedLog(redacted.stream, redacted.chunk);
          }
        });
      };
      flushRunLogRedactors = async () => {
        for (const redacted of streamRedactor.flush()) {
          await appendSanitizedLog(redacted.stream, redacted.chunk);
        }
      };
      closeAndDrainRunLog = async () => {
        let drainError: unknown = null;
        try {
          await runLogGate.closeAndDrain();
        } catch (error) {
          drainError = error;
        }
        await flushRunLogRedactors();
        if (drainError) throw drainError;
      };
      for (const warning of runtimeWorkspaceWarnings) {
        const logEntry = formatRuntimeWorkspaceWarningLog(warning);
        await onLog(logEntry.stream, logEntry.chunk);
      }
      const runtimeServices = await ensureRuntimeServicesForRun({
        db,
        runId: run.id,
        agent: {
          id: agent.id,
          name: agent.name,
          companyId: agent.companyId,
        },
        issue: issueRef,
        workspace: executionWorkspace,
        executionWorkspaceId: persistedExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
        config: resolvedConfig,
        adapterEnv,
        resolvedSecretValues: configuredSecretValues,
        onLog,
      });
      if (runtimeServices.length > 0) {
        context.paperclipRuntimeServices = runtimeServices;
        context.paperclipRuntimePrimaryUrl =
          runtimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: buildPersistedContextSnapshot(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.status, "running"),
            ),
          );
      }
      if (issueId && (executionWorkspace.created || runtimeServices.some((service) => !service.reused))) {
        try {
          await issuesSvc.addComment(
            issueId,
            buildWorkspaceReadyComment({
              workspace: executionWorkspace,
              runtimeServices,
            }),
            { agentId: agent.id },
          );
        } catch (err) {
          await onLog(
            "stderr",
            `[paperclip] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        const invokableRun = await getRun(run.id);
        if (invokableRun?.status !== "running") {
          throw new Error("Heartbeat run is no longer active before adapter invocation");
        }
        const sanitizedMeta = buildAdapterInvocationEventPayload(
          meta,
          secretKeys,
          runRedactionOptions,
        );
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: sanitizedMeta as unknown as Record<string, unknown>,
        });
      };

      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            adapterType: agent.adapterType,
          },
          "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
        );
      }
      const adapterExecution: { current: Promise<AdapterExecutionResult> | null } = {
        current: null,
      };
      const invocationStarted = await withRunLaunchLock(run.id, async () => {
        const invokableRun = await getRun(run.id);
        if (invokableRun?.status !== "running") {
          executionCoordination.phase = "settled";
          executionCoordination.resolveLaunchBoundary();
          return false;
        }

        executionCoordination.phase = "launching";
        const onAdapterSpawn = async (meta: { pid: number; startedAt: string }) => {
          try {
            const persisted = await persistRunProcessMetadata(run.id, meta);
            if (!persisted) {
              await terminateRegisteredRunProcess(run.id);
              throw new Error("Heartbeat run was cancelled while its adapter was launching");
            }
          } finally {
            if (executionCoordination.phase === "launching") {
              executionCoordination.phase = "spawned";
            }
            executionCoordination.resolveLaunchBoundary();
          }
        };

        try {
          adapterExecution.current = Promise.resolve(
            adapter.execute({
              runId: run.id,
              agent,
              runtime: runtimeForAdapter,
              config: runtimeConfig,
              context,
              onLog,
              onMeta: onAdapterMeta,
              onSpawn: onAdapterSpawn,
              authToken: authToken ?? undefined,
            }),
          );
        } catch (error) {
          adapterExecution.current = Promise.reject(error);
        }
        void adapterExecution.current.then(
          () => {
            if (executionCoordination.phase === "launching") {
              executionCoordination.phase = "settled";
            }
            executionCoordination.resolveLaunchBoundary();
          },
          () => {
            if (executionCoordination.phase === "launching") {
              executionCoordination.phase = "settled";
            }
            executionCoordination.resolveLaunchBoundary();
          },
        );
        const launchBoundaryReached = await waitForPromiseWithTimeout(
          executionCoordination.launchBoundary,
          RUN_LAUNCH_HANDSHAKE_MAX_MS,
        );
        if (!launchBoundaryReached) {
          executionCoordination.cancellationWon = true;
          launchHandshakeFailure.run = await setRunStatus(run.id, "failed", {
            finishedAt: new Date(),
            error: "Adapter launch handshake timed out",
            errorCode: "timeout",
          });
          if (launchHandshakeFailure.run) {
            await setWakeupStatus(run.wakeupRequestId, "failed", {
              finishedAt: new Date(),
              error: "Adapter launch handshake timed out",
            });
          }
          launchHandshakeFailure.processTerminated = await terminateRegisteredRunProcess(run.id);
          executionCoordination.terminationProven =
            launchHandshakeFailure.processTerminated;
          if (!launchHandshakeFailure.processTerminated && launchHandshakeFailure.run) {
            launchHandshakeFailure.run = await db
              .update(heartbeatRuns)
              .set({
                errorCode: PROCESS_TERMINATION_PENDING_ERROR_CODE,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(heartbeatRuns.id, launchHandshakeFailure.run.id),
                  eq(heartbeatRuns.status, "failed"),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? launchHandshakeFailure.run);
          }
          // Keep launch ownership until the adapter settles. A late local spawn
          // must run through onAdapterSpawn, observe the terminal DB state, and
          // be killed before cancelled/queued work may be promoted.
          await adapterExecution.current.catch(() => undefined);
          return false;
        }
        return true;
      });
      if (!invocationStarted || !adapterExecution.current) return;
      const rawAdapterResult = await adapterExecution.current;
      const lingeringProcess = runningProcesses.get(run.id);
      if (lingeringProcess && !(await terminateRegisteredRunProcess(run.id))) {
        throw new LocalAdapterProcessTerminationError(lingeringProcess.child.pid ?? null);
      }
      const {
        operational: operationalAdapterResult,
        credentialSafe: credentialSafeAdapterResult,
        persisted: adapterResult,
      } = prepareAdapterResultViews(
        rawAdapterResult,
        runRedactionOptions,
      );
      const adapterManagedRuntimeServices = credentialSafeAdapterResult.runtimeServices
        ? await persistAdapterManagedRuntimeServices({
            db,
            adapterType: agent.adapterType,
            runId: run.id,
            agent: {
              id: agent.id,
              name: agent.name,
              companyId: agent.companyId,
            },
            issue: issueRef,
            workspace: executionWorkspace,
            reports: credentialSafeAdapterResult.runtimeServices,
          })
        : [];
      if (adapterManagedRuntimeServices.length > 0) {
        const combinedRuntimeServices = [
          ...runtimeServices,
          ...adapterManagedRuntimeServices,
        ];
        context.paperclipRuntimeServices = combinedRuntimeServices;
        context.paperclipRuntimePrimaryUrl =
          combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: buildPersistedContextSnapshot(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.status, "running"),
            ),
          );
        if (issueId) {
          try {
            await issuesSvc.addComment(
              issueId,
              buildWorkspaceReadyComment({
                workspace: executionWorkspace,
                runtimeServices: adapterManagedRuntimeServices,
              }),
              { agentId: agent.id },
            );
          } catch (err) {
            const runtimeCommentError = redactThrownDiagnosticError(err, runRedactionOptions, {
              fallbackMessage: "Adapter-managed runtime comment failed",
            });
            await onLog(
              "stderr",
              `[paperclip] Failed to post adapter-managed runtime comment: ${runtimeCommentError.message}\n`,
            );
          }
        }
      }
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult: operationalAdapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });
      const nextSessionStateForPersistence = redactDiagnosticResponseValue(
        { payload: nextSessionState },
        { ...runRedactionOptions, enabled: false },
      ).payload;
      const rawUsage = normalizeUsageTotals(operationalAdapterResult.usage);
      const sessionUsageResolution = await resolveNormalizedUsageForSession({
        agentId: agent.id,
        runId: run.id,
        sessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        rawUsage,
      });
      const normalizedUsage = sessionUsageResolution.normalizedUsage;

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (operationalAdapterResult.timedOut) {
        outcome = "timed_out";
      } else if (
        (operationalAdapterResult.exitCode ?? 0) === 0 &&
        !operationalAdapterResult.errorMessage
      ) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      await closeAndDrainRunLog();
      if (handle) {
        logSummary = await finalizeRunLog(handle);
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";

      // Resolve credit→USD conversion once so both usageJson and updateRuntimeState use the same value.
      const _billingTypeForUsage = normalizeLedgerBillingType(
        operationalAdapterResult.billingType,
      );
      const _billerForUsage = resolveLedgerBiller(operationalAdapterResult);
      const _resolvedCost = await resolveAdapterCostCents(
        db,
        agent.companyId,
        operationalAdapterResult,
        _billingTypeForUsage,
        _billerForUsage,
      );
      const _costUsdForUsage = _resolvedCost.costCents > 0 ? _resolvedCost.costCents / 100 : null;

      const usageJson = buildHeartbeatUsageJson({
        normalizedUsage,
        rawUsage,
        derivedFromSessionTotals: sessionUsageResolution.derivedFromSessionTotals,
        persistedSessionId:
          nextSessionStateForPersistence.displayId ??
          nextSessionStateForPersistence.legacySessionId,
        sessionReused: runtimeForAdapter.sessionId != null || runtimeForAdapter.sessionDisplayId != null,
        taskSessionReused: taskSessionForRun != null,
        freshSession: runtimeForAdapter.sessionId == null && runtimeForAdapter.sessionDisplayId == null,
        sessionRotated: sessionCompaction.rotate,
        sessionRotationReason: sessionCompaction.reason,
        adapterResult: credentialSafeAdapterResult,
        costUsdForUsage: _costUsdForUsage,
        resolvedCost: _resolvedCost,
      });

      const finalizedRun = await setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : redactCurrentUserText(
                adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
                runRedactionOptions,
              ),
        errorCode:
          outcome === "timed_out"
            ? "timeout"
            : outcome === "cancelled"
              ? "cancelled"
              : outcome === "failed"
                ? (adapterResult.errorCode ?? "adapter_failed")
                : null,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: adapterResult.resultJson ?? null,
        sessionIdAfter:
          nextSessionStateForPersistence.displayId ??
          nextSessionStateForPersistence.legacySessionId,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      if (!finalizedRun) return;

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: new Date(),
        error: adapterResult.errorMessage ?? null,
      });

      if (finalizedRun) {
        await appendRunEvent(finalizedRun, seq++, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: {
            status,
            exitCode: adapterResult.exitCode,
          },
        });

      }

      if (finalizedRun) {
        await updateRuntimeState(agent, finalizedRun, credentialSafeAdapterResult, {
          legacySessionId: nextSessionStateForPersistence.legacySessionId,
        }, normalizedUsage, _resolvedCost, runRedactionOptions);
        if (taskKey) {
          if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
            await clearTaskSessions(agent.companyId, agent.id, {
              taskKey,
              adapterType: agent.adapterType,
            });
          } else {
            // Process batch queue signal if present
            let sessionParamsToStore = nextSessionState.params;
            if (nextSessionState.params && outcome === "succeeded") {
              const batchSignal = await processBatchQueueSignal({
                companyId: agent.companyId,
                agentId: agent.id,
                adapterType: agent.adapterType,
                taskKey,
                runId: finalizedRun.id,
                sessionParams: nextSessionState.params,
                redactionOptions: runRedactionOptions,
              });
              if (batchSignal) {
                sessionParamsToStore = batchSignal.transformedParams;
              }
            }

            await upsertTaskSession({
              companyId: agent.companyId,
              agentId: agent.id,
              adapterType: agent.adapterType,
              taskKey,
              sessionParamsJson: redactDiagnosticResponseValue(
                { payload: sessionParamsToStore },
                { ...runRedactionOptions, enabled: false },
              ).payload,
              sessionDisplayId: nextSessionStateForPersistence.displayId,
              lastRunId: finalizedRun.id,
              lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
            });
          }
        }
      }
      await finalizeAgentStatus(agent.id, outcome);

      // Update instance-level adapter status based on run outcome.
      // Only record successes and failures — cancelled/timed_out are not
      // indicative of adapter health and must not pollute the status table.
      if (outcome === "succeeded" || outcome === "failed") {
        await adapterStatusSvc.recordRunOutcome({
          adapterType: agent.adapterType,
          succeeded: outcome === "succeeded",
          errorMessage: adapterResult.errorMessage,
          errorCode: outcome === "failed" ? (adapterResult.errorCode ?? "adapter_failed") : null,
        }).catch((error) =>
          logger.warn(
            {
              err: redactThrownDiagnosticError(error, runRedactionOptions, {
                fallbackMessage: "Adapter status update failed",
              }),
              runId,
            },
            "failed to update adapter status",
          ),
        );
      }

      // Finish all state derived from this run before making any retry claimable.
      // Otherwise a fast retry can succeed and then be overwritten by this older
      // run's runtime/session/status finalizers.
      const resolvedErrorCode =
        outcome === "failed"
          ? (operationalAdapterResult.errorCode ?? "adapter_failed")
          : null;
      let retried = false;
      if (resolvedErrorCode && RETRY_POLICY[resolvedErrorCode]) {
        const retriedRun = await enqueueRetry(
          finalizedRun,
          agent,
          resolvedErrorCode,
          new Date(),
          {
            operationalContextSnapshot: context,
            redactionOptions: runRedactionOptions,
          },
        ).catch(() => null);
        retried = !!retriedRun;
      }
      if (!retried) {
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

    } catch (err) {
      try {
        await closeAndDrainRunLog();
      } catch (flushErr) {
        logger.warn(
          {
            err: redactThrownDiagnosticError(flushErr, runRedactionOptions, {
              fallbackMessage: "Run log flush failed",
            }),
            runId,
          },
          "failed to flush redacted run log after error",
        );
      }
      const processTerminationPending = isLocalAdapterProcessTerminationError(err);
      if (processTerminationPending) {
        executionCoordination.cancellationWon = true;
        executionCoordination.terminationProven = false;
      }
      const executionError = processTerminationPending
        ? new Error(PROCESS_TERMINATION_PENDING_ERROR_MESSAGE)
        : redactThrownDiagnosticError(err, runRedactionOptions, {
            fallbackMessage: "Unknown adapter failure",
          });
      const message = executionError.message;
      logger.error({ err: executionError, runId }, "heartbeat execution failed");

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await finalizeRunLog(handle);
        } catch (finalizeErr) {
          logger.warn(
            {
              err: redactThrownDiagnosticError(finalizeErr, runRedactionOptions, {
                fallbackMessage: "Run log finalization failed",
              }),
              runId,
            },
            "failed to finalize run log after error",
          );
        }
      }

      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode: processTerminationPending
          ? PROCESS_TERMINATION_PENDING_ERROR_CODE
          : "adapter_failed",
        finishedAt: new Date(),
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      if (!failedRun) return;
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: message,
      });

      if (failedRun) {
        await appendRunEvent(failedRun, seq++, {
          eventType: "error",
          stream: "system",
          level: "error",
          message,
        });

        await updateRuntimeState(agent, failedRun, {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        }, {
          legacySessionId: runtimeForAdapter.sessionId,
        }, undefined, undefined, runRedactionOptions);

        if (taskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
          const failedSessionForPersistence = redactDiagnosticResponseValue(
            {
              payload: {
                sessionParamsJson: previousSessionParams,
                sessionDisplayId: previousSessionDisplayId,
                lastError: message,
              },
            },
            { ...runRedactionOptions, enabled: false },
          ).payload;
          const persistedPreviousSessionParams = parseObject(
            failedSessionForPersistence.sessionParamsJson,
          );
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey,
            sessionParamsJson:
              Object.keys(persistedPreviousSessionParams).length > 0
                ? persistedPreviousSessionParams
                : null,
            sessionDisplayId:
              readNonEmptyString(failedSessionForPersistence.sessionDisplayId) ?? null,
            lastRunId: failedRun.id,
            lastError:
              readNonEmptyString(failedSessionForPersistence.lastError) ?? "run_failed",
          });
        }
      }

      await finalizeAgentStatus(agent.id, "failed");

      if (!processTerminationPending) {
        // Update instance-level adapter status — caught adapter error
        await adapterStatusSvc.recordRunOutcome({
          adapterType: agent.adapterType,
          succeeded: false,
          errorMessage: message,
          errorCode: "adapter_failed",
        }).catch((error) =>
          logger.warn(
            {
              err: redactThrownDiagnosticError(error, runRedactionOptions, {
                fallbackMessage: "Adapter status update failed",
              }),
              runId,
            },
            "failed to update adapter status",
          ),
        );
      }

      // Do not expose the retry until the failed run's runtime, task-session,
      // agent, and adapter-status finalizers have all completed. A retry can be
      // claimed immediately after insertion.
      if (!processTerminationPending) {
        const retried = await enqueueRetry(
          failedRun,
          agent,
          "adapter_failed",
          new Date(),
          {
            operationalContextSnapshot: context,
            redactionOptions: runRedactionOptions,
          },
        ).catch(() => null);
        if (!retried) {
          await releaseIssueExecutionAndPromote(failedRun);
        }
      }

    }
    } catch (outerErr) {
          // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
          // The inner catch did not fire, so we must record the failure here.
          const effectiveSetupRedactionOptions = setupRedactionOptions ?? {
            ...(await getCurrentUserRedactionOptions()),
            secretValues: collectSensitiveEnvValues(process.env),
          };
          const setupError = redactThrownDiagnosticError(
            outerErr,
            effectiveSetupRedactionOptions,
            { fallbackMessage: "Unknown setup failure" },
          );
          const message = setupError.message;
          logger.error({ err: setupError, runId }, "heartbeat execution setup failed");
          const failedRun = await setRunStatus(runId, "failed", {
            error: message,
            errorCode: "adapter_failed",
            finishedAt: new Date(),
          }).catch(() => null);
          if (!failedRun) return;
          await setWakeupStatus(run.wakeupRequestId, "failed", {
            finishedAt: new Date(),
            error: message,
          }).catch(() => undefined);
          if (failedRun) {
            // Emit a run-log event so the failure is visible in the run timeline,
            // consistent with what the inner catch block does for adapter failures.
            await appendRunEvent(failedRun, 1, {
              eventType: "error",
              stream: "system",
              level: "error",
              message,
            }).catch(() => undefined);

          }
          // Ensure the agent is not left stuck in "running" if the inner catch handler's
          // DB calls threw (e.g. a transient DB error in finalizeAgentStatus).
          await finalizeAgentStatus(run.agentId, "failed").catch(() => undefined);

            // Update instance-level adapter status — setup error.
            // Use "setup_failed" (not "adapter_failed") so that pre-adapter failures
            // (workspace resolution, ensureRuntimeState, etc.) do NOT increment
            // consecutive adapter failures or push the adapter to degraded/offline.
            const agentForAdapterStatus = await getAgent(run.agentId).catch(() => null);
            if (agentForAdapterStatus) {
              await adapterStatusSvc.recordRunOutcome({
                adapterType: agentForAdapterStatus.adapterType,
                succeeded: false,
                errorMessage: message,
                errorCode: "setup_failed",
              }).catch((error) =>
                logger.warn(
                  {
                    err: redactThrownDiagnosticError(error, effectiveSetupRedactionOptions, {
                      fallbackMessage: "Adapter status setup update failed",
                    }),
                    runId,
                  },
                  "failed to update adapter status (setup)",
                ),
              );
            }

            // Setup retries are visible to another worker as soon as their
            // insertion commits, so publish them only after this run's own
            // agent and adapter-status finalizers are complete.
            const agentForRetry = await getAgent(run.agentId).catch(() => null);
            const retried = agentForRetry
              ? await enqueueRetry(
                  failedRun,
                  agentForRetry,
                  "adapter_failed",
                  new Date(),
                  {
                    operationalContextSnapshot: operationalContextForRetry,
                    redactionOptions: effectiveSetupRedactionOptions,
                  },
                ).catch(() => null)
              : null;
            if (!retried) {
              await releaseIssueExecutionAndPromote(failedRun).catch(() => undefined);
            }

        } finally {
          try {
            await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
            activeRunExecutions.delete(run.id);
            const launchHandshakeFailureRun = launchHandshakeFailure.run;
            if (launchHandshakeFailureRun && launchHandshakeFailure.processTerminated) {
              await appendRunEvent(
                launchHandshakeFailureRun,
                await nextRunEventSeq(launchHandshakeFailureRun.id),
                {
                  eventType: "lifecycle",
                  stream: "system",
                  level: "error",
                  message: "Adapter launch handshake timed out",
                },
              ).catch(() => undefined);
              await releaseIssueExecutionAndPromote(launchHandshakeFailureRun).catch(
                () => undefined,
              );
              await finalizeAgentStatus(run.agentId, "failed").catch(() => undefined);
            }
            if (
              !executionCoordination.cancellationWon ||
              (launchHandshakeFailureRun !== null &&
                launchHandshakeFailure.processTerminated)
            ) {
              await startNextQueuedRunForAgent(run.agentId);
            }
          } finally {
            activeRunExecutions.delete(run.id);
            finishRunExecutionCoordination(run.id, executionCoordination);
          }
        }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    const promotionRedactionOptions = await getCurrentUserRedactionOptions();
    let promotionContextReservation: ReturnType<typeof stageTransientExecutionContext> | null =
      null;
    const invalidDeferredWakeupIds: string[] = [];
    const promoted = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, issue.companyId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) return null;

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        const deferredAgentEmulation = deferredAgent
          ? await tx
              .select({ id: agentEmulationSessions.id })
              .from(agentEmulationSessions)
              .where(
                and(
                  eq(agentEmulationSessions.agentId, deferredAgent.id),
                  isNull(agentEmulationSessions.endedAt),
                  gt(agentEmulationSessions.expiresAt, new Date()),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgentEmulation ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          const failedDeferred = await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(agentWakeupRequests.id, deferred.id),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                isNull(agentWakeupRequests.runId),
              ),
            )
            .returning({ id: agentWakeupRequests.id })
            .then((rows) => rows[0] ?? null);
          if (failedDeferred) invalidDeferredWakeupIds.push(failedDeferred.id);
          continue;
        }

        const now = new Date();
        const claimedDeferred = await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            updatedAt: now,
          })
          .where(
            and(
              eq(agentWakeupRequests.id, deferred.id),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              isNull(agentWakeupRequests.runId),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!claimedDeferred) continue;

        const deferredPayload = parseObject(claimedDeferred.payload);
        const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
        const promotedContextSeed: Record<string, unknown> = {
          ...(transientExecutionContextsByRunId.get(
            deferredWakeTransientContextKey(claimedDeferred.id),
          ) ?? deferredContextSeed),
        };
        const promotedReason =
          readNonEmptyString(claimedDeferred.reason) ?? "issue_execution_promoted";
        const promotedSource =
          (readNonEmptyString(claimedDeferred.source) as WakeupOptions["source"]) ??
          "automation";
        const promotedTriggerDetail =
          (readNonEmptyString(
            claimedDeferred.triggerDetail,
          ) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = deferredPayload;
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedOperationalContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: promotedContextSeed,
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });
        const promotedViews = prepareWakeupExecutionViews(
          {
            contextSnapshot: promotedOperationalContextSnapshot,
            reason: promotedReason,
            source: promotedSource,
            triggerDetail: promotedTriggerDetail,
            payload: promotedPayload,
          },
          promotionRedactionOptions,
        );

        const sessionBefore = await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey);
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: deferredAgent.companyId,
            agentId: deferredAgent.id,
            invocationSource: promotedSource,
            triggerDetail: promotedViews.persisted.triggerDetail,
            status: "queued",
            wakeupRequestId: claimedDeferred.id,
            contextSnapshot: promotedViews.persisted.contextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            triggerDetail: promotedViews.persisted.triggerDetail,
            payload: promotedViews.persisted.payload,
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentWakeupRequests.id, claimedDeferred.id),
              eq(agentWakeupRequests.status, "queued"),
              isNull(agentWakeupRequests.runId),
            ),
          );

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        promotionContextReservation = stageTransientExecutionContext(
          newRun.id,
          promotedOperationalContextSnapshot,
        );
        return {
          run: newRun,
          deferredWakeupRequestId: claimedDeferred.id,
          operationalContextSnapshot: promotedOperationalContextSnapshot,
        };
      }
    }).then(
      (result) => {
        promotionContextReservation?.commit();
        return result;
      },
      (error) => {
        promotionContextReservation?.rollback();
        throw error;
      },
    );

    for (const wakeupRequestId of invalidDeferredWakeupIds) {
      transientExecutionContextsByRunId.delete(
        deferredWakeTransientContextKey(wakeupRequestId),
      );
    }
    if (!promoted) return;
    transientExecutionContextsByRunId.delete(
      deferredWakeTransientContextKey(promoted.deferredWakeupRequestId),
    );
    const promotedRun = promoted.run;

    publishLiveEvent({
      companyId: promotedRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const rawTriggerDetail = opts.triggerDetail ?? null;
    const rawIdempotencyKey = opts.idempotencyKey ?? null;
    if (
      rawIdempotencyKey !== null &&
      (typeof rawIdempotencyKey !== "string" ||
        Buffer.byteLength(rawIdempotencyKey, "utf8") > HEARTBEAT_IDEMPOTENCY_KEY_MAX_BYTES)
    ) {
      throw badRequest(
        `Idempotency key must be at most ${HEARTBEAT_IDEMPOTENCY_KEY_MAX_BYTES} bytes`,
      );
    }
    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");

    const wakeupRedactionOptions = await getCurrentUserRedactionOptions();
    const redactWakeupFields = <T extends Record<string, unknown>>(value: T): T =>
      sanitizeWakeupExecutionInput(value, wakeupRedactionOptions);
    const wakeupViews = prepareWakeupExecutionViews({
      reason: opts.reason ?? null,
      payload: opts.payload ?? null,
      contextSnapshot: { ...(opts.contextSnapshot ?? {}) },
      source,
      triggerDetail: rawTriggerDetail,
      idempotencyKey: rawIdempotencyKey,
    }, wakeupRedactionOptions);
    const contextSnapshot = wakeupViews.persisted.contextSnapshot;
    const reason = wakeupViews.persisted.reason;
    const payload = wakeupViews.persisted.payload;
    const triggerDetail = wakeupViews.persisted.triggerDetail;
    const idempotencyKey = wakeupViews.persisted.idempotencyKey ?? null;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = wakeupViews.operational;
    const issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const writeSkippedRequest = async (skipReason: string) => {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: skipReason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey,
        finishedAt: new Date(),
      });
    };

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      projectId = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.projectId ?? null);
    }
    if (!projectId) {
      const runtimeConfig = parseObject(agent.runtimeConfig);
      const heartbeat = parseObject(runtimeConfig.heartbeat);
      projectId = readNonEmptyString(heartbeat.defaultProjectId) ?? null;
      if (projectId) {
        enrichedContextSnapshot.projectId = projectId;
      }
    }

    const budgetBlock = await budgets.getInvocationBlock(agent.companyId, agentId, {
      issueId,
      projectId,
    });
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked");
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    if (await hasActiveEmulation(agentId)) {
      await writeSkippedRequest("agent.under_emulation");
      throw conflict("Agent is currently under external emulation", {
        status: "under_emulation",
      });
    }

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);
      const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

      let issueContextReservation: ReturnType<typeof stageTransientExecutionContext> | null =
        null;
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            assigneeAgentId: issues.assigneeAgentId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          // Only promote a legacy run if it belongs to the current assignee
          // AND is not stale. Non-assignee mention wakes can leave runs with
          // issueId in their contextSnapshot; stamping those as execution owners
          // causes routing oscillation (TIZA-753). Stale same-assignee runs
          // from crashed processes also create ghost locks (TIZA-757).
          const LEGACY_RUN_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
          const isStaleRun =
            legacyRun?.createdAt &&
            Date.now() - new Date(legacyRun.createdAt).getTime() > LEGACY_RUN_MAX_AGE_MS;
          if (legacyRun && legacyRun.agentId === issue.assigneeAgentId && !isStaleRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake) {
            let targetRun = activeExecutionRun;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              const targetUpdatedAt = new Date(targetRun.updatedAt);
              const targetUpdatedAtNextMillisecond = new Date(
                targetUpdatedAt.getTime() + 1,
              );
              const nextUpdatedAt = new Date(
                Math.max(Date.now(), targetUpdatedAtNextMillisecond.getTime()),
              );
              const operationalContextSnapshot = mergeCoalescedContextSnapshot(
                transientExecutionContextsByRunId.get(targetRun.id) ??
                  targetRun.contextSnapshot,
                enrichedContextSnapshot,
              );
              const mergedContextSnapshot = redactWakeupFields({
                contextSnapshot: operationalContextSnapshot,
              }).contextSnapshot;
              const mergedRun = await tx
                .update(heartbeatRuns)
                .set({
                  contextSnapshot: mergedContextSnapshot,
                  updatedAt: nextUpdatedAt,
                })
                .where(
                  and(
                    eq(heartbeatRuns.id, targetRun.id),
                    eq(heartbeatRuns.status, targetRun.status),
                    gte(heartbeatRuns.updatedAt, targetUpdatedAt),
                    lt(heartbeatRuns.updatedAt, targetUpdatedAtNextMillisecond),
                  ),
                )
                .returning()
                .then((rows) => rows[0] ?? null);

              if (mergedRun) {
                await tx.insert(agentWakeupRequests).values({
                  companyId: agent.companyId,
                  agentId,
                  source,
                  triggerDetail,
                  reason: "issue_execution_same_name",
                  payload,
                  status: "coalesced",
                  coalescedCount: 1,
                  requestedByActorType: opts.requestedByActorType ?? null,
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey,
                  runId: mergedRun.id,
                  finishedAt: new Date(),
                });

                if (mergedRun.status === "queued") {
                  issueContextReservation = stageTransientExecutionContext(
                    mergedRun.id,
                    operationalContextSnapshot,
                  );
                }

                return {
                  kind: "coalesced" as const,
                  run: mergedRun,
                  operationalContextSnapshot,
                };
              }

              const currentRun = await tx
                .select()
                .from(heartbeatRuns)
                .where(eq(heartbeatRuns.id, targetRun.id))
                .then((rows) => rows[0] ?? null);
              if (currentRun?.status === "cancelled") {
                return { kind: "skipped" as const };
              }
              if (
                attempt === 0 &&
                currentRun?.status === targetRun.status &&
                isSameTaskScope(runTaskKey(currentRun), taskKey)
              ) {
                targetRun = currentRun;
                continue;
              }
              // A selected queued run became operational. Fall through to a
              // deferred follow-up so its raw input reaches a future adapter.
              break;
            }
          }

          const deferredPayload = redactWakeupFields({
            payload: {
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
            },
          }).payload;

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              transientExecutionContextsByRunId.get(
                deferredWakeTransientContextKey(existingDeferred.id),
              ) ?? existingDeferredContext,
              enrichedContextSnapshot,
            );
            const mergedDeferredPayload = redactWakeupFields({
              payload: {
                ...existingDeferredPayload,
                ...(payload ?? {}),
                issueId,
                [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
              },
            }).payload;

            const updatedDeferred = await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(agentWakeupRequests.id, existingDeferred.id),
                  eq(agentWakeupRequests.status, "deferred_issue_execution"),
                  isNull(agentWakeupRequests.runId),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);

            if (updatedDeferred) {
              issueContextReservation = stageTransientExecutionContext(
                deferredWakeTransientContextKey(updatedDeferred.id),
                mergedDeferredContext,
              );

              return {
                kind: "deferred" as const,
                wakeupRequestId: updatedDeferred.id,
                operationalContextSnapshot: mergedDeferredContext,
              };
            }

            const currentDeferred = await tx
              .select({
                status: agentWakeupRequests.status,
                runId: agentWakeupRequests.runId,
              })
              .from(agentWakeupRequests)
              .where(eq(agentWakeupRequests.id, existingDeferred.id))
              .then((rows) => rows[0] ?? null);
            if (
              !currentDeferred ||
              currentDeferred.status === "cancelled" ||
              currentDeferred.status === "failed" ||
              currentDeferred.status === "skipped"
            ) {
              return { kind: "skipped" as const };
            }
            // Promotion won the deferred-row CAS. Create a fresh deferred
            // follow-up below so the incoming operational context is retained.
          }

          const deferredWakeup = await tx
            .insert(agentWakeupRequests)
            .values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_deferred",
              payload: deferredPayload,
              status: "deferred_issue_execution",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey,
            })
            .returning()
            .then((rows) => rows[0]);

          issueContextReservation = stageTransientExecutionContext(
            deferredWakeTransientContextKey(deferredWakeup.id),
            enrichedContextSnapshot,
          );

          return {
            kind: "deferred" as const,
            wakeupRequestId: deferredWakeup.id,
            operationalContextSnapshot: enrichedContextSnapshot,
          };
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason,
            payload,
            status: "queued",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey,
          })
          .returning()
          .then((rows) => rows[0]);

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: redactWakeupFields({ contextSnapshot: enrichedContextSnapshot })
              .contextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: newRun.id,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: agentNameKey,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));

        issueContextReservation = stageTransientExecutionContext(
          newRun.id,
          enrichedContextSnapshot,
        );

        return {
          kind: "queued" as const,
          run: newRun,
          operationalContextSnapshot: enrichedContextSnapshot,
        };
      }).then(
        (result) => {
          issueContextReservation?.commit();
          return result;
        },
        (error) => {
          issueContextReservation?.rollback();
          throw error;
        },
      );

      if (outcome.kind === "deferred") {
        return null;
      }
      if (outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") {
        return outcome.run;
      }

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      let targetRun = coalescedTargetRun;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const targetUpdatedAt = new Date(targetRun.updatedAt);
        const targetUpdatedAtNextMillisecond = new Date(targetUpdatedAt.getTime() + 1);
        const nextUpdatedAt = new Date(
          Math.max(Date.now(), targetUpdatedAtNextMillisecond.getTime()),
        );
        const operationalContextSnapshot = mergeCoalescedContextSnapshot(
          transientExecutionContextsByRunId.get(targetRun.id) ??
            targetRun.contextSnapshot,
          enrichedContextSnapshot,
        );
        const mergedContextSnapshot = redactWakeupFields({
          contextSnapshot: operationalContextSnapshot,
        }).contextSnapshot;
        const contextReservation: {
          current: ReturnType<typeof stageTransientExecutionContext> | null;
        } = { current: null };
        let mergedRun: typeof heartbeatRuns.$inferSelect | null;
        try {
          mergedRun = await db.transaction(async (tx) => {
            const updatedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: nextUpdatedAt,
              })
              .where(
                and(
                  eq(heartbeatRuns.id, targetRun.id),
                  eq(heartbeatRuns.status, targetRun.status),
                  gte(heartbeatRuns.updatedAt, targetUpdatedAt),
                  lt(heartbeatRuns.updatedAt, targetUpdatedAtNextMillisecond),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);
            if (!updatedRun) return null;

            if (updatedRun.status === "queued") {
              contextReservation.current = stageTransientExecutionContext(
                updatedRun.id,
                operationalContextSnapshot,
              );
            }

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason,
              payload,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey,
              runId: updatedRun.id,
              finishedAt: new Date(),
            });
            return updatedRun;
          });
          contextReservation.current?.commit();
        } catch (error) {
          contextReservation.current?.rollback();
          throw error;
        }
        if (mergedRun) return mergedRun;

        const currentRun = await getRun(targetRun.id);
        if (currentRun?.status === "cancelled") return null;
        if (
          attempt === 0 &&
          currentRun?.status === targetRun.status &&
          isSameTaskScope(runTaskKey(currentRun), taskKey)
        ) {
          targetRun = currentRun;
          continue;
        }
        // The selected run changed again, became operational or terminal, or
        // disappeared before the bounded merge retry. Queue a fresh follow-up
        // below so the incoming operational context is never silently dropped.
        break;
      }
    }

    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    let newRunContextReservation: ReturnType<typeof stageTransientExecutionContext> | null =
      null;
    const newRun = await db.transaction(async (tx) => {
      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: agent.companyId,
          agentId,
          source,
          triggerDetail,
          reason,
          payload,
          status: "queued",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey,
        })
        .returning()
        .then((rows) => rows[0]);

      const insertedRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: agent.companyId,
          agentId,
          invocationSource: source,
          triggerDetail,
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: redactWakeupFields({ contextSnapshot: enrichedContextSnapshot })
            .contextSnapshot,
          sessionIdBefore: sessionBefore,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: insertedRun.id,
          updatedAt: new Date(),
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      newRunContextReservation = stageTransientExecutionContext(
        insertedRun.id,
        enrichedContextSnapshot,
      );
      return insertedRun;
    }).then(
      (result) => {
        newRunContextReservation?.commit();
        return result;
      },
      (error) => {
        newRunContextReservation?.rollback();
        throw error;
      },
    );

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  async function listProjectScopedRunIds(companyId: string, projectId: string) {
    const runIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([heartbeatRuns.id], { id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${runIssueId}`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function listProjectScopedWakeupIds(companyId: string, projectId: string) {
    const wakeIssueId = sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${agentWakeupRequests.payload} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([agentWakeupRequests.id], { id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${wakeIssueId}`,
        ),
      )
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          sql`${agentWakeupRequests.runId} is null`,
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function cancelPendingWakeupsForBudgetScope(scope: BudgetEnforcementScope) {
    const now = new Date();
    let wakeupIds: string[] = [];

    if (scope.scopeType === "company") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else if (scope.scopeType === "agent") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            eq(agentWakeupRequests.agentId, scope.scopeId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else {
      wakeupIds = await listProjectScopedWakeupIds(scope.companyId, scope.scopeId);
    }

    if (wakeupIds.length === 0) return 0;

    const cancelledWakeups = await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: "Cancelled due to budget pause",
        updatedAt: now,
      })
      .where(
        and(
          inArray(agentWakeupRequests.id, wakeupIds),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          isNull(agentWakeupRequests.runId),
        ),
      )
      .returning({ id: agentWakeupRequests.id });

    for (const { id: wakeupId } of cancelledWakeups) {
      transientExecutionContextsByRunId.delete(
        deferredWakeTransientContextKey(wakeupId),
      );
    }

    return cancelledWakeups.length;
  }

  async function cancelRunInternal(runId: string, reason = "Cancelled by control plane") {
    const transition = await withRunLaunchLock(runId, async () => {
      const currentRun = await getRun(runId);
      if (!currentRun) {
        transientExecutionContextsByRunId.delete(runId);
        throw notFound("Heartbeat run not found");
      }
      if (currentRun.status !== "running" && currentRun.status !== "queued") {
        transientExecutionContextsByRunId.delete(runId);
        return {
          run: currentRun,
          cancelled: false,
          coordination: null,
          processTerminated: true,
        };
      }

      const cancelled = await setRunStatus(currentRun.id, "cancelled", {
        finishedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
      });
      if (!cancelled) {
        return {
          run: await getRun(currentRun.id),
          cancelled: false,
          coordination: null,
          processTerminated: true,
        };
      }

      const coordination = runExecutionCoordinationByRunId.get(currentRun.id) ?? null;
      if (coordination) coordination.cancellationWon = true;
      const processTerminated =
        !runningProcesses.has(currentRun.id) &&
        currentRun.processPid !== null &&
        isRecordedProcessTreeAlive(currentRun.processPid)
          ? false
          : await terminateRegisteredRunProcess(currentRun.id);
      if (coordination) coordination.terminationProven = processTerminated;
      const persistedCancelled = processTerminated
        ? cancelled
        : await db
            .update(heartbeatRuns)
            .set({
              errorCode: PROCESS_TERMINATION_PENDING_ERROR_CODE,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(heartbeatRuns.id, cancelled.id),
                eq(heartbeatRuns.status, "cancelled"),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? cancelled);
      return {
        run: persistedCancelled,
        cancelled: true,
        coordination,
        processTerminated,
      };
    });
    if (!transition.cancelled || !transition.run) return transition.run;

    const cancelled = transition.run;
    await setWakeupStatus(cancelled.wakeupRequestId, "cancelled", {
      finishedAt: new Date(),
      error: reason,
    });

    if (transition.coordination) {
      await transition.coordination.executionSettled;
    }
    if (!transition.processTerminated) {
      // The process could not be proven stopped and no local execution owner
      // exists to signal cleanup. Keep queued/deferred work blocked rather than
      // overlap it with an untracked cancelled process.
      return cancelled;
    }

    await appendRunEvent(cancelled, await nextRunEventSeq(cancelled.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "run cancelled",
    });
    await releaseIssueExecutionAndPromote(cancelled);

    await finalizeAgentStatus(cancelled.agentId, "cancelled");
    await startNextQueuedRunForAgent(cancelled.agentId);
    return cancelled;
  }

  async function cancelActiveForAgentInternal(agentId: string, reason = "Cancelled due to agent pause") {
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

    let cancelledCount = 0;
    for (const run of runs) {
      const cancelled = await cancelRunInternal(run.id, reason).catch((error) => {
        if ((error as { status?: unknown }).status === 404) return null;
        throw error;
      });
      if (cancelled?.status === "cancelled") cancelledCount += 1;
    }

    return cancelledCount;
  }

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    if (scope.scopeType === "agent") {
      await cancelActiveForAgentInternal(scope.scopeId, "Cancelled due to budget pause");
      await cancelPendingWakeupsForBudgetScope(scope);
      return;
    }

    const runIds =
      scope.scopeType === "company"
        ? await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, scope.companyId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          )
          .then((rows) => rows.map((row) => row.id))
        : await listProjectScopedRunIds(scope.companyId, scope.scopeId);

    for (const runId of runIds) {
      await cancelRunInternal(runId, "Cancelled due to budget pause");
    }

    await cancelPendingWakeupsForBudgetScope(scope);
  }

  return {
    list: async (companyId: string, agentId?: string, limit?: number) => {
      const pageLimit = normalizeHeartbeatRunListLimit(limit);
      const query = db
        .select(heartbeatRunListColumns)
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      const rows = await query.limit(pageLimit);
      return rows.map((row) => ({
        ...row,
        resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
      }));
    },

    getRun,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id)))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...ensured,
        sessionDisplayId: latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
      };
    },

    listTaskSessions: async (agentId: string, limit?: number) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt))
        .limit(normalizeAgentTaskSessionListLimit(limit));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: async (runId: string, afterSeq = 0, limit = 200) => {
      const normalizedAfterSeq = Number.isFinite(afterSeq) ? Math.trunc(afterSeq) : 0;
      const finiteLimit = Number.isFinite(limit) ? Math.trunc(limit) : 200;
      const normalizedLimit = Math.max(1, Math.min(finiteLimit, 1000));
      const events = await db
        .select()
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.runId, runId),
            gt(heartbeatRunEvents.seq, normalizedAfterSeq),
          ),
        )
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(normalizedLimit);
      return events.map(redactPersistedHeartbeatEvent);
    },

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const handle = {
        store: run.logStore as "local_file",
        logRef: run.logRef,
      } satisfies RunLogHandle;
      const result = await sanitizedLogCache.read({
        source: sanitizedRunLogSource(handle),
        readSource: (options) => runLogStore.read(handle, options),
        range: opts,
        redactionOptions: await getCurrentUserRedactionOptions(),
      });

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,

    reportRunActivity: clearDetachedRunWarning,

    reapOrphanedRuns,

    resumeQueuedRuns,

    tickTimers: async (now = new Date()) => {
      // Provider probes may spawn slow local CLIs. Keep their single-flight cycle
      // off the latency-critical heartbeat scheduling path.
      void adapterStatusSvc
        .runScheduledProbeCycle()
        .then((probeResult) => {
          if (probeResult.probed.length > 0) {
            logger.info(
              { probed: probeResult.probed, failed: probeResult.failed },
              "adapter health probes completed",
            );
          }
        })
        .catch(() => {
          logger.warn("failed to run scheduled adapter probes");
        });

      const allAgents = await db.select().from(agents);
      const activeEmulationAgentIds = allAgents.length === 0
        ? new Set<string>()
        : new Set(
            (
              await db
                .select({ agentId: agentEmulationSessions.agentId })
                .from(agentEmulationSessions)
                .where(
                  and(
                    inArray(agentEmulationSessions.agentId, allAgents.map((agent) => agent.id)),
                    isNull(agentEmulationSessions.endedAt),
                    gt(agentEmulationSessions.expiresAt, new Date()),
                  ),
                )
            ).map((row) => row.agentId),
          );
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        if (activeEmulationAgentIds.has(agent.id)) continue;
        if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      return { checked, enqueued, skipped };
    },

    cancelRun: (runId: string) => cancelRunInternal(runId),

    cancelActiveForAgent: (agentId: string) => cancelActiveForAgentInternal(agentId),

    cancelBudgetScopeWork,

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
