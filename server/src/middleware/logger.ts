import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import {
  redactCurrentUserText,
  redactStatelessDiagnosticResponseValue,
  SECRET_REDACTION_TOKEN,
  type CurrentUserRedactionOptions,
} from "../log-redaction.js";
import { collectSensitivePayloadValues } from "../redaction.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");
const currentLogFile = path.join(logDir, "current.log");
export const serverLogDir = logDir;
export const serverLogFile = currentLogFile;

function resolveServerLogConfig() {
  const fileServerLog = readConfigFile()?.serverLog;
  const SERVER_LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  type Level = (typeof SERVER_LOG_LEVELS)[number];
  const envLevel = process.env.PAPERCLIP_SERVER_LOG_LEVEL?.trim() as Level | undefined;
  const level: Level =
    envLevel && SERVER_LOG_LEVELS.includes(envLevel)
      ? envLevel
      : (fileServerLog?.level ?? "info");
  const maxFileBytes = Math.max(
    1024,
    Number(process.env.PAPERCLIP_SERVER_LOG_MAX_FILE_BYTES) ||
      fileServerLog?.maxFileBytes ||
      50_000_000,
  );
  const maxFiles = Math.max(
    1,
    Number(process.env.PAPERCLIP_SERVER_LOG_MAX_FILES) ||
      fileServerLog?.maxFiles ||
      5,
  );
  return { level, maxFileBytes, maxFiles };
}

const { level: fileLogLevel, maxFileBytes, maxFiles } = resolveServerLogConfig();

const sharedPrettyOpts = {
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino(
  {
    level: "debug",
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      remove: true,
    },
  },
  pino.transport({
    targets: [
      {
        target: "pino-pretty",
        options: {
          ...sharedPrettyOpts,
          ignore: "pid,hostname,req,res,responseTime",
          colorize: true,
          destination: 1,
        },
        level: "info",
      },
      {
        target: "pino-roll",
        options: {
          file: logFile,
          frequency: "daily",
          size: `${Math.max(1, Math.ceil(maxFileBytes / (1024 * 1024)))}m`,
          dateFormat: "yyyy-MM-dd",
          extension: ".log",
          mkdir: true,
          symlink: true,
          limit: { count: maxFiles },
        },
        level: fileLogLevel,
      },
    ],
  }),
);

export function requestLogUrl(req: {
  originalUrl?: string;
  url?: string;
  body?: unknown;
  params?: unknown;
  query?: unknown;
}): string {
  const rawUrl = req.originalUrl || req.url || "";
  const queryIndex = rawUrl.indexOf("?");
  const fragmentIndex = rawUrl.indexOf("#");
  const endIndexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  const endIndex = endIndexes.length > 0 ? Math.min(...endIndexes) : rawUrl.length;
  const path = rawUrl
    .slice(0, endIndex)
    .replace(
      /(\/(?:board-claim|invites)\/)[^/]+/gi,
      `$1${SECRET_REDACTION_TOKEN}`,
    );
  return redactCurrentUserText(path, logRedactionOptions(req));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    if (Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function hasEnumerableKeys(value: unknown) {
  if (typeof value !== "object" || value === null) return false;
  try {
    return Object.keys(value).length > 0;
  } catch {
    return true;
  }
}

function logRedactionOptions(req: any, res?: any): CurrentUserRedactionOptions {
  const collectedSecrets = collectSensitivePayloadValues({
    body: req?.body,
    params: req?.params,
    query: req?.query,
    errorContext: res?.__errorContext,
  });
  return {
    enabled: false,
    secretValues: collectedSecrets.values,
    secretValuesOverflow: collectedSecrets.overflow,
  };
}

function redactQueryForLogs(value: unknown): unknown {
  return isPlainObject(value) && hasEnumerableKeys(value) ? SECRET_REDACTION_TOKEN : value;
}

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    req(req: any) {
      return {
        id: req.id,
        method: req.method,
        url: requestLogUrl(req),
      };
    },
    res(res: any) {
      return { statusCode: res.statusCode };
    },
  },
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    if (
      res.statusCode === 304 &&
      req.method === "GET" &&
      requestLogUrl(req) === "/api/system/shutdown"
    ) {
      return "debug";
    }
    return "info";
  },
  customSuccessMessage(req, res) {
    return redactCurrentUserText(
      `${req.method} ${requestLogUrl(req)} ${res.statusCode}`,
      logRedactionOptions(req, res),
    );
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    let errMsg = "unknown error";
    try {
      errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || errMsg;
    } catch {
      // Keep the generic message when an untrusted error accessor throws.
    }
    const redactionOptions = logRedactionOptions(req, res);
    return redactStatelessDiagnosticResponseValue(
      {
        message: `${req.method} ${requestLogUrl(req)} ${res.statusCode} — ${errMsg}`,
        errorContext: ctx?.error,
        reqBody: ctx?.reqBody ?? (req as any).body,
        reqParams: ctx?.reqParams ?? (req as any).params,
      },
      {
        ...redactionOptions,
        extraDiagnosticKeys: ["errorContext", "reqBody", "reqParams"],
      },
    ).message;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      const redactionOptions = logRedactionOptions(req, res);
      if (ctx) {
        return redactStatelessDiagnosticResponseValue({
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: redactQueryForLogs(ctx.reqQuery),
        }, {
          ...redactionOptions,
          extraDiagnosticKeys: ["errorContext", "reqBody", "reqParams"],
        });
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (hasEnumerableKeys(body)) {
        props.reqBody = body;
      }
      if (hasEnumerableKeys(params)) {
        props.reqParams = params;
      }
      if (hasEnumerableKeys(query)) {
        props.reqQuery = redactQueryForLogs(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return redactStatelessDiagnosticResponseValue(props, {
        ...redactionOptions,
        extraDiagnosticKeys: ["reqBody", "reqParams", "routePath"],
      });
    }
    return {};
  },
});
