import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "./types.js";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
}

export class LocalAdapterProcessTerminationError extends Error {
  readonly code = "process_termination_pending" as const;
  readonly processTerminationPending = true as const;

  constructor(readonly pid: number | null) {
    super("Local adapter process tree termination could not be verified");
    this.name = "LocalAdapterProcessTerminationError";
  }
}

export function isLocalAdapterProcessTerminationError(
  value: unknown,
): value is LocalAdapterProcessTerminationError {
  if (!value || typeof value !== "object") return false;
  try {
    return (
      Reflect.get(value, "code") === "process_termination_pending" &&
      Reflect.get(value, "processTerminationPending") === true
    );
  } catch {
    return false;
  }
}

interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
  processGroup?: boolean;
}

interface SpawnTarget {
  command: string;
  args: string[];
}

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

export const runningProcesses = new Map<string, RunningProcess>();

export function signalLocalAdapterProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  processGroup = false,
) {
  if (processGroup && process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      // Fall back to the direct child when group signalling is unavailable.
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function isLocalAdapterProcessAlive(child: ChildProcess, processGroup: boolean) {
  if (processGroup && process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  return child.exitCode === null && child.signalCode === null;
}

async function waitForLocalAdapterProcessExit(
  child: ChildProcess,
  processGroup: boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (isLocalAdapterProcessAlive(child, processGroup)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(25, remainingMs));
    });
  }
  return true;
}

export async function terminateLocalAdapterProcess(
  child: ChildProcess,
  options: {
    processGroup?: boolean;
    graceMs: number;
    killWaitMs?: number;
  },
) {
  const processGroup = options.processGroup === true;
  if (!isLocalAdapterProcessAlive(child, processGroup)) return true;
  signalLocalAdapterProcess(child, "SIGTERM", processGroup);
  if (await waitForLocalAdapterProcessExit(child, processGroup, options.graceMs)) return true;
  signalLocalAdapterProcess(child, "SIGKILL", processGroup);
  return await waitForLocalAdapterProcessExit(
    child,
    processGroup,
    options.killWaitMs ?? 1_000,
  );
}
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;
export const LOCAL_ADAPTER_CONTROL_PLANE_ENV_KEYS = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
] as const;
const LOCAL_ADAPTER_CONTROL_PLANE_ENV_KEY_SET = new Set<string>(
  LOCAL_ADAPTER_CONTROL_PLANE_ENV_KEYS,
);
const LOCAL_ADAPTER_PROVIDER_RUNTIME_ENV_KEY_SET = new Set<string>([
  "PCLI_SESSION_ID",
  "HOLLY_SESSION_ID",
]);
const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;
const REDACTED_ENV_VALUE = "***REDACTED***";
export const MAX_REDACTION_SECRET_VALUES = 128;
export const MAX_REDACTION_SECRET_VALUE_BYTES = 64 * 1024;
export const MAX_REDACTION_SECRET_BYTES = 1024 * 1024;
const PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../skills",
  "../../../../../skills",
];

export interface PaperclipSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  required?: boolean;
  requiredReason?: string | null;
}

export interface InstalledSkillTarget {
  targetPath: string | null;
  kind: "symlink" | "directory" | "file";
}

interface PersistentSkillSnapshotOptions {
  adapterType: string;
  availableEntries: PaperclipSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  skillsHome: string;
  locationLabel?: string | null;
  installedDetail?: string | null;
  missingDetail: string;
  externalConflictDetail: string;
  externalDetail: string;
  warnings?: string[];
}

function normalizePathSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function isMaintainerOnlySkillTarget(candidate: string): boolean {
  return normalizePathSlashes(candidate).includes("/.agents/skills/");
}

function skillLocationLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildManagedSkillOrigin(entry: { required?: boolean }): Pick<
  AdapterSkillEntry,
  "origin" | "originLabel" | "readOnly"
> {
  if (entry.required) {
    return {
      origin: "paperclip_required",
      originLabel: "Required by Paperclip",
      readOnly: false,
    };
  }
  return {
    origin: "company_managed",
    originLabel: "Managed by Paperclip",
    readOnly: false,
  };
}

