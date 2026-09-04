import { heartbeatRuns } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  SECRET_REDACTION_TOKEN,
  createStreamingTextRedactor,
  redactSecretsText,
} from "../log-redaction.js";

const HEARTBEAT_RUN_SUMMARY_SQL_TEXT_LIMIT = 512;

// Project only bounded display fields in PostgreSQL. Selecting result_json and
// trimming it later still makes the driver parse the complete persisted value.
// The 12-character lookahead lets the JS sanitizer remove a JWT candidate that
// begins immediately before the 500-character display cap.
export const heartbeatRunSummaryResultJson = sql<Record<string, unknown> | null>`
  CASE
    WHEN jsonb_typeof(${heartbeatRuns.resultJson}) = 'object' THEN NULLIF(
      (CASE WHEN jsonb_typeof(${heartbeatRuns.resultJson} -> 'summary') = 'string'
        THEN jsonb_build_object('summary', left(${heartbeatRuns.resultJson} ->> 'summary', 512))
        ELSE '{}'::jsonb END) ||
      (CASE WHEN jsonb_typeof(${heartbeatRuns.resultJson} -> 'result') = 'string'
        THEN jsonb_build_object('result', left(${heartbeatRuns.resultJson} ->> 'result', 512))
        ELSE '{}'::jsonb END) ||
      (CASE WHEN jsonb_typeof(${heartbeatRuns.resultJson} -> 'message') = 'string'
        THEN jsonb_build_object('message', left(${heartbeatRuns.resultJson} ->> 'message', 512))
        ELSE '{}'::jsonb END) ||
      (CASE WHEN jsonb_typeof(${heartbeatRuns.resultJson} -> 'error') = 'string'
        THEN jsonb_build_object('error', left(${heartbeatRuns.resultJson} ->> 'error', 512))
        ELSE '{}'::jsonb END) ||
      (CASE WHEN jsonb_typeof(${heartbeatRuns.resultJson} -> 'total_cost_usd') = 'number'
        THEN jsonb_build_object('total_cost_usd', ${heartbeatRuns.resultJson} -> 'total_cost_usd')
        ELSE '{}'::jsonb END) ||
      (CASE WHEN jsonb_typeof(${heartbeatRuns.resultJson} -> 'cost_usd') = 'number'
        THEN jsonb_build_object('cost_usd', ${heartbeatRuns.resultJson} -> 'cost_usd')
        ELSE '{}'::jsonb END) ||
      (CASE WHEN jsonb_typeof(${heartbeatRuns.resultJson} -> 'costUsd') = 'number'
        THEN jsonb_build_object('costUsd', ${heartbeatRuns.resultJson} -> 'costUsd')
        ELSE '{}'::jsonb END),
      '{}'::jsonb
    )
    ELSE NULL
  END
`.as("resultJson");

function truncateSummaryText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return null;
  const projected = value.slice(0, HEARTBEAT_RUN_SUMMARY_SQL_TEXT_LIMIT);
  let redacted: string;
  if (projected.length === HEARTBEAT_RUN_SUMMARY_SQL_TEXT_LIMIT) {
    const redactor = createStreamingTextRedactor({ enabled: false });
    redacted = redactor.push(projected) + redactor.flush();
  } else {
    redacted = redactSecretsText(projected).replace(
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_.-]*$/,
      SECRET_REDACTION_TOKEN,
    );
  }
  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}
