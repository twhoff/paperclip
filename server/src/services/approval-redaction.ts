import {
  materializeCurrentUserRedactionOptions,
  redactDiagnosticResponseValue,
  type CurrentUserRedactionOptions,
} from "../log-redaction.js";
import { REDACTED_EVENT_VALUE, redactEventPayload } from "../redaction.js";
import { redactStrictDiagnosticText } from "./comment-redaction.js";

type ApprovalPayloadRecord = {
  payload: Record<string, unknown>;
  decisionNote?: string | null;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactApprovalPayloadForOutput(
  payload: Record<string, unknown>,
  opts: CurrentUserRedactionOptions,
) {
  const projected = redactDiagnosticResponseValue(
    {
      payload: {
        approvalPayload: payload,
        // Discarded sentinels force ambiguous trailing `e` and `ey` fragments
        // (in values or keys) closed at this stateless response boundary.
        J: "J",
        yJ: "yJ",
      },
    },
    opts,
  ).payload;
  return isPlainRecord(projected) && isPlainRecord(projected.approvalPayload)
    ? projected.approvalPayload
    : { redacted: REDACTED_EVENT_VALUE };
}

export function sanitizeApprovalPayloadForPersistence(payload: unknown) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { redacted: REDACTED_EVENT_VALUE };
  }
  return redactEventPayload(payload as Record<string, unknown>) ?? {};
}

export function sanitizeApprovalDecisionNoteForPersistence(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  return redactStrictDiagnosticText(value, { enabled: false });
}

export function redactApprovalRecords<T extends ApprovalPayloadRecord>(
  approvals: readonly T[],
  opts?: CurrentUserRedactionOptions,
): T[] {
  if (approvals.length === 0) return [];
  const resolvedOptions = materializeCurrentUserRedactionOptions(opts);
  return approvals.map((approval) => {
    const persistedPayload = sanitizeApprovalPayloadForPersistence(approval.payload);
    const safeApproval = {
      ...approval,
      payload: redactApprovalPayloadForOutput(persistedPayload, resolvedOptions),
      ...(Object.prototype.hasOwnProperty.call(approval, "decisionNote")
        ? {
            decisionNote:
              typeof approval.decisionNote === "string"
                ? redactStrictDiagnosticText(approval.decisionNote, resolvedOptions)
                : null,
          }
        : {}),
    };
    return redactDiagnosticResponseValue(
      { payload: safeApproval },
      resolvedOptions,
    ).payload;
  });
}

export function redactApprovalRecord<T extends ApprovalPayloadRecord>(
  approval: T,
  opts?: CurrentUserRedactionOptions,
): T {
  return redactApprovalRecords([approval], opts)[0]!;
}
