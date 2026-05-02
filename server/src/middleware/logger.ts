import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";

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
export const serverLogDir = logDir;
export const serverLogFile = logFile;

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
          limit: { count: maxFiles },
        },
        level: fileLogLevel,
      },
    ],
  }),
);

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    req(req: any) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
      };
    },
    res(res: any) {
      return { statusCode: res.statusCode };
    },
  },
  customLogLevel(_req, res, err) {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = body;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
