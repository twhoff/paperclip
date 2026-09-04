import os from "node:os";
import {
  CompiledSensitiveValueMatchers,
  SensitiveValueStreamRedactor,
  collectSensitiveEnvValues,
} from "@paperclipai/adapter-utils/server-utils";
import { isSensitivePayloadKey } from "./redaction.js";

export const CURRENT_USER_REDACTION_TOKEN = "*";
export const SECRET_REDACTION_TOKEN = "***REDACTED***";

const JWT_PATTERN =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;
const JWT_STREAM_CHARACTER = /^[A-Za-z0-9_.-]$/;
const MAX_STREAMING_JWT_CANDIDATE_LENGTH = 16 * 1024;
const MAX_DIAGNOSTIC_RESPONSE_DEPTH = 32;
const MAX_DIAGNOSTIC_RESPONSE_NODES = 4_096;
const MAX_DIAGNOSTIC_RESPONSE_RECORDS = 1_000;
const MAX_DIAGNOSTIC_RESPONSE_FIELDS = 128;
const MAX_DIAGNOSTIC_RESPONSE_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_RESPONSE_TOTAL_STRING_BYTES = 2 * 1024 * 1024;
const MAX_REDACTED_TEXT_OUTPUT_BYTES = 2 * 1024 * 1024;
const REDACTION_INPUT_CHUNK_CHARACTERS = 64 * 1024;
const MAX_HISTORICAL_NDJSON_RECORDS = 10_000;
const HISTORICAL_LOG_STREAMS = new Set(["stdout", "stderr", "system", "assistant"]);
const DIAGNOSTIC_STRING_FIELDS = new Set([
  "command",
  "context",
  "cwd",
  "detail",
  "error",
  "errormessage",
  "errors",
  "message",
  "output",
  "prompt",
  "result",
  "stderr",
  "stderrexcerpt",
  "stdout",
  "stdoutexcerpt",
  "summary",
  "triggerdetail",
]);
const DIAGNOSTIC_CONTAINERS = new Set([
  "checks",
  "context",
  "contextsnapshot",
  "diagnostics",
  "metadata",
  "payload",
  "resultjson",
]);
export interface CurrentUserRedactionOptions {
  enabled?: boolean;
  replacement?: string;
  userNames?: string[];
  homeDirs?: string[];
  secretValues?: Iterable<string>;
  secretValuesOverflow?: boolean;
  compiledSecretMatchers?: CompiledSensitiveValueMatchers;
}

export interface DiagnosticResponseRedactionOptions extends CurrentUserRedactionOptions {
  extraDiagnosticKeys?: Iterable<string>;
  strictShortJwtPrefixes?: boolean;
}

export interface StreamingTextRedactor {
  push(chunk: string): string;
  boundary(): string;
  flush(): string;
}

export interface RedactedTextRangeOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RedactedNdjsonLogRangeResult {
  content: string;
  nextOffset?: number;
  outputLimitExceeded?: boolean;
}

const MALFORMED_LOG_RECORD_MESSAGE = "[historical log record omitted: invalid format]";
const BOUNDED_LOG_RECORD_MESSAGE = "[historical log omitted: record limit exceeded]";

type CurrentUserCandidates = {
  userNames: string[];
  homeDirs: string[];
  replacement: string;
};

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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function splitPathSegments(value: string) {
  return value.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
}

function replaceLastPathSegment(pathValue: string, replacement: string) {
  const normalized = pathValue.replace(/[\\/]+$/, "");
  const lastSeparator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSeparator < 0) return replacement;
  return `${normalized.slice(0, lastSeparator + 1)}${replacement}`;
}

export function maskUserNameForLogs(value: string, fallback = CURRENT_USER_REDACTION_TOKEN) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return `${trimmed[0]}${"*".repeat(Math.max(1, Array.from(trimmed).length - 1))}`;
}

function normalizedSecretValues(values?: Iterable<string>) {
  const processSecretValues = collectSensitiveEnvValues(process.env);
  return new CompiledSensitiveValueMatchers((function* () {
    yield* processSecretValues;
    if (values) yield* values;
  })());
}

export function materializeCurrentUserRedactionOptions(
  options?: CurrentUserRedactionOptions,
): CurrentUserRedactionOptions {
  const normalized = options?.compiledSecretMatchers ?? normalizedSecretValues(options?.secretValues);
  return {
    ...options,
    userNames: options?.userNames ? [...options.userNames] : undefined,
    homeDirs: options?.homeDirs ? [...options.homeDirs] : undefined,
    secretValues: normalized.values,
    secretValuesOverflow: options?.secretValuesOverflow === true || normalized.overflow,
    compiledSecretMatchers: normalized,
  };
}

