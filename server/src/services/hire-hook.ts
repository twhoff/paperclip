import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { HireApprovedPayload } from "@paperclipai/adapter-utils";
import { findServerAdapter } from "../adapters/registry.js";
import { logger } from "../middleware/logger.js";
import {
  materializeCurrentUserRedactionOptions,
  redactDiagnosticResponseValue,
} from "../log-redaction.js";
import { collectSensitivePayloadValues } from "../redaction.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";

const HIRE_APPROVED_MESSAGE =
  "Tell your user that your hire was approved, now they should assign you a task in Paperclip or ask you to create issues.";
const HIRE_HOOK_ERROR_NAME = "Error";
const HIRE_HOOK_ERROR_MESSAGE = "Adapter hire hook failed";

export interface NotifyHireApprovedInput {
  companyId: string;
  agentId: string;
  source: "join_request" | "approval";
  sourceId: string;
  approvedAt?: Date;
}

function safeHireHookError(
  err: unknown,
  redactionOptions: ReturnType<typeof materializeCurrentUserRedactionOptions>,
) {
  let name = HIRE_HOOK_ERROR_NAME;
  let message = HIRE_HOOK_ERROR_MESSAGE;
  try {
    if (err instanceof Error) {
      let candidateName: unknown;
      let candidateMessage: unknown;
      try {
        candidateName = err.name;
      } catch {
        candidateName = null;
      }
      try {
        candidateMessage = err.message;
      } catch {
        candidateMessage = null;
      }
      if (typeof candidateName === "string" && candidateName.length > 0) name = candidateName;
      if (typeof candidateMessage === "string" && candidateMessage.length > 0) {
        message = candidateMessage;
      }
    } else if (typeof err === "string" && err.length > 0) {
      message = err;
    } else {
      let rendered: unknown;
      try {
        rendered = String(err);
      } catch {
        rendered = null;
      }
      if (typeof rendered === "string" && rendered.length > 0) message = rendered;
    }
  } catch {
    // Hostile objects must not escape this deliberately non-fatal hook boundary.
  }

  try {
    const redacted = redactDiagnosticResponseValue(
      { name, message },
      { ...redactionOptions, extraDiagnosticKeys: ["name"] },
    );
    return {
      name: typeof redacted.name === "string"
        ? redacted.name.slice(0, 128)
        : HIRE_HOOK_ERROR_NAME,
      message: typeof redacted.message === "string"
        ? redacted.message.slice(0, 2_000)
        : HIRE_HOOK_ERROR_MESSAGE,
    };
  } catch {
    return { name: HIRE_HOOK_ERROR_NAME, message: HIRE_HOOK_ERROR_MESSAGE };
  }
}

/**
 * Invokes the adapter's onHireApproved hook when an agent is approved (join-request or hire_agent approval).
 * Failures are non-fatal: we log and write to activity, never throw.
 */
export async function notifyHireApproved(
  db: Db,
  input: NotifyHireApprovedInput,
): Promise<void> {
  const { companyId, agentId, source, sourceId } = input;
  const approvedAt = input.approvedAt ?? new Date();

  const row = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!row) {
    logger.warn({ companyId, agentId, source, sourceId }, "hire hook: agent not found in company, skipping");
    return;
  }

  const adapterType = row.adapterType ?? "process";
  const adapter = findServerAdapter(adapterType);
  const onHireApproved = adapter?.onHireApproved;
  if (!onHireApproved) {
    return;
  }

  const payload: HireApprovedPayload = {
    companyId,
    agentId,
    agentName: row.name,
    adapterType,
    source,
    sourceId,
    approvedAt: approvedAt.toISOString(),
    message: HIRE_APPROVED_MESSAGE,
  };

  const persistedAdapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? (row.adapterConfig as Record<string, unknown>)
      : {};
  const persistedSecrets = collectSensitivePayloadValues(persistedAdapterConfig);
  let redactionOptions = materializeCurrentUserRedactionOptions({
    enabled: false,
    secretValues: persistedSecrets.values,
    secretValuesOverflow: persistedSecrets.overflow,
  });

  try {
    const { config: adapterConfig, secretKeys } = await secretService(db)
      .resolveAdapterConfigForRuntime(companyId, persistedAdapterConfig);
    const resolvedEnv = typeof adapterConfig.env === "object" && adapterConfig.env !== null && !Array.isArray(adapterConfig.env)
      ? adapterConfig.env as Record<string, unknown>
      : {};
    const resolvedSecretValues = Array.from(secretKeys)
      .map((key) => resolvedEnv[key])
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const collectedSecrets = collectSensitivePayloadValues(adapterConfig);
    redactionOptions = materializeCurrentUserRedactionOptions({
      enabled: false,
      secretValues: [
        ...collectedSecrets.values,
        ...resolvedSecretValues,
      ],
      secretValuesOverflow: collectedSecrets.overflow,
    });
    const result = await onHireApproved(payload, adapterConfig);
    if (result.ok) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "hire_hook",
        action: "hire_hook.succeeded",
        entityType: "agent",
        entityId: agentId,
        details: { source, sourceId, adapterType },
      });
      return;
    }

    const redactedFailure = redactDiagnosticResponseValue(
      { error: result.error, detail: result.detail },
      redactionOptions,
    );

    logger.warn(
      {
        companyId,
        agentId,
        adapterType,
        source,
        sourceId,
        error: redactedFailure.error,
        detail: redactedFailure.detail,
      },
      "hire hook: adapter returned failure",
    );
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_hook.failed",
      entityType: "agent",
      entityId: agentId,
      details: {
        source,
        sourceId,
        adapterType,
        error: redactedFailure.error,
        detail: redactedFailure.detail,
      },
    });
  } catch (err) {
    const redactedError = safeHireHookError(err, redactionOptions);
    try {
      logger.error(
        { err: redactedError, companyId, agentId, adapterType, source, sourceId },
        "hire hook: adapter threw",
      );
    } catch {
      // Logging must not turn an optional adapter callback into a fatal request.
    }
    try {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "hire_hook",
        action: "hire_hook.error",
        entityType: "agent",
        entityId: agentId,
        details: {
          source,
          sourceId,
          adapterType,
          error: redactedError.message,
        },
      });
    } catch {
      // Activity reporting is also best-effort for this non-fatal hook.
    }
  }
}
