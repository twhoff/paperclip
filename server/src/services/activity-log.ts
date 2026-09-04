import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import {
  redactDiagnosticResponseValue,
  redactThrownDiagnosticError,
  SECRET_REDACTION_TOKEN,
  type CurrentUserRedactionOptions,
} from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);

/** Sentinel run_id used by pcli. No real heartbeat_runs row exists for this UUID. */
const PCLI_SENTINEL_RUN_ID = "00000000-0000-0000-0000-000000000000";

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

export interface LogActivityInput {
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
}

type ActivityDiagnosticFields = Pick<
  LogActivityInput,
  "actorId" | "action" | "entityType" | "entityId" | "details"
>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeActivityDetailsStrict(
  details: Record<string, unknown> | null | undefined,
  opts?: CurrentUserRedactionOptions,
): Record<string, unknown> | null {
  if (!details) return null;
  const projected = redactDiagnosticResponseValue(
    {
      payload: {
        details,
        J: "J",
        yJ: "yJ",
      },
    },
    opts,
  ).payload;
  return isPlainRecord(projected) && isPlainRecord(projected.details)
    ? projected.details
    : { redacted: SECRET_REDACTION_TOKEN };
}

function sanitizeActivityRecord<
  T extends ActivityDiagnosticFields,
>(input: T, opts: CurrentUserRedactionOptions | undefined, strict: boolean): T {
  const activity = {
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    // Details are arbitrary diagnostics rather than selector fields. Make
    // them stateless-strict before persistence so separate rows cannot retain
    // complementary credential fragments.
    details: sanitizeActivityDetailsStrict(input.details, opts),
  };
  const projectedContainer = redactDiagnosticResponseValue(
    {
      payload: strict
        ? {
            activity,
            // These bounded sentinels make an otherwise-ambiguous trailing
            // `e` or `ey` fail closed at a stateless response boundary. They
            // are discarded below and never reach persistence or callers.
            J: "J",
            yJ: "yJ",
          }
        : activity,
    },
    opts,
  ).payload;
  let projected: unknown = projectedContainer;
  if (strict && isPlainRecord(projected)) {
    projected = projected.activity;
  }
  if (!isPlainRecord(projected)) {
    return {
      ...input,
      actorId: SECRET_REDACTION_TOKEN,
      action: SECRET_REDACTION_TOKEN,
      entityType: SECRET_REDACTION_TOKEN,
      entityId: SECRET_REDACTION_TOKEN,
      details: { redacted: SECRET_REDACTION_TOKEN },
    };
  }
  const projectedDetails = projected.details;
  return {
    ...input,
    actorId:
      typeof projected.actorId === "string"
        ? projected.actorId
        : SECRET_REDACTION_TOKEN,
    action:
      typeof projected.action === "string"
        ? projected.action
        : SECRET_REDACTION_TOKEN,
    entityType:
      typeof projected.entityType === "string"
        ? projected.entityType
        : SECRET_REDACTION_TOKEN,
    entityId:
      typeof projected.entityId === "string"
        ? projected.entityId
        : SECRET_REDACTION_TOKEN,
    details:
      projectedDetails === null
        ? null
        : isPlainRecord(projectedDetails)
          ? projectedDetails
          : { redacted: SECRET_REDACTION_TOKEN },
  };
}

export function sanitizeActivityRecordForPersistence<
  T extends ActivityDiagnosticFields,
>(input: T, opts?: CurrentUserRedactionOptions): T {
  return sanitizeActivityRecord(input, opts, false);
}

/**
 * Project an activity row for a stateless output boundary.
 *
 * Unlike persistence, each returned row must fail closed on a trailing JWT or
 * exact-secret prefix: a client can otherwise join it to a continuation from
 * another row, page, request, or live message.
 */
export function sanitizeActivityRecordForOutput<
  T extends ActivityDiagnosticFields,
>(input: T, opts?: CurrentUserRedactionOptions): T {
  return sanitizeActivityRecord(input, opts, true);
}

export function sanitizeActivityDetailsForPersistence(
  details: Record<string, unknown> | null | undefined,
  opts?: CurrentUserRedactionOptions,
): Record<string, unknown> | null {
  if (!details) return null;
  return sanitizeActivityRecordForPersistence(
    {
      actorId: "system",
      action: "activity.details",
      entityType: "activity",
      entityId: "details",
      details,
    },
    opts,
  ).details ?? null;
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedInput = sanitizeActivityRecordForPersistence(
    input,
    currentUserRedactionOptions,
  );

  // Null out the pcli sentinel before the insert to avoid a round-trip FK error.
  const resolvedRunId =
    input.runId === PCLI_SENTINEL_RUN_ID ? null : (input.runId ?? null);

  const row = {
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: sanitizedInput.actorId,
    action: sanitizedInput.action,
    entityType: sanitizedInput.entityType,
    entityId: sanitizedInput.entityId,
    agentId: input.agentId ?? null,
    runId: resolvedRunId,
    details: sanitizedInput.details ?? null,
  };
  try {
    await db.insert(activityLog).values(row);
  } catch (err: unknown) {
    // If the run_id FK is violated (e.g. pcli JWT with a synthetic run_id that
    // was never a real heartbeat run), retry without the run_id rather than
    // surfacing a 500 to the caller.
    const isRunIdFkViolation =
      typeof err === "object" &&
      err !== null &&
      (err as Record<string, unknown>)["code"] === "23503" &&
      String((err as Record<string, unknown>)["constraint_name"] ?? "").includes("run_id");
    if (isRunIdFkViolation) {
      await db.insert(activityLog).values({ ...row, runId: null });
    } else {
      throw err;
    }
  }

  publishLiveEvent({
    companyId: input.companyId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: sanitizedInput.actorId,
      action: sanitizedInput.action,
      entityType: sanitizedInput.entityType,
      entityId: sanitizedInput.entityId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      details: sanitizedInput.details ?? null,
    },
  });

  if (_pluginEventBus && PLUGIN_EVENT_SET.has(sanitizedInput.action)) {
    const event: PluginEvent = {
      eventId: randomUUID(),
      eventType: sanitizedInput.action as PluginEventType,
      occurredAt: new Date().toISOString(),
      actorId: sanitizedInput.actorId,
      actorType: input.actorType,
      entityId: sanitizedInput.entityId,
      entityType: sanitizedInput.entityType,
      companyId: input.companyId,
      payload: {
        ...(sanitizedInput.details ?? {}),
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
      },
    };
    void _pluginEventBus.emit(event).then(({ errors }) => {
      for (const { pluginId, error } of errors) {
        const diagnostic = redactThrownDiagnosticError(
          error,
          currentUserRedactionOptions,
          {
            fallbackMessage: "Plugin event handler failed",
            includeStack: true,
          },
        );
        logger.warn(
          { pluginId, eventType: event.eventType, err: diagnostic },
          "plugin event handler failed",
        );
      }
    }).catch(() => {});
  }
}