function resolveInstalledEntryTarget(
  skillsHome: string,
  entryName: string,
  dirent: Dirent,
  linkedPath: string | null,
): InstalledSkillTarget {
  const fullPath = path.join(skillsHome, entryName);
  if (dirent.isSymbolicLink()) {
    return {
      targetPath: linkedPath ? path.resolve(path.dirname(fullPath), linkedPath) : null,
      kind: "symlink",
    };
  }
  if (dirent.isDirectory()) {
    return { targetPath: fullPath, kind: "directory" };
  }
  return { targetPath: fullPath, kind: "file" };
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

function appendPrefixWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  if (prev.length >= cap) return prev;
  return prev + chunk.slice(0, cap - prev.length);
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
) {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SENSITIVE_ENV_KEY.test(key) ? "***REDACTED***" : value;
  }
  return redacted;
}

function isControlPlaneEnvKey(key: string): boolean {
  return LOCAL_ADAPTER_CONTROL_PLANE_ENV_KEY_SET.has(key.toUpperCase());
}

function matchingEnvKeys(env: object, expectedKey: string): string[] {
  const normalizedExpectedKey = expectedKey.toUpperCase();
  return Object.keys(env).filter((key) => key.toUpperCase() === normalizedExpectedKey);
}

function deleteEnvKeyCaseInsensitive(
  env: Record<string, unknown>,
  expectedKey: string,
): void {
  for (const key of matchingEnvKeys(env, expectedKey)) {
    delete env[key];
  }
}

export function stripLocalAdapterControlPlaneEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (isControlPlaneEnvKey(key)) delete sanitized[key];
  }
  return sanitized;
}

/**
 * Build the inherited environment for provider CLI discovery and quota probes.
 * Provider auth/config stays available, while Paperclip credentials and session
 * identity that are meaningful only inside a managed agent run are removed.
 */
export function stripLocalAdapterProviderEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = stripLocalAdapterControlPlaneEnv(env);
  for (const key of Object.keys(sanitized)) {
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey.startsWith("PAPERCLIP_") ||
      LOCAL_ADAPTER_PROVIDER_RUNTIME_ENV_KEY_SET.has(normalizedKey)
    ) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

export function collectSensitiveEnvValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value === "string" &&
      value.length > 0 &&
      (SENSITIVE_ENV_KEY.test(key) || isControlPlaneEnvKey(key))
    ) {
      values.add(value);
    }
  }
  return Array.from(values).sort((left, right) => right.length - left.length);
}

export function normalizeSensitiveValues(values: Iterable<string>): {
  values: string[];
  overflow: boolean;
} {
  const normalized = new Set<string>();
  let totalBytes = 0;
  let overflow = false;
  try {
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0 || normalized.has(value)) continue;
      if (
        normalized.size >= MAX_REDACTION_SECRET_VALUES ||
        value.length > MAX_REDACTION_SECRET_VALUE_BYTES
      ) {
        overflow = true;
        break;
      }
      const valueBytes = Buffer.byteLength(value, "utf8");
      if (
        valueBytes > MAX_REDACTION_SECRET_VALUE_BYTES ||
        totalBytes + valueBytes > MAX_REDACTION_SECRET_BYTES
      ) {
        overflow = true;
        break;
      }
      normalized.add(value);
      totalBytes += valueBytes;
    }
  } catch {
    overflow = true;
  }
  return {
    values: Array.from(normalized).sort((left, right) => right.length - left.length),
    overflow,
  };
}

type SensitiveValueMatcher = {
  value: string;
  failure: readonly number[];
  matched: number;
};

type RedactedInterval = {
  start: number;
  end: number;
};

function buildFailureTable(value: string): number[] {
  const failure = Array.from({ length: value.length }, () => 0);
  for (let index = 1, matched = 0; index < value.length; index += 1) {
    while (matched > 0 && value[index] !== value[matched]) matched = failure[matched - 1]!;
    if (value[index] === value[matched]) matched += 1;
    failure[index] = matched;
  }
  return failure;
}

export class CompiledSensitiveValueMatchers {
  readonly values: string[];
  readonly overflow: boolean;
  readonly matchers: ReadonlyArray<{
    value: string;
    failure: readonly number[];
  }>;

  constructor(values: Iterable<string>) {
    const normalized = normalizeSensitiveValues(values);
    this.values = normalized.values;
    this.overflow = normalized.overflow;
    this.matchers = this.values.map((value) => ({
      value,
      failure: buildFailureTable(value),
    }));
  }
}

export class SensitiveValueStreamRedactor {
  private pending = "";
  private pendingStart = 0;
  private processedLength = 0;
  private intervals: RedactedInterval[] = [];
  private readonly matchers: SensitiveValueMatcher[];
  private readonly failClosed: boolean;
  private emittedFailClosedMarker = false;

