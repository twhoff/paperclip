import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import {
  redactCurrentUserText,
  redactStatelessDiagnosticResponseValue,
  redactThrownDiagnosticError,
  materializeCurrentUserRedactionOptions,
  SECRET_REDACTION_TOKEN,
  type CurrentUserRedactionOptions,
} from "../log-redaction.js";
import { collectSensitivePayloadValues } from "../redaction.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function hasEnumerableKeys(value: unknown) {
  if (typeof value !== "object" || value === null) return false;
  try {
    return Object.keys(value).length > 0;
  } catch {
    return true;
  }
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  redactionOptions: CurrentUserRedactionOptions,
  attachLoggedError = false,
) {
  const candidate = redactStatelessDiagnosticResponseValue(
    {
      error: payload,
      method: req.method,
      url: redactCurrentUserText(
        req.originalUrl.split(/[?#]/, 1)[0] ?? "",
        redactionOptions,
      ),
      reqBody: req.body,
      reqParams: req.params,
      reqQuery: hasEnumerableKeys(req.query) ? "***REDACTED***" : req.query,
    } satisfies ErrorContext,
    {
      ...redactionOptions,
      extraDiagnosticKeys: ["error", "name", "stack", "details", "raw", "reqBody", "reqParams"],
    },
  );
  let redactedContext: ErrorContext;
  try {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.error !== "object" ||
      candidate.error === null ||
      typeof candidate.error.message !== "string"
    ) {
      throw new Error("invalid redacted error context");
    }
    redactedContext = candidate;
  } catch {
    redactedContext = {
      error: { message: SECRET_REDACTION_TOKEN },
      method: SECRET_REDACTION_TOKEN,
      url: SECRET_REDACTION_TOKEN,
      reqBody: SECRET_REDACTION_TOKEN,
      reqParams: SECRET_REDACTION_TOKEN,
      reqQuery: SECRET_REDACTION_TOKEN,
    };
  }
  (res as any).__errorContext = redactedContext;
  const redactedPayload = redactedContext.error;
  if (attachLoggedError) {
    const redactedError = new Error(redactedPayload.message);
    redactedError.name = redactedPayload.name ?? "Error";
    redactedError.stack = redactedPayload.stack;
    (res as any).err = redactedError;
  }
  return redactedPayload;
}

function requestRedactionOptions(req: Request): CurrentUserRedactionOptions {
  const collectedSecrets = collectSensitivePayloadValues({
    body: req.body,
    params: req.params,
    query: req.query,
  });
  return materializeCurrentUserRedactionOptions({
    enabled: false,
    secretValues: collectedSecrets.values,
    secretValuesOverflow: collectedSecrets.overflow,
  });
}

function safeInstanceOf(value: unknown, constructor: new (...args: any[]) => unknown) {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}

function safeErrorStatus(value: unknown) {
  try {
    const status = Reflect.get(value as object, "status");
    return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? status
      : 500;
  } catch {
    return 500;
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const redactionOptions = requestRedactionOptions(req);
  if (safeInstanceOf(err, HttpError)) {
    const status = safeErrorStatus(err);
    const diagnostic = redactThrownDiagnosticError(err, redactionOptions, {
      fallbackMessage: status >= 500 ? "Internal server error" : "Request failed",
      includeStack: true,
      includeDetails: true,
    });
    const redactedError = attachErrorContext(
      req,
      res,
      diagnostic,
      redactionOptions,
      status >= 500,
    );
    res.status(status).json({
      error: redactedError.message,
      ...(Object.prototype.hasOwnProperty.call(redactedError, "details")
        ? { details: redactedError.details }
        : {}),
    });
    return;
  }

  if (safeInstanceOf(err, ZodError)) {
    const diagnostic = redactThrownDiagnosticError(err, redactionOptions, {
      fallbackMessage: "Validation error",
      includeErrorsAsDetails: true,
    });
    const redactedError = attachErrorContext(
      req,
      res,
      { ...diagnostic, message: "Validation error" },
      redactionOptions,
    );
    res.status(400).json({
      error: redactedError.message,
      details: redactedError.details,
    });
    return;
  }

  const diagnostic = redactThrownDiagnosticError(err, redactionOptions, {
    fallbackMessage: "Internal server error",
    includeStack: true,
  });
  attachErrorContext(
    req,
    res,
    diagnostic,
    redactionOptions,
    true,
  );

  res.status(500).json({ error: "Internal server error" });
}