export function redactSecretsText(
  input: string,
  secretValues?: Iterable<string>,
  forceFailClosed = false,
  compiledSecretMatchers?: CompiledSensitiveValueMatchers,
) {
  if (!input) return input;
  const normalized = compiledSecretMatchers ?? normalizedSecretValues(secretValues);
  if (forceFailClosed || normalized.overflow) return SECRET_REDACTION_TOKEN;
  const redactor = new SensitiveValueStreamRedactor(
    normalized,
    SECRET_REDACTION_TOKEN,
  );
  const exactSafeChunks: string[] = [];
  let exactSafeBytes = 0;
  let truncated = false;

  const appendBounded = (value: string) => {
    if (!value || truncated) return;
    const remainingBytes = MAX_REDACTED_TEXT_OUTPUT_BYTES - exactSafeBytes;
    if (remainingBytes <= 0) {
      truncated = true;
      return;
    }
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (valueBytes <= remainingBytes) {
      exactSafeChunks.push(value);
      exactSafeBytes += valueBytes;
      return;
    }
    const prefix = Buffer.from(value, "utf8")
      .subarray(0, remainingBytes)
      .toString("utf8")
      .replace(/\uFFFD$/u, "");
    if (prefix) {
      exactSafeChunks.push(prefix);
      exactSafeBytes += Buffer.byteLength(prefix, "utf8");
    }
    truncated = true;
  };

  let inputOffset = 0;
  while (inputOffset < input.length && !truncated) {
    let inputEnd = Math.min(
      input.length,
      inputOffset + REDACTION_INPUT_CHUNK_CHARACTERS,
    );
    if (
      inputEnd < input.length &&
      inputEnd > inputOffset &&
      /[\uD800-\uDBFF]/u.test(input[inputEnd - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(input[inputEnd]!)
    ) {
      inputEnd += 1;
    }
    appendBounded(redactor.push(input.slice(inputOffset, inputEnd)));
    inputOffset = inputEnd;
    if (exactSafeBytes >= MAX_REDACTED_TEXT_OUTPUT_BYTES && inputOffset < input.length) {
      truncated = true;
    }
  }
  if (!truncated) appendBounded(redactor.flush(false));

  let exactSafe = exactSafeChunks.join("");
  if (truncated) {
    const candidate = trailingJwtCandidate(exactSafe);
    if (candidate) {
      exactSafe = `${exactSafe.slice(0, -candidate.length)}${SECRET_REDACTION_TOKEN}`;
    } else if (exactSafe.endsWith("ey")) {
      exactSafe = `${exactSafe.slice(0, -2)}${SECRET_REDACTION_TOKEN}`;
    } else if (exactSafe.endsWith("e")) {
      exactSafe = `${exactSafe.slice(0, -1)}${SECRET_REDACTION_TOKEN}`;
    }
  }

  const jwtSafeChunks: string[] = [];
  let jwtSafeBytes = 0;
  const appendJwtSafe = (value: string) => {
    if (!value) return true;
    if (jwtSafeBytes >= MAX_REDACTED_TEXT_OUTPUT_BYTES) return false;
    const remainingBytes = MAX_REDACTED_TEXT_OUTPUT_BYTES - jwtSafeBytes;
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (valueBytes <= remainingBytes) {
      jwtSafeChunks.push(value);
      jwtSafeBytes += valueBytes;
      return true;
    }
    const prefix = Buffer.from(value, "utf8")
      .subarray(0, remainingBytes)
      .toString("utf8")
      .replace(/\uFFFD$/u, "");
    if (prefix) {
      jwtSafeChunks.push(prefix);
      jwtSafeBytes += Buffer.byteLength(prefix, "utf8");
    }
    return false;
  };
  const jwtPattern = new RegExp(JWT_PATTERN.source, JWT_PATTERN.flags);
  let jwtCursor = 0;
  let jwtProjectionTruncated = false;
  for (const match of exactSafe.matchAll(jwtPattern)) {
    const matchIndex = match.index ?? jwtCursor;
    if (!appendJwtSafe(exactSafe.slice(jwtCursor, matchIndex))) {
      jwtProjectionTruncated = true;
      break;
    }
    if (!appendJwtSafe(SECRET_REDACTION_TOKEN)) {
      jwtProjectionTruncated = true;
      break;
    }
    jwtCursor = matchIndex + match[0].length;
  }
  if (!jwtProjectionTruncated && jwtSafeBytes < MAX_REDACTED_TEXT_OUTPUT_BYTES) {
    appendJwtSafe(exactSafe.slice(jwtCursor));
  }
  return jwtSafeChunks.join("");
}

function longestExactSecretSuffix(
  input: string,
  compiledSecretMatchers: CompiledSensitiveValueMatchers,
) {
  let keep = 0;
  for (const { value: secretValue, failure } of compiledSecretMatchers.matchers) {
    let matched = 0;
    for (let index = 0; index < input.length; index += 1) {
      while (matched > 0 && input[index] !== secretValue[matched]) {
        matched = failure[matched - 1]!;
      }
      if (input[index] === secretValue[matched]) matched += 1;
      if (matched === secretValue.length) matched = failure[matched - 1]!;
    }
    keep = Math.max(keep, matched);
  }
  return keep;
}

function longestSensitiveSuffix(input: string) {
  let keep = 0;

  // A JWT may begin at a chunk boundary before enough of the `eyJ` prefix has
  // arrived for the candidate matcher below. Retain those partial prefixes so
  // the completed token is never emitted unredacted.
  if (input.endsWith("e")) keep = Math.max(keep, 1);
  if (input.endsWith("ey")) keep = Math.max(keep, 2);

  const jwtCandidate = input.match(/(?:^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_.-]*)$/);
  if (jwtCandidate?.[1]) keep = Math.max(keep, jwtCandidate[1].length);
  return keep;
}

function trailingJwtCandidate(input: string) {
  const match = input.match(/(?:^|[^A-Za-z0-9_-])(eyJ[A-Za-z0-9_.-]*)$/);
  return match?.[1] ?? null;
}

function redactJwtAndCurrentUserIdentityText(
  input: string,
  opts?: CurrentUserRedactionOptions,
) {
  return redactCurrentUserIdentityText(
    input.replace(JWT_PATTERN, SECRET_REDACTION_TOKEN),
    opts,
  );
}

export function createStreamingTextRedactor(
  opts?: CurrentUserRedactionOptions,
): StreamingTextRedactor {
  const resolvedOptions = materializeCurrentUserRedactionOptions(opts);
  const exactSecretRedactor = new SensitiveValueStreamRedactor(
    resolvedOptions.compiledSecretMatchers ?? [],
    SECRET_REDACTION_TOKEN,
    resolvedOptions.secretValuesOverflow,
  );
  let pending = "";
  let pendingWasBoundaryMasked = false;
  let suppressingOversizedJwt = false;

  const pushSecretSafeChunk = (chunk: string) => {
    if (!chunk) return "";
    const previousPending = pending;
    const previousPendingWasBoundaryMasked = pendingWasBoundaryMasked;
    let combined = previousPending + chunk;
    pending = "";
    pendingWasBoundaryMasked = false;

    if (suppressingOversizedJwt) {
      let index = 0;
      while (index < combined.length && JWT_STREAM_CHARACTER.test(combined[index]!)) {
        index += 1;
      }
      if (index === combined.length) return "";
      suppressingOversizedJwt = false;
      combined = combined.slice(index);
    }

    const jwtCandidate = trailingJwtCandidate(combined);
    if (
      jwtCandidate &&
      jwtCandidate.length > MAX_STREAMING_JWT_CANDIDATE_LENGTH
    ) {
      suppressingOversizedJwt = true;
      return (
        redactJwtAndCurrentUserIdentityText(
          combined.slice(0, combined.length - jwtCandidate.length),
          resolvedOptions,
        ) + SECRET_REDACTION_TOKEN
      );
    }

    const keep = longestSensitiveSuffix(combined);
    const safeLength = combined.length - keep;
    pending = combined.slice(safeLength);
    pendingWasBoundaryMasked =
      previousPendingWasBoundaryMasked && safeLength < previousPending.length;
    let output = redactJwtAndCurrentUserIdentityText(
      combined.slice(0, safeLength),
      resolvedOptions,
    );
    if (previousPendingWasBoundaryMasked && safeLength > 0) {
      const releasedMaskedPrefix = previousPending.slice(
        0,
        Math.min(safeLength, previousPending.length),
      );
      if (releasedMaskedPrefix && output.startsWith(releasedMaskedPrefix)) {
        output = output.slice(releasedMaskedPrefix.length);
      }
    }
    return output;
  };

  return {
    push(chunk: string) {
      if (!chunk) return "";
      return pushSecretSafeChunk(exactSecretRedactor.push(chunk));
    },
    boundary() {
      const exactBoundary = pushSecretSafeChunk(exactSecretRedactor.boundary());
      const isSensitivePrefix =
        pending.length > 0 &&
        (pending === "e" ||
          pending === "ey" ||
          /^eyJ[A-Za-z0-9_.-]*$/.test(pending));
      if (!isSensitivePrefix) return exactBoundary;
      pendingWasBoundaryMasked = true;
      return exactBoundary + SECRET_REDACTION_TOKEN;
    },
    flush() {
      const secretTail = exactSecretRedactor.flush();
      const streamedTail = pushSecretSafeChunk(secretTail);
      const isSensitivePrefix =
        pending.length > 0 &&
        (pending === "e" ||
          pending === "ey" ||
          /^eyJ[A-Za-z0-9_.-]*$/.test(pending));
      const result = isSensitivePrefix
        ? pendingWasBoundaryMasked
          ? ""
          : SECRET_REDACTION_TOKEN
        : redactJwtAndCurrentUserIdentityText(pending, resolvedOptions);
      pending = "";
      pendingWasBoundaryMasked = false;
      suppressingOversizedJwt = false;
      return streamedTail + result;
    },
  };
}

export interface OrderedRedactedTextChunk<Stream extends string> {
  stream: Stream;
  chunk: string;
}

/**
 * Redact chronologically interleaved streams as one credential boundary.
 * Switching streams finalizes the previous stream before any bytes from the
 * next stream are released, preventing cross-stream credential reconstruction.
 */
export class OrderedStreamingTextRedactor<Stream extends string> {
  private readonly options: CurrentUserRedactionOptions;
  private activeStream: Stream | null = null;
  private readonly redactors = new Map<Stream, StreamingTextRedactor>();

  constructor(opts?: CurrentUserRedactionOptions) {
    this.options = materializeCurrentUserRedactionOptions(opts);
  }

  push(stream: Stream, chunk: string): OrderedRedactedTextChunk<Stream>[] {
    const output: OrderedRedactedTextChunk<Stream>[] = [];
    if (this.activeStream !== null && this.activeStream !== stream) {
      const suffix = this.redactors.get(this.activeStream)?.boundary() ?? "";
      if (suffix) output.push({ stream: this.activeStream, chunk: suffix });
    }
    let redactor = this.redactors.get(stream);
    if (!redactor) {
      redactor = createStreamingTextRedactor(this.options);
      this.redactors.set(stream, redactor);
    }
    this.activeStream = stream;
    const redacted = redactor.push(chunk);
    if (redacted) output.push({ stream, chunk: redacted });
    return output;
  }

  flush(): OrderedRedactedTextChunk<Stream>[] {
    const output: OrderedRedactedTextChunk<Stream>[] = [];
    for (const [stream, redactor] of this.redactors) {
      const suffix = redactor.flush();
      if (suffix) output.push({ stream, chunk: suffix });
    }
    this.redactors.clear();
    this.activeStream = null;
    return output;
  }
}

function defaultUserNames() {
  const candidates = [
    process.env.USER,
    process.env.LOGNAME,
    process.env.USERNAME,
  ];

  try {
    candidates.push(os.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  return uniqueNonEmpty(candidates);
}

function defaultHomeDirs(userNames: string[]) {
  const candidates: Array<string | null | undefined> = [
    process.env.HOME,
    process.env.USERPROFILE,
  ];

  try {
    candidates.push(os.homedir());
  } catch {
    // Ignore and fall back to env hints below.
  }

  for (const userName of userNames) {
    candidates.push(`/Users/${userName}`);
    candidates.push(`/home/${userName}`);
    candidates.push(`C:\\Users\\${userName}`);
  }

  return uniqueNonEmpty(candidates);
}

let cachedCurrentUserCandidates: CurrentUserCandidates | null = null;

function getDefaultCurrentUserCandidates(): CurrentUserCandidates {
  if (cachedCurrentUserCandidates) return cachedCurrentUserCandidates;
  const userNames = defaultUserNames();
  cachedCurrentUserCandidates = {
    userNames,
    homeDirs: defaultHomeDirs(userNames),
    replacement: CURRENT_USER_REDACTION_TOKEN,
  };
  return cachedCurrentUserCandidates;
}

function resolveCurrentUserCandidates(opts?: CurrentUserRedactionOptions) {
  const defaults = getDefaultCurrentUserCandidates();
  const userNames = uniqueNonEmpty(opts?.userNames ?? defaults.userNames);
  const homeDirs = uniqueNonEmpty(opts?.homeDirs ?? defaults.homeDirs);
  const replacement = opts?.replacement?.trim() || defaults.replacement;
  return { userNames, homeDirs, replacement };
}

export function redactCurrentUserText(input: string, opts?: CurrentUserRedactionOptions) {
  if (!input) return input;
  return redactCurrentUserIdentityText(
    redactSecretsText(
      input,
      opts?.secretValues,
      opts?.secretValuesOverflow,
      opts?.compiledSecretMatchers,
    ),
    opts,
  );
}

function redactCurrentUserIdentityText(input: string, opts?: CurrentUserRedactionOptions) {
  if (!input || opts?.enabled === false) return input;
  let result = input;

  const { userNames, homeDirs, replacement } = resolveCurrentUserCandidates(opts);

  for (const homeDir of [...homeDirs].sort((a, b) => b.length - a.length)) {
    const lastSegment = splitPathSegments(homeDir).pop() ?? "";
    const replacementDir = lastSegment
      ? replaceLastPathSegment(homeDir, maskUserNameForLogs(lastSegment, replacement))
      : replacement;
    result = result.split(homeDir).join(replacementDir);
  }

  for (const userName of [...userNames].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(userName)}(?![A-Za-z0-9._-])`, "g");
    result = result.replace(pattern, maskUserNameForLogs(userName, replacement));
  }

  return result;
}

/**
 * Redact the complete value before applying byte-range pagination. Applying
 * redaction to an already-sliced range lets callers start inside a credential
 * and reconstruct it from fragments across requests.
 *
 * Offsets describe the redacted representation. This keeps pagination stable
 * even when a credential is replaced by a shorter marker.
 */
export function redactCurrentUserTextRange(
  input: string,
  range?: RedactedTextRangeOptions,
  opts?: CurrentUserRedactionOptions,
) {
  return paginateRedactedText(redactCurrentUserText(input, opts), range);
}

function paginateRedactedText(input: string, range?: RedactedTextRangeOptions) {
  const redacted = Buffer.from(input, "utf8");
  const requestedOffset = Number.isFinite(range?.offset) ? Math.trunc(range?.offset ?? 0) : 0;
  const requestedLimit = Number.isFinite(range?.limitBytes)
    ? Math.trunc(range?.limitBytes ?? 256_000)
    : 256_000;
  const start = Math.max(0, Math.min(requestedOffset, redacted.length));
  const limitBytes = Math.max(0, requestedLimit);
  const end = Math.min(redacted.length, start + limitBytes);

  return {
    content: redacted.subarray(start, end).toString("utf8"),
    nextOffset: end < redacted.length ? end : undefined,
  };
}

/**
 * Redact stored NDJSON log chunks in stream order before pagination. A process
 * credential can span multiple serialized records, so matching the raw file
 * string is insufficient: JSON syntax sits between the credential fragments.
 */
export function redactNdjsonLogRange(
  input: string,
  range?: RedactedTextRangeOptions,
  opts?: CurrentUserRedactionOptions,
  maxOutputBytes?: number,
): RedactedNdjsonLogRangeResult {
  const records: Array<Record<string, unknown>> = [];
  const recordBytes: number[] = [];
  const orderedRedactor = new OrderedStreamingTextRedactor<string>(opts);
  const lastRecordByStream = new Map<string, number>();
  const hasTrailingNewline = input.endsWith("\n");
  const outputLimit = Number.isFinite(maxOutputBytes)
    ? Math.max(0, Math.trunc(maxOutputBytes ?? 0))
    : null;
  let cursor = 0;
  let recordCount = 0;
  let serializedBytes = 0;

  const outputLimitExceeded = (): RedactedNdjsonLogRangeResult => ({
    content: "",
    outputLimitExceeded: true,
  });
  const addRecord = (record: Record<string, unknown>) => {
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    const separatorBytes = records.length > 0 ? 1 : 0;
    if (
      outputLimit !== null &&
      serializedBytes + separatorBytes + bytes + (hasTrailingNewline ? 1 : 0) > outputLimit
    ) {
      return false;
    }
    records.push(record);
    recordBytes.push(bytes);
    serializedBytes += separatorBytes + bytes;
    return true;
  };
  const appendToExistingRecord = (stream: string, chunk: string) => {
    if (!chunk) return true;
    const recordIndex = lastRecordByStream.get(stream);
    if (recordIndex === undefined) return false;
    const record = records[recordIndex]!;
    const nextRecord = {
      ...record,
      chunk: `${typeof record.chunk === "string" ? record.chunk : ""}${chunk}`,
    };
    const nextRecordBytes = Buffer.byteLength(JSON.stringify(nextRecord), "utf8");
    const nextSerializedBytes = serializedBytes - recordBytes[recordIndex]! + nextRecordBytes;
    if (
      outputLimit !== null &&
      nextSerializedBytes + (hasTrailingNewline ? 1 : 0) > outputLimit
    ) {
      return false;
    }
    records[recordIndex] = nextRecord;
    recordBytes[recordIndex] = nextRecordBytes;
    serializedBytes = nextSerializedBytes;
    return true;
  };
  const appendFlushedChunks = (chunks: OrderedRedactedTextChunk<string>[]) =>
    chunks.every(({ stream, chunk }) => appendToExistingRecord(stream, chunk));

  while (cursor < input.length) {
    const newlineIndex = input.indexOf("\n", cursor);
    const lineEnd = newlineIndex < 0 ? input.length : newlineIndex;
    const line = input.slice(cursor, lineEnd);
    cursor = newlineIndex < 0 ? input.length : newlineIndex + 1;
    if (line.length === 0 && cursor === input.length && hasTrailingNewline) break;
    recordCount += 1;
    if (recordCount > MAX_HISTORICAL_NDJSON_RECORDS) {
      const bounded = JSON.stringify({ stream: "system", chunk: BOUNDED_LOG_RECORD_MESSAGE });
      return paginateRedactedText(hasTrailingNewline ? `${bounded}\n` : bounded, range);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }

    if (
      !isPlainObject(parsed) ||
      typeof parsed.stream !== "string" ||
      !HISTORICAL_LOG_STREAMS.has(parsed.stream) ||
      typeof parsed.chunk !== "string"
    ) {
      if (!appendFlushedChunks(orderedRedactor.flush())) return outputLimitExceeded();
      if (!addRecord({ stream: "system", chunk: MALFORMED_LOG_RECORD_MESSAGE })) {
        return outputLimitExceeded();
      }
      continue;
    }

    const stream = parsed.stream;
    let redactedTimestamp: string | undefined;
    if (typeof parsed.ts === "string" && Buffer.byteLength(parsed.ts, "utf8") <= 128) {
      const timestampRedactor = createStreamingTextRedactor(opts);
      redactedTimestamp = timestampRedactor.push(parsed.ts) + timestampRedactor.flush();
    }
    const redactedChunkParts: string[] = [];
    let redactedChunkBytes = 0;
    for (let index = 0; index < Math.max(1, parsed.chunk.length); index += 8 * 1024) {
      const rawChunk = parsed.chunk.slice(index, index + 8 * 1024);
      const redactedParts = orderedRedactor.push(
        stream,
        rawChunk,
      );
      for (const redactedPart of redactedParts) {
        if (redactedPart.stream !== stream) {
          if (!appendToExistingRecord(redactedPart.stream, redactedPart.chunk)) {
            return outputLimitExceeded();
          }
          continue;
        }
        const partBytes = Buffer.byteLength(redactedPart.chunk, "utf8");
        if (
          outputLimit !== null &&
          serializedBytes + redactedChunkBytes + partBytes > outputLimit
        ) {
          return outputLimitExceeded();
        }
        redactedChunkParts.push(redactedPart.chunk);
        redactedChunkBytes += partBytes;
      }
    }
    const record = {
      ...(redactedTimestamp === undefined ? {} : { ts: redactedTimestamp }),
      stream,
      chunk: redactedChunkParts.join(""),
    };
    if (!addRecord(record)) return outputLimitExceeded();
    lastRecordByStream.set(stream, records.length - 1);
  }

  if (!appendFlushedChunks(orderedRedactor.flush())) return outputLimitExceeded();

  const serialized = records.map((record) => JSON.stringify(record)).join("\n");
  return paginateRedactedText(
    serialized && hasTrailingNewline ? `${serialized}\n` : serialized,
    range,
  );
}

export function redactCurrentUserValue<T>(value: T, opts?: CurrentUserRedactionOptions): T {
  if (typeof value === "string") {
    return redactCurrentUserText(value, opts) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCurrentUserValue(entry, opts)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactCurrentUserValue(entry, opts);
  }
  return redacted as T;
}

type DiagnosticValuePath = Array<string | number>;

type DiagnosticStringValue = {
  path: DiagnosticValuePath;
  value: string;
};

type DiagnosticKeyValue = {
  key: string;
  target: Record<string, unknown>;
  value: string;
};

type DiagnosticTraversalState = {
  active: WeakSet<object>;
  diagnosticBytes: number;
  diagnosticKeys: DiagnosticKeyValue[];
  diagnosticOverflow: boolean;
  diagnosticStrings: DiagnosticStringValue[];
  exhausted: boolean;
  nodes: number;
  totalStringBytes: number;
};

function normalizedDiagnosticKey(key: string) {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function defineSafeProperty(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function redactDiagnosticPropertyKey(
  key: string,
  insideDiagnosticContainer: boolean,
  opts: CurrentUserRedactionOptions,
) {
  const directlyRedacted = redactCurrentUserText(key, opts);
  if (directlyRedacted !== key) return SECRET_REDACTION_TOKEN;
  if (!insideDiagnosticContainer) return key;
  const normalizedKey = normalizedDiagnosticKey(key);
  if (
    DIAGNOSTIC_STRING_FIELDS.has(normalizedKey) ||
    DIAGNOSTIC_CONTAINERS.has(normalizedKey)
  ) {
    return key;
  }
  if (/eyJ[A-Za-z0-9_.-]*$/.test(key)) return SECRET_REDACTION_TOKEN;
  if (opts.compiledSecretMatchers) {
    const suffixLength = longestExactSecretSuffix(key, opts.compiledSecretMatchers);
    if (suffixLength > 0) {
      const prefix = key.slice(0, -suffixLength);
      if (suffixLength === key.length || /[-_:/.]$/.test(prefix)) {
        return SECRET_REDACTION_TOKEN;
      }
    }
  }
  return key;
}

function isPotentialDiagnosticKeyFragment(key: string) {
  return (
    key === "e" ||
    key === "ey" ||
    /[-_:/.](?:e|ey)$/.test(key) ||
    key.startsWith("J") ||
    key.startsWith("yJ")
  );
}

function cloneIsolatedDiagnosticRoot(
  value: unknown,
  path: DiagnosticValuePath,
  state: DiagnosticTraversalState,
  extraDiagnosticKeys: ReadonlySet<string>,
  opts: CurrentUserRedactionOptions,
) {
  const previousExhausted = state.exhausted;
  const diagnosticStart = state.diagnosticStrings.length;
  const diagnosticKeyStart = state.diagnosticKeys.length;
  const diagnosticBytesStart = state.diagnosticBytes;
  state.exhausted = false;

  const cloned = cloneAndCollectDiagnosticValue(
    value,
    path,
    true,
    0,
    state,
    extraDiagnosticKeys,
    opts,
  );
  const traversalOverflow = state.exhausted;
  state.exhausted = previousExhausted;

  if (!traversalOverflow) return cloned;
  state.diagnosticStrings.splice(diagnosticStart);
  state.diagnosticKeys.splice(diagnosticKeyStart);
  state.diagnosticBytes = diagnosticBytesStart;
  return SECRET_REDACTION_TOKEN;
}

function cloneAndCollectDiagnosticValue(
  value: unknown,
  path: DiagnosticValuePath,
  insideDiagnosticContainer: boolean,
  depth: number,
  state: DiagnosticTraversalState,
  extraDiagnosticKeys: ReadonlySet<string>,
  opts: CurrentUserRedactionOptions,
): unknown {
  if (state.exhausted) return SECRET_REDACTION_TOKEN;
  if (depth >= MAX_DIAGNOSTIC_RESPONSE_DEPTH) {
    state.exhausted = true;
    return SECRET_REDACTION_TOKEN;
  }
  if (state.nodes >= MAX_DIAGNOSTIC_RESPONSE_NODES) {
    state.exhausted = true;
    return SECRET_REDACTION_TOKEN;
  }
  state.nodes += 1;

  if (typeof value === "string") {
    if (insideDiagnosticContainer && state.diagnosticOverflow) {
      return SECRET_REDACTION_TOKEN;
    }
    const remainingBytes =
      MAX_DIAGNOSTIC_RESPONSE_TOTAL_STRING_BYTES - state.totalStringBytes;
    if (value.length > remainingBytes) {
      state.exhausted = true;
      return SECRET_REDACTION_TOKEN;
    }
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (valueBytes > remainingBytes) {
      state.exhausted = true;
      return SECRET_REDACTION_TOKEN;
    }
    state.totalStringBytes += valueBytes;

    if (insideDiagnosticContainer) {
      if (
        state.diagnosticStrings.length >= MAX_DIAGNOSTIC_RESPONSE_FIELDS ||
        state.diagnosticBytes + valueBytes > MAX_DIAGNOSTIC_RESPONSE_BYTES
      ) {
        state.diagnosticOverflow = true;
        return SECRET_REDACTION_TOKEN;
      }
      state.diagnosticBytes += valueBytes;
      state.diagnosticStrings.push({ path, value });
    }
    return redactCurrentUserText(value, opts);
  }

  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return SECRET_REDACTION_TOKEN;
  }
  if (typeof value !== "object" || value === null) return value;

  if (state.active.has(value)) return SECRET_REDACTION_TOKEN;
  let arrayValue: boolean;
  try {
    arrayValue = Array.isArray(value);
  } catch {
    return SECRET_REDACTION_TOKEN;
  }
  if (arrayValue) {
    const inputArray = value as unknown[];
    const result: unknown[] = [];
    let inputLength: number;
    try {
      inputLength = inputArray.length;
    } catch {
      return SECRET_REDACTION_TOKEN;
    }
    if (inputLength > MAX_DIAGNOSTIC_RESPONSE_NODES - state.nodes) {
      state.exhausted = true;
      return SECRET_REDACTION_TOKEN;
    }
    state.active.add(value);
    try {
      for (let index = 0; index < inputLength; index += 1) {
        if (state.exhausted) break;
        result.push(
          cloneAndCollectDiagnosticValue(
            inputArray[index],
            [...path, index],
            insideDiagnosticContainer,
            depth + 1,
            state,
            extraDiagnosticKeys,
            opts,
          ),
        );
      }
    } catch {
      return SECRET_REDACTION_TOKEN;
    } finally {
      state.active.delete(value);
    }
    return result;
  }

  let plainObject = false;
  let nullPrototype = false;
  try {
    const prototype = Object.getPrototypeOf(value);
    plainObject = prototype === Object.prototype || prototype === null;
    nullPrototype = prototype === null;
  } catch {
    return SECRET_REDACTION_TOKEN;
  }
  if (!plainObject) {
    if (value instanceof Date) {
      try {
        return new Date(value.getTime());
      } catch {
        return SECRET_REDACTION_TOKEN;
      }
    }
    return SECRET_REDACTION_TOKEN;
  }

  const result = Object.create(nullPrototype ? null : Object.prototype) as Record<string, unknown>;
  state.active.add(value);
  try {
    for (const key in value as Record<string, unknown>) {
      if (state.exhausted) break;
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const remainingBytes =
        MAX_DIAGNOSTIC_RESPONSE_TOTAL_STRING_BYTES - state.totalStringBytes;
      if (key.length > remainingBytes) {
        state.exhausted = true;
        break;
      }
      const keyBytes = Buffer.byteLength(key, "utf8");
      if (keyBytes > remainingBytes) {
        state.exhausted = true;
        break;
      }
      state.totalStringBytes += keyBytes;
      const normalizedKey = normalizedDiagnosticKey(key);
      const sensitiveKey = isSensitivePayloadKey(key);
      const entryIsDiagnostic =
        insideDiagnosticContainer ||
        sensitiveKey ||
        DIAGNOSTIC_STRING_FIELDS.has(normalizedKey) ||
        DIAGNOSTIC_CONTAINERS.has(normalizedKey) ||
        extraDiagnosticKeys.has(normalizedKey);
      const safeKey = redactDiagnosticPropertyKey(key, entryIsDiagnostic, opts);
      const entryPath = [...path, safeKey];
      if (entryIsDiagnostic && safeKey === key && isPotentialDiagnosticKeyFragment(key)) {
        state.diagnosticKeys.push({ key: safeKey, target: result, value: key });
      }
      if (sensitiveKey) {
        defineSafeProperty(result, safeKey, SECRET_REDACTION_TOKEN);
        continue;
      }
      if (entryIsDiagnostic && state.diagnosticOverflow) {
        defineSafeProperty(result, safeKey, SECRET_REDACTION_TOKEN);
        continue;
      }
      let entry: unknown;
      try {
        entry = (value as Record<string, unknown>)[key];
      } catch {
        defineSafeProperty(result, safeKey, SECRET_REDACTION_TOKEN);
        continue;
      }
      defineSafeProperty(
        result,
        safeKey,
        entryIsDiagnostic && !insideDiagnosticContainer
          ? cloneIsolatedDiagnosticRoot(entry, entryPath, state, extraDiagnosticKeys, opts)
          : cloneAndCollectDiagnosticValue(
              entry,
              entryPath,
              entryIsDiagnostic,
              depth + 1,
              state,
              extraDiagnosticKeys,
              opts,
            ),
      );
    }
  } catch {
    return SECRET_REDACTION_TOKEN;
  } finally {
    state.active.delete(value);
  }
  return result;
}

function setValueAtPath(value: unknown, path: DiagnosticValuePath, replacement: string) {
  let current: unknown = value;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
    } else if (isPlainObject(current) && typeof segment === "string") {
      current = current[segment];
    } else {
      return;
    }
  }
  const leaf = path.at(-1);
  if (Array.isArray(current) && typeof leaf === "number") {
    current[leaf] = replacement;
  } else if (isPlainObject(current) && typeof leaf === "string") {
    current[leaf] = replacement;
  }
}

type ShortJwtContinuationCounts = {
  startsWithJ: number;
  startsWithYJ: number;
  exactY: number;
};

function countShortJwtContinuations(values: ReadonlyArray<{ value: string }>) {
  return values.reduce<ShortJwtContinuationCounts>(
    (counts, entry) => ({
      startsWithJ: counts.startsWithJ + (entry.value.startsWith("J") ? 1 : 0),
      startsWithYJ: counts.startsWithYJ + (entry.value.startsWith("yJ") ? 1 : 0),
      exactY: counts.exactY + (entry.value === "y" ? 1 : 0),
    }),
    { startsWithJ: 0, startsWithYJ: 0, exactY: 0 },
  );
}

function hasPlausibleShortJwtContinuation(
  prefix: "e" | "ey",
  sourceValue: string,
  counts: ShortJwtContinuationCounts,
) {
  const otherStartsWithJ = counts.startsWithJ - (sourceValue.startsWith("J") ? 1 : 0);
  if (prefix === "ey") {
    return otherStartsWithJ > 0;
  }
  const otherStartsWithYJ = counts.startsWithYJ - (sourceValue.startsWith("yJ") ? 1 : 0);
  const otherExactY = counts.exactY - (sourceValue === "y" ? 1 : 0);
  return otherStartsWithYJ > 0 || (otherExactY > 0 && otherStartsWithJ > 0);
}

function redactIndependentDiagnosticString(
  entry: { value: string },
  continuationCounts: ShortJwtContinuationCounts,
  opts: DiagnosticResponseRedactionOptions,
) {
  const shortJwtPrefix = entry.value.endsWith("ey")
    ? "ey"
    : entry.value.endsWith("e")
      ? "e"
      : null;
  const shortJwtPrefixStart = shortJwtPrefix === null
    ? -1
    : entry.value.length - shortJwtPrefix.length;
  const shortJwtPrefixAtTokenBoundary =
    shortJwtPrefixStart === 0 ||
    (shortJwtPrefixStart > 0 && !/[A-Za-z0-9_-]/.test(entry.value[shortJwtPrefixStart - 1]!));
  const mayRestoreHarmlessShortPrefix =
    shortJwtPrefix !== null &&
    (opts.strictShortJwtPrefixes !== true || !shortJwtPrefixAtTokenBoundary) &&
    (!opts.compiledSecretMatchers ||
      longestExactSecretSuffix(entry.value, opts.compiledSecretMatchers) === 0) &&
    !hasPlausibleShortJwtContinuation(shortJwtPrefix, entry.value, continuationCounts);
  if (mayRestoreHarmlessShortPrefix) {
    return redactCurrentUserText(entry.value, opts);
  }

  const redactor = createStreamingTextRedactor(opts);
  return redactor.push(entry.value) + redactor.flush();
}

function redactDiagnosticResponseRecord<T>(
  value: T,
  resolvedOptions: DiagnosticResponseRedactionOptions,
): T {
  const extraDiagnosticKeys = new Set(
    Array.from(resolvedOptions.extraDiagnosticKeys ?? [], normalizedDiagnosticKey),
  );
  const state: DiagnosticTraversalState = {
    active: new WeakSet(),
    diagnosticBytes: 0,
    diagnosticKeys: [],
    diagnosticOverflow: false,
    diagnosticStrings: [],
    exhausted: false,
    nodes: 0,
    totalStringBytes: 0,
  };
  const redacted = cloneAndCollectDiagnosticValue(
    value,
    [],
    false,
    0,
    state,
    extraDiagnosticKeys,
    resolvedOptions,
  ) as T;
  if (state.diagnosticStrings.length === 0 && state.diagnosticKeys.length === 0) return redacted;

  if (state.diagnosticOverflow) {
    for (const entry of state.diagnosticStrings) {
      setValueAtPath(redacted, entry.path, SECRET_REDACTION_TOKEN);
    }
    for (const entry of state.diagnosticKeys) {
      const currentValue = entry.target[entry.key];
      delete entry.target[entry.key];
      defineSafeProperty(entry.target, SECRET_REDACTION_TOKEN, currentValue);
    }
    return redacted;
  }

  const continuationCounts = countShortJwtContinuations(state.diagnosticStrings);
  for (const entry of state.diagnosticStrings) {
    setValueAtPath(
      redacted,
      entry.path,
      redactIndependentDiagnosticString(entry, continuationCounts, resolvedOptions),
    );
  }
  const keyContinuationCounts = countShortJwtContinuations(state.diagnosticKeys);
  for (const entry of state.diagnosticKeys) {
    const redactedKey = redactIndependentDiagnosticString(
      entry,
      keyContinuationCounts,
      resolvedOptions,
    );
    if (redactedKey === entry.key) continue;
    const currentValue = entry.target[entry.key];
    delete entry.target[entry.key];
    defineSafeProperty(entry.target, SECRET_REDACTION_TOKEN, currentValue);
  }
  return redacted;
}

/**
 * Redact diagnostic API/event responses as one bounded credential surface.
 *
 * Recursive string redaction alone cannot detect a credential persisted in
 * multiple sibling fields. Each diagnostic string is treated as an independent
 * stream, so a trailing credential prefix is removed regardless of which or how
 * many sibling fields contain the continuation. Top-level array records remain
 * isolated, and field-count or byte overflow fails closed for that record. This
 * helper belongs at persistence, response, and live-event boundaries; callers
 * must keep raw execution inputs unchanged.
 */
export function redactDiagnosticResponseValue<T>(
  value: T,
  opts?: DiagnosticResponseRedactionOptions,
): T {
  const resolvedOptions: DiagnosticResponseRedactionOptions = {
    ...materializeCurrentUserRedactionOptions(opts),
    extraDiagnosticKeys: opts?.extraDiagnosticKeys,
    strictShortJwtPrefixes: opts?.strictShortJwtPrefixes,
  };
  let arrayValue = false;
  try {
    arrayValue = Array.isArray(value);
  } catch {
    return SECRET_REDACTION_TOKEN as T;
  }
  if (arrayValue) {
    const inputRecords = value as unknown[];
    const records: unknown[] = [];
    let recordCount: number;
    try {
      recordCount = Math.min(inputRecords.length, MAX_DIAGNOSTIC_RESPONSE_RECORDS);
    } catch {
      return records as T;
    }
    for (let index = 0; index < recordCount; index += 1) {
      try {
        records.push(redactDiagnosticResponseRecord(inputRecords[index], resolvedOptions));
      } catch {
        break;
      }
    }
    return records as T;
  }
  return redactDiagnosticResponseRecord(value, resolvedOptions);
}

/**
 * Project a response while treating every detected diagnostic field as a
 * stateless boundary. Top-level arrays retain per-record traversal budgets, so
 * a hostile or oversized row cannot erase operational selectors in its
 * siblings, while trailing `e`/`ey` JWT prefixes cannot survive into a later
 * record, page, or request.
 */
export function redactStatelessDiagnosticResponseValue<T>(
  value: T,
  opts?: DiagnosticResponseRedactionOptions,
): T {
  return redactDiagnosticResponseValue(value, {
    ...opts,
    strictShortJwtPrefixes: true,
  });
}

/**
 * Redact one stateless diagnostic surface without tolerating a trailing `e` or
 * `ey`. The sentinels are included in the bounded projection so both values
 * and property keys see plausible JWT continuations, then discarded.
 */
export function redactStatelessDiagnosticValue<T>(
  value: T,
  opts?: DiagnosticResponseRedactionOptions,
): T {
  const projected = redactDiagnosticResponseValue(
    { payload: { value, J: "J", yJ: "yJ" } },
    opts,
  ).payload;
  if (!isPlainObject(projected) || !Object.prototype.hasOwnProperty.call(projected, "value")) {
    return SECRET_REDACTION_TOKEN as T;
  }
  return projected.value as T;
}

export function redactThrownDiagnosticError(
  error: unknown,
  opts?: DiagnosticResponseRedactionOptions,
  config?: {
    fallbackMessage?: string;
    includeStack?: boolean;
    includeDetails?: boolean;
    includeErrorsAsDetails?: boolean;
  },
): {
  name: string;
  message: string;
  stack?: string;
  details?: unknown;
} {
  const fallbackMessage = config?.fallbackMessage ?? "Operation failed";
  const readProperty = (key: string): { ok: boolean; value?: unknown } => {
    if ((typeof error !== "object" || error === null) && typeof error !== "function") {
      return { ok: false };
    }
    try {
      return { ok: true, value: Reflect.get(error as object, key) };
    } catch {
      return { ok: true, value: SECRET_REDACTION_TOKEN };
    }
  };

  const nameProperty = readProperty("name");
  const messageProperty = readProperty("message");
  const stackProperty = config?.includeStack ? readProperty("stack") : { ok: false };
  const detailsProperty = config?.includeDetails ? readProperty("details") : { ok: false };
  const errorsProperty = config?.includeErrorsAsDetails
    ? (() => {
        const errors = readProperty("errors");
        return errors.ok && errors.value !== undefined ? errors : readProperty("issues");
      })()
    : { ok: false };

  let primitiveMessage: string | null = null;
  if (typeof error === "string") primitiveMessage = error;
  else if (
    error === null ||
    error === undefined ||
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint"
  ) {
    try {
      primitiveMessage = String(error);
    } catch {
      primitiveMessage = null;
    }
  }

  const diagnostic = {
    name:
      typeof nameProperty.value === "string" && nameProperty.value.length > 0
        ? nameProperty.value
        : "Error",
    message:
      typeof messageProperty.value === "string" && messageProperty.value.length > 0
        ? messageProperty.value
        : primitiveMessage || fallbackMessage,
    ...(config?.includeStack && typeof stackProperty.value === "string"
      ? { stack: stackProperty.value }
      : {}),
    ...(config?.includeDetails && detailsProperty.ok && detailsProperty.value !== undefined
      ? { details: detailsProperty.value }
      : {}),
    ...(config?.includeErrorsAsDetails && errorsProperty.ok && errorsProperty.value !== undefined
      ? { details: errorsProperty.value }
      : {}),
  };

  try {
    const redacted = redactStatelessDiagnosticResponseValue(diagnostic, {
      ...opts,
      extraDiagnosticKeys: [
        ...Array.from(opts?.extraDiagnosticKeys ?? []),
        "name",
        "stack",
        "details",
      ],
    });
    return {
      name: typeof redacted.name === "string" ? redacted.name.slice(0, 128) : "Error",
      message:
        typeof redacted.message === "string"
          ? redacted.message.slice(0, 2_000)
          : fallbackMessage,
      ...(typeof redacted.stack === "string" ? { stack: redacted.stack } : {}),
      ...(Object.prototype.hasOwnProperty.call(redacted, "details")
        ? { details: redacted.details }
        : {}),
    };
  } catch {
    return { name: "Error", message: fallbackMessage };
  }
}