  constructor(
    sensitiveValues: Iterable<string> | CompiledSensitiveValueMatchers,
    private readonly replacement = REDACTED_ENV_VALUE,
    forceFailClosed = false,
  ) {
    let compiled: CompiledSensitiveValueMatchers;
    try {
      compiled = sensitiveValues instanceof CompiledSensitiveValueMatchers
        ? sensitiveValues
        : new CompiledSensitiveValueMatchers(sensitiveValues);
    } catch {
      compiled = new CompiledSensitiveValueMatchers([]);
      forceFailClosed = true;
    }
    this.failClosed = forceFailClosed || compiled.overflow;
    this.matchers = compiled.matchers.map((matcher) => ({
      value: matcher.value,
      failure: matcher.failure,
      matched: 0,
    }));
  }

  push(chunk: string): string {
    if (!chunk) return "";
    if (this.failClosed) {
      if (this.emittedFailClosedMarker) return "";
      this.emittedFailClosedMarker = true;
      return this.replacement;
    }
    if (this.matchers.length === 0) return chunk;
    this.pending += chunk;
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index]!;
      this.processedLength += 1;
      let longestMatch = 0;
      for (const matcher of this.matchers) {
        while (
          matcher.matched > 0 &&
          character !== matcher.value[matcher.matched]
        ) {
          matcher.matched = matcher.failure[matcher.matched - 1]!;
        }
        if (character === matcher.value[matcher.matched]) matcher.matched += 1;
        if (matcher.matched === matcher.value.length) {
          longestMatch = Math.max(longestMatch, matcher.value.length);
          matcher.matched = matcher.failure[matcher.matched - 1]!;
        }
      }
      if (longestMatch > 0) {
        this.addRedactedInterval(this.processedLength - longestMatch, this.processedLength);
      }
    }
    const partialLength = this.matchers.reduce(
      (maximum, matcher) => Math.max(maximum, matcher.matched),
      0,
    );
    return this.drainThrough(this.processedLength - partialLength);
  }

  /**
   * Finalize currently buffered prefixes for an output boundary without
   * forgetting matcher state. A later chunk can therefore still complete the
   * same secret, while the prefix already exposed at the boundary remains
   * fail-closed.
   */
  boundary(): string {
    if (this.failClosed) {
      if (this.emittedFailClosedMarker) return "";
      this.emittedFailClosedMarker = true;
      return this.replacement;
    }
    if (this.matchers.length === 0) return "";
    const partialLength = Math.min(
      this.processedLength - this.pendingStart,
      this.matchers.reduce((maximum, matcher) => Math.max(maximum, matcher.matched), 0),
    );
    let output = this.drainThrough(this.processedLength - partialLength);
    if (this.pending.length > 0) {
      output += this.replacement;
      this.pending = "";
      this.pendingStart = this.processedLength;
      this.intervals = [];
    }
    return output;
  }

  flush(redactIncomplete = true): string {
    if (this.failClosed) {
      if (this.emittedFailClosedMarker) return "";
      this.emittedFailClosedMarker = true;
      return this.replacement;
    }
    if (this.matchers.length === 0) return "";
    const partialLength = redactIncomplete
      ? Math.min(
          this.processedLength - this.pendingStart,
          this.matchers.reduce((maximum, matcher) => Math.max(maximum, matcher.matched), 0),
        )
      : 0;
    let output = this.drainThrough(this.processedLength - partialLength);
    if (this.pending.length > 0) {
      output += redactIncomplete ? this.replacement : this.pending;
      this.pending = "";
      this.pendingStart = this.processedLength;
      this.intervals = [];
    }
    for (const matcher of this.matchers) matcher.matched = 0;
    return output;
  }

  private addRedactedInterval(start: number, end: number): void {
    let mergedStart = Math.max(start, this.pendingStart);
    let mergedEnd = end;
    while (this.intervals.length > 0) {
      const previous = this.intervals.at(-1)!;
      if (previous.end < mergedStart) break;
      this.intervals.pop();
      mergedStart = Math.min(mergedStart, previous.start);
      mergedEnd = Math.max(mergedEnd, previous.end);
    }
    this.intervals.push({ start: mergedStart, end: mergedEnd });
  }

  private drainThrough(requestedEnd: number): string {
    const targetEnd = Math.max(
      this.pendingStart,
      Math.min(requestedEnd, this.processedLength),
    );
    let output = "";
    let cursor = this.pendingStart;
    const remainingIntervals: RedactedInterval[] = [];
    for (const interval of this.intervals) {
      if (interval.end <= cursor) continue;
      if (interval.start >= targetEnd) {
        remainingIntervals.push(interval);
        continue;
      }
      if (interval.start > cursor) {
        output += this.pending.slice(
          cursor - this.pendingStart,
          interval.start - this.pendingStart,
        );
      }
      output += this.replacement;
      cursor = Math.max(cursor, interval.end);
    }
    if (cursor < targetEnd) {
      output += this.pending.slice(cursor - this.pendingStart, targetEnd - this.pendingStart);
      cursor = targetEnd;
    }
    this.pending = this.pending.slice(cursor - this.pendingStart);
    this.pendingStart = cursor;
    this.intervals = remainingIntervals;
    return output;
  }
}

type OrderedSensitiveValueChunk<Stream extends string> = {
  stream: Stream;
  chunk: string;
};

class OrderedSensitiveValueStreamRedactor<Stream extends string> {
  private activeStream: Stream | null = null;
  private readonly redactors = new Map<Stream, SensitiveValueStreamRedactor>();

  constructor(private readonly sensitiveValues: CompiledSensitiveValueMatchers) {}

  push(stream: Stream, chunk: string): OrderedSensitiveValueChunk<Stream>[] {
    const output: OrderedSensitiveValueChunk<Stream>[] = [];
    if (this.activeStream !== null && this.activeStream !== stream) {
      const suffix = this.redactors.get(this.activeStream)?.boundary() ?? "";
      if (suffix) output.push({ stream: this.activeStream, chunk: suffix });
    }
    let redactor = this.redactors.get(stream);
    if (!redactor) {
      redactor = new SensitiveValueStreamRedactor(this.sensitiveValues);
      this.redactors.set(stream, redactor);
    }
    this.activeStream = stream;
    const redacted = redactor.push(chunk);
    if (redacted) output.push({ stream, chunk: redacted });
    return output;
  }

  flush(): OrderedSensitiveValueChunk<Stream>[] {
    const output: OrderedSensitiveValueChunk<Stream>[] = [];
    for (const [stream, redactor] of this.redactors) {
      const suffix = redactor.flush();
      if (suffix) output.push({ stream, chunk: suffix });
    }
    this.redactors.clear();
    this.activeStream = null;
    return output;
  }
}

type PaperclipEnvAgent = {
  id: string;
  companyId: string;
  adapterType?: string | null;
};

function isLocalAdapterType(adapterType: string | null | undefined): boolean {
  return (
    adapterType === "cursor" ||
    adapterType === "copilot_cli" ||
    adapterType?.endsWith("_local") === true
  );
}

function localHollySessionId(agent: PaperclipEnvAgent): string | null {
  if (!isLocalAdapterType(agent.adapterType)) return null;
  if (typeof agent.id !== "string" || agent.id.trim().length === 0) {
    throw new Error("Local adapter agent ID must not be empty");
  }
  return `agent-${agent.id}`;
}

export function finalizeLocalAdapterEnv(
  agent: PaperclipEnvAgent,
  env: Record<string, string>,
  configuredEnv: Record<string, unknown>,
): void {
  const hollySessionId = localHollySessionId(agent);
  if (hollySessionId === null) return;

  if (matchingEnvKeys(configuredEnv, "PCLI_SESSION_ID").length > 0) {
    throw new Error("PCLI_SESSION_ID must not be configured for local adapters");
  }
  const configuredHollyKeys = matchingEnvKeys(configuredEnv, "HOLLY_SESSION_ID");
  if (configuredHollyKeys.some((key) => configuredEnv[key] !== hollySessionId)) {
    throw new Error(
      `Configured HOLLY_SESSION_ID does not match the local agent session identity (${hollySessionId})`,
    );
  }
  const configuredPaperclipKeys = Object.keys(configuredEnv).filter((key) =>
    key.toUpperCase().startsWith("PAPERCLIP_"),
  );
  if (configuredPaperclipKeys.length > 0) {
    throw new Error(
      `${configuredPaperclipKeys[0]} is runtime-owned and must not be configured for local adapters`,
    );
  }

  deleteEnvKeyCaseInsensitive(env, "PCLI_SESSION_ID");
  deleteEnvKeyCaseInsensitive(env, "HOLLY_SESSION_ID");
  env.HOLLY_SESSION_ID = hollySessionId;
}

export function buildPaperclipEnv(agent: PaperclipEnvAgent): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    // Only fall back to localhost when no host is configured at all.
    // When HOST is explicitly set to a wildcard like 0.0.0.0 or ::, use the
    // machine hostname so that remote agents (Tailscale, VPN, LAN) can reach
    // the server.  Callers who truly want localhost should set HOST=localhost
    // or PAPERCLIP_API_URL explicitly.
    if (!host) return "localhost";
    if (host === "0.0.0.0" || host === "::") return os.hostname();
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agent.id,
    PAPERCLIP_COMPANY_ID: agent.companyId,
  };
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl = process.env.PAPERCLIP_API_URL ?? `http://${runtimeHost}:${runtimePort}`;
  vars.PAPERCLIP_API_URL = apiUrl;
  if (agent.adapterType) {
    vars.PAPERCLIP_ADAPTER_TYPE = agent.adapterType;
  }
  const hollySessionId = localHollySessionId(agent);
  if (hollySessionId !== null) {
    vars.HOLLY_SESSION_ID = hollySessionId;
  }
  return vars;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? windowsPathExts(env) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

async function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<SpawnTarget> {
  const resolved = await resolveCommandPath(command, cwd, env);
  const executable = resolved ?? command;

  if (process.platform !== "win32") {
    return { command: executable, args };
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    const shell = env.ComSpec || process.env.ComSpec || "cmd.exe";
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ");
    return {
      command: shell,
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return { command: executable, args };
}

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function resolvePaperclipSkillsDir(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<string | null> {
  const candidates = [
    ...PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES.map((relativePath) => path.resolve(moduleDir, relativePath)),
    ...additionalCandidates.map((candidate) => path.resolve(candidate)),
  ];
  const seenRoots = new Set<string>();

  for (const root of candidates) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const isDirectory = await fs.stat(root).then((stats) => stats.isDirectory()).catch(() => false);
    if (isDirectory) return root;
  }

  return null;
}

export async function listPaperclipSkillEntries(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const root = await resolvePaperclipSkillsDir(moduleDir, additionalCandidates);
  if (!root) return [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        key: `paperclipai/paperclip/${entry.name}`,
        runtimeName: entry.name,
        source: path.join(root, entry.name),
        required: true,
        requiredReason: "Bundled Paperclip skills are always available for local adapters.",
      }));
  } catch {
    return [];
  }
}

export async function readInstalledSkillTargets(skillsHome: string): Promise<Map<string, InstalledSkillTarget>> {
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, InstalledSkillTarget>();
  for (const entry of entries) {
    const fullPath = path.join(skillsHome, entry.name);
    const linkedPath = entry.isSymbolicLink() ? await fs.readlink(fullPath).catch(() => null) : null;
    out.set(entry.name, resolveInstalledEntryTarget(skillsHome, entry.name, entry, linkedPath));
  }
  return out;
}

export function buildPersistentSkillSnapshot(
  options: PersistentSkillSnapshotOptions,
): AdapterSkillSnapshot {
  const {
    adapterType,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel,
    installedDetail,
    missingDetail,
    externalConflictDetail,
    externalDetail,
  } = options;
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = [];
  const warnings = [...(options.warnings ?? [])];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    let state: AdapterSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;

    if (installedEntry?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = installedDetail ?? null;
    } else if (installedEntry) {
      state = "external";
      detail = desired ? externalConflictDetail : externalDetail;
    } else if (desired) {
      state = "missing";
      detail = missingDetail;
    }

    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      desired,
      managed,
      state,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.runtimeName),
      detail,
      required: Boolean(available.required),
      requiredReason: available.requiredReason ?? null,
      ...buildManagedSkillOrigin(available),
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: skillLocationLabel(locationLabel),
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: externalDetail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType,
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

function normalizeConfiguredPaperclipRuntimeSkills(value: unknown): PaperclipSkillEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PaperclipSkillEntry[] = [];
  for (const rawEntry of value) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source,
      required: asBoolean(entry.required, false),
      requiredReason:
        typeof entry.requiredReason === "string" && entry.requiredReason.trim().length > 0
          ? entry.requiredReason.trim()
          : null,
    });
  }
  return out;
}

export async function readPaperclipRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const configuredEntries = normalizeConfiguredPaperclipRuntimeSkills(config.paperclipRuntimeSkills);
  if (configuredEntries.length > 0) return configuredEntries;
  return listPaperclipSkillEntries(moduleDir, additionalCandidates);
}

export async function readPaperclipSkillMarkdown(
  moduleDir: string,
  skillKey: string,
): Promise<string | null> {
  const normalized = skillKey.trim().toLowerCase();
  if (!normalized) return null;

  const entries = await listPaperclipSkillEntries(moduleDir);
  const match = entries.find((entry) => entry.key === normalized);
  if (!match) return null;

  try {
    return await fs.readFile(path.join(match.source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

export function readPaperclipSkillSyncPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  const raw = config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const syncConfig = raw as Record<string, unknown>;
  const desiredValues = syncConfig.desiredSkills;
  const desired = Array.isArray(desiredValues)
    ? desiredValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(raw, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}

function canonicalizeDesiredPaperclipSkillReference(
  reference: string,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string {
  const normalizedReference = reference.trim().toLowerCase();
  if (!normalizedReference) return "";

  const exactKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === normalizedReference);
  if (exactKey) return exactKey.key;

  const byRuntimeName = availableEntries.filter((entry) =>
    typeof entry.runtimeName === "string" && entry.runtimeName.trim().toLowerCase() === normalizedReference,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;

  const slugMatches = availableEntries.filter((entry) =>
    entry.key.trim().toLowerCase().split("/").pop() === normalizedReference,
  );
  if (slugMatches.length === 1) return slugMatches[0]!.key;

  return normalizedReference;
}

export function resolvePaperclipDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null; required?: boolean }>,
): string[] {
  const preference = readPaperclipSkillSyncPreference(config);
  const requiredSkills = availableEntries
    .filter((entry) => entry.required)
    .map((entry) => entry.key);
  if (!preference.explicit) {
    return Array.from(new Set(requiredSkills));
  }
  const desiredSkills = preference.desiredSkills
    .map((reference) => canonicalizeDesiredPaperclipSkillReference(reference, availableEntries))
    .filter(Boolean);
  return Array.from(new Set([...requiredSkills, ...desiredSkills]));
}

export function writePaperclipSkillSyncPreference(
  config: Record<string, unknown>,
  desiredSkills: string[],
): Record<string, unknown> {
  const next = { ...config };
  const raw = next.paperclipSkillSync;
  const current =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  current.desiredSkills = Array.from(
    new Set(
      desiredSkills
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  next.paperclipSkillSync = current;
  return next;
}

export async function ensurePaperclipSkillSymlink(
  source: string,
  target: string,
  linkSkill: (source: string, target: string) => Promise<void> = (linkSource, linkTarget) =>
    fs.symlink(linkSource, linkTarget),
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await linkSkill(source, target);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) {
    return "skipped";
  }

  const linkedPathExists = await fs.stat(resolvedLinkedPath).then(() => true).catch(() => false);
  if (linkedPathExists) {
    return "skipped";
  }

  await fs.unlink(target);
  await linkSkill(source, target);
  return "repaired";
}

export async function removeMaintainerOnlySkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
): Promise<string[]> {
  const allowed = new Set(Array.from(allowedSkillNames));
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (allowed.has(entry.name)) continue;

      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing?.isSymbolicLink()) continue;

      const linkedPath = await fs.readlink(target).catch(() => null);
      if (!linkedPath) continue;

      const resolvedLinkedPath = path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(path.dirname(target), linkedPath);
      if (
        !isMaintainerOnlySkillTarget(linkedPath) &&
        !isMaintainerOnlySkillTarget(resolvedLinkedPath)
      ) {
        continue;
      }

      await fs.unlink(target);
      removed.push(entry.name);
    }

    return removed;
  } catch {
    return [];
  }
}

export async function ensureCommandResolvable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

type RunChildProcessOptions = {
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  signal?: AbortSignal;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onLogError?: (err: unknown, runId: string, message: string) => void;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  stdin?: string;
};

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: RunChildProcessOptions,
): Promise<RunProcessResult> {
  return runChildProcessWithEnvironmentBoundary(runId, command, args, opts, {
    hollySessionId: null,
    providerProbe: false,
  });
}

/**
 * Run a provider discovery, model, profile, quota, or environment-test probe.
 * Provider credentials and user configuration remain available, while every
 * Paperclip/session identity field is removed after the final environment
 * merge so callers cannot accidentally or explicitly forward control-plane
 * authority to an untrusted provider CLI.
 */
export async function runProviderProbeChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: RunChildProcessOptions,
): Promise<RunProcessResult> {
  return runChildProcessWithEnvironmentBoundary(runId, command, args, opts, {
    hollySessionId: null,
    providerProbe: true,
  });
}

export async function runLocalAdapterChildProcess(
  agent: PaperclipEnvAgent,
  runId: string,
  command: string,
  args: string[],
  opts: RunChildProcessOptions,
): Promise<RunProcessResult> {
  const hollySessionId = localHollySessionId(agent);
  if (hollySessionId === null) {
    throw new Error("Local adapter child process requires a trusted local adapter type");
  }
  return runChildProcessWithEnvironmentBoundary(runId, command, args, opts, {
    hollySessionId,
    providerProbe: false,
  });
}

async function runChildProcessWithEnvironmentBoundary(
  runId: string,
  command: string,
  args: string[],
  opts: RunChildProcessOptions,
  boundary: {
    hollySessionId: string | null;
    providerProbe: boolean;
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((_err, _id, msg) => console.warn(msg));

  return new Promise<RunProcessResult>((resolve, reject) => {
    const inheritedEnv: NodeJS.ProcessEnv = { ...process.env };
    const sensitiveValues = collectSensitiveEnvValues({ ...inheritedEnv, ...opts.env });
    const compiledSensitiveValues = new CompiledSensitiveValueMatchers(sensitiveValues);
    deleteEnvKeyCaseInsensitive(inheritedEnv, "PAPERCLIP_API_KEY");
    const rawMerged: NodeJS.ProcessEnv = { ...inheritedEnv, ...opts.env };
    const paperclipApiKey = opts.env.PAPERCLIP_API_KEY;
    deleteEnvKeyCaseInsensitive(rawMerged, "PAPERCLIP_API_KEY");
    if (paperclipApiKey !== undefined) rawMerged.PAPERCLIP_API_KEY = paperclipApiKey;

    // A generic process launch may need its run-scoped Paperclip credential,
    // but it must never inherit the server/operator's orchestration session.
    // Local adapters receive a fresh, agent-scoped Holly identity below.
    deleteEnvKeyCaseInsensitive(rawMerged, "PCLI_SESSION_ID");
    deleteEnvKeyCaseInsensitive(rawMerged, "HOLLY_SESSION_ID");
    if (boundary.hollySessionId !== null) {
      rawMerged.HOLLY_SESSION_ID = boundary.hollySessionId;
      const trustedPaperclipEnv = Object.fromEntries(
        Object.entries(opts.env).filter(
          ([key]) =>
            key === key.toUpperCase() &&
            key.startsWith("PAPERCLIP_") &&
            !isControlPlaneEnvKey(key),
        ),
      );
      for (const key of Object.keys(rawMerged)) {
        if (key.toUpperCase().startsWith("PAPERCLIP_")) delete rawMerged[key];
      }
      Object.assign(rawMerged, trustedPaperclipEnv);
    }

    // Strip Claude Code nesting-guard env vars so spawned `claude` processes
    // don't refuse to start with "cannot be launched inside another session".
    // These vars leak in when the Paperclip server itself is started from
    // within a Claude Code session (e.g. `npx paperclipai run` in a terminal
    // owned by Claude Code) or when cron inherits a contaminated shell env.
    const CLAUDE_CODE_NESTING_VARS = [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION",
      "CLAUDE_CODE_PARENT_SESSION",
    ] as const;
    for (const key of CLAUDE_CODE_NESTING_VARS) {
      deleteEnvKeyCaseInsensitive(rawMerged, key);
    }

    const mergedEnv = ensurePathInEnv(
      boundary.providerProbe
        ? stripLocalAdapterProviderEnv(rawMerged)
        : stripLocalAdapterControlPlaneEnv(rawMerged),
    );
    void resolveSpawnTarget(command, args, opts.cwd, mergedEnv)
      .then((target) => {
        if (opts.signal?.aborted) {
          reject(new Error("Child process launch aborted"));
          return;
        }
        let child: ChildProcessWithEvents;
        const useProcessGroup = process.platform !== "win32";
        try {
          child = spawn(target.command, target.args, {
            cwd: opts.cwd,
            env: mergedEnv,
            shell: false,
            stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
            detached: useProcessGroup,
          }) as ChildProcessWithEvents;
        } catch (err) {
          const msg = `Failed to start command "${command}" in "${opts.cwd}": ${
            err instanceof Error ? err.message : String(err)
          }`;
          throw new Error(msg);
        }
        const startedAt = new Date().toISOString();

        if (opts.stdin != null && child.stdin) {
          child.stdin.write(opts.stdin);
          child.stdin.end();
        }

        runningProcesses.set(runId, {
          child,
          graceSec: opts.graceSec,
          processGroup: useProcessGroup,
        });

        if (typeof child.pid === "number" && child.pid > 0 && opts.onSpawn) {
          void opts.onSpawn({ pid: child.pid, startedAt }).catch((err) => {
            onLogError(err, runId, "failed to record child process metadata");
          });
        }

        let timedOut = false;
        let settled = false;
        let terminationPromise: Promise<boolean> | null = null;
        let stdout = "";
        let stderr = "";
        let logChain: Promise<void> = Promise.resolve();
        const orderedOutputRedactor = new OrderedSensitiveValueStreamRedactor<"stdout" | "stderr">(
          compiledSensitiveValues,
        );

        const appendOutput = (stream: "stdout" | "stderr", text: string) => {
          if (text.length === 0) return;
          // Keep the beginning of captured output. Tail truncation can discard
          // the `e`/`ey` prefix of a generic JWT and make the retained suffix
          // unrecognizable to the server's downstream credential redactor.
          if (stream === "stdout") stdout = appendPrefixWithCap(stdout, text);
          else stderr = appendPrefixWithCap(stderr, text);
          logChain = logChain
            .then(() => opts.onLog(stream, text))
            .catch((err) =>
              onLogError(
                err,
                runId,
                `failed to append ${stream} log chunk`,
              ),
            );
        };

        const requestTermination = () => {
          if (terminationPromise) return;
          terminationPromise = terminateLocalAdapterProcess(child, {
            processGroup: useProcessGroup,
            graceMs: Math.max(1, opts.graceSec) * 1000,
            killWaitMs: 1_000,
          });
        };
        const abortListener = () => requestTermination();
        opts.signal?.addEventListener("abort", abortListener, { once: true });
        if (opts.signal?.aborted) abortListener();

        const timeout =
          opts.timeoutSec > 0
            ? setTimeout(() => {
                timedOut = true;
                requestTermination();
              }, opts.timeoutSec * 1000)
            : null;

        child.stdout?.on("data", (chunk: unknown) => {
          for (const output of orderedOutputRedactor.push("stdout", String(chunk))) {
            appendOutput(output.stream, output.chunk);
          }
        });

        child.stderr?.on("data", (chunk: unknown) => {
          for (const output of orderedOutputRedactor.push("stderr", String(chunk))) {
            appendOutput(output.stream, output.chunk);
          }
        });

        child.on("error", (err: Error) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          opts.signal?.removeEventListener("abort", abortListener);
          const errno = (err as NodeJS.ErrnoException).code;
          const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
          const msg =
            errno === "ENOENT"
              ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
              : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
          if (typeof child.pid !== "number" || child.pid <= 0) {
            runningProcesses.delete(runId);
            reject(new Error(msg));
            return;
          }

          // Node can emit `error` for a failed kill as well as a failed spawn.
          // Once a pid exists, do not discard process ownership until the same
          // bounded group-termination proof used by the close path succeeds.
          requestTermination();
          const termination = terminationPromise ?? Promise.resolve(false);
          void termination.then(
            async (terminationProven) => {
              if (!terminationProven) {
                reject(new LocalAdapterProcessTerminationError(child.pid ?? null));
                return;
              }
              for (const output of orderedOutputRedactor.flush()) {
                appendOutput(output.stream, output.chunk);
              }
              await logChain;
              if (runningProcesses.get(runId)?.child === child) {
                runningProcesses.delete(runId);
              }
              reject(new Error(msg));
            },
            () => {
              reject(new LocalAdapterProcessTerminationError(child.pid ?? null));
            },
          );
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          opts.signal?.removeEventListener("abort", abortListener);
          for (const output of orderedOutputRedactor.flush()) {
            appendOutput(output.stream, output.chunk);
          }
          const termination = terminationPromise ?? Promise.resolve(true);
          void Promise.allSettled([logChain, termination]).then(([, terminationResult]) => {
            const terminationProven =
              terminationResult.status === "fulfilled" && terminationResult.value;
            if (!terminationProven) {
              // Keep the run registered. The heartbeat owner must persist its
              // process-termination-pending marker and let bounded recovery
              // prove group absence before releasing capacity or retrying.
              reject(new LocalAdapterProcessTerminationError(child.pid ?? null));
              return;
            }
            if (runningProcesses.get(runId)?.child === child) {
              runningProcesses.delete(runId);
            }
            resolve({
              exitCode: code,
              signal,
              timedOut,
              stdout,
              stderr,
              pid: child.pid ?? null,
              startedAt,
            });
          });
        });
      })
      .catch(reject);
  });
}
