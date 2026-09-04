import { createHash } from "node:crypto";
import {
  materializeCurrentUserRedactionOptions,
  redactNdjsonLogRange,
  type CurrentUserRedactionOptions,
  type RedactedTextRangeOptions,
} from "../log-redaction.js";

export const MAX_SANITIZED_LOG_SOURCE_BYTES = 50_000_000;
export const MAX_SANITIZED_LOG_PAGE_BYTES = 256_000;
export const SANITIZED_LOG_OVERSIZE_MESSAGE =
  "[historical log unavailable: source exceeds safe size limit]";
export const SANITIZED_LOG_STALE_MESSAGE =
  "[historical log temporarily unavailable: source changed during sanitization]";

const DEFAULT_MAX_CACHED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 32;
const DEFAULT_MAX_PENDING_GENERATIONS = 64;
const OVERSIZE_NOTICE = Buffer.from(`${JSON.stringify({
  stream: "system",
  chunk: SANITIZED_LOG_OVERSIZE_MESSAGE,
})}\n`, "utf8");
const BUSY_NOTICE = Buffer.from(`${JSON.stringify({
  stream: "system",
  chunk: "[historical log temporarily unavailable: sanitization queue is full]",
})}\n`, "utf8");
const STALE_NOTICE = Buffer.from(`${JSON.stringify({
  stream: "system",
  chunk: SANITIZED_LOG_STALE_MESSAGE,
})}\n`, "utf8");

export interface SanitizedLogSource {
  namespace: string;
  owner: object;
  logRef: string;
}

export interface SanitizedLogSourceReadResult {
  content: string;
  nextOffset?: number;
}

export interface SanitizedLogCacheOptions {
  maxSourceBytes?: number;
  maxCachedBytes?: number;
  maxEntries?: number;
  maxConcurrentGenerations?: number;
  maxPendingGenerations?: number;
}

export interface SanitizedLogReadInput {
  source: SanitizedLogSource;
  readSource: (options: {
    offset: number;
    limitBytes: number;
  }) => Promise<SanitizedLogSourceReadResult>;
  range?: RedactedTextRangeOptions;
  redactionOptions?: CurrentUserRedactionOptions;
}

export interface SanitizedNdjsonLogCache {
  read(input: SanitizedLogReadInput): Promise<SanitizedLogSourceReadResult>;
  invalidate(source: SanitizedLogSource): void;
  invalidateNamespace(namespace: string): void;
}

type CacheEntry = {
  sourceKey: string;
  namespace: string;
  content: Buffer;
  bytes: number;
};

type PendingGeneration = {
  sourceKey: string;
  namespace: string;
  stale: boolean;
  promise: Promise<Buffer>;
};

function paginateSanitizedLog(
  input: Buffer,
  range?: RedactedTextRangeOptions,
): SanitizedLogSourceReadResult {
  const requestedOffset = Number.isFinite(range?.offset)
    ? Math.trunc(range?.offset ?? 0)
    : 0;
  const requestedLimit = Number.isFinite(range?.limitBytes)
    ? Math.trunc(range?.limitBytes ?? MAX_SANITIZED_LOG_PAGE_BYTES)
    : MAX_SANITIZED_LOG_PAGE_BYTES;
  const start = Math.max(0, Math.min(requestedOffset, input.length));
  const limitBytes = Math.min(
    MAX_SANITIZED_LOG_PAGE_BYTES,
    Math.max(0, requestedLimit),
  );
  const end = Math.min(input.length, start + limitBytes);
  return {
    content: input.subarray(start, end).toString("utf8"),
    nextOffset: end < input.length ? end : undefined,
  };
}

function redactionFingerprint(options?: CurrentUserRedactionOptions) {
  const value = {
    enabled: options?.enabled,
    replacement: options?.replacement,
    userNames: options?.userNames ? [...options.userNames].sort() : undefined,
    homeDirs: options?.homeDirs ? [...options.homeDirs].sort() : undefined,
    secretValues: options?.secretValues
      ? [...options.secretValues].sort()
      : undefined,
    secretValuesOverflow: options?.secretValuesOverflow === true,
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createSanitizedNdjsonLogCache(
  options: SanitizedLogCacheOptions = {},
): SanitizedNdjsonLogCache {
  const maxSourceBytes = Math.max(
    1,
    Math.trunc(options.maxSourceBytes ?? MAX_SANITIZED_LOG_SOURCE_BYTES),
  );
  const maxCachedBytes = Math.max(
    1,
    Math.trunc(options.maxCachedBytes ?? DEFAULT_MAX_CACHED_BYTES),
  );
  const maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  const maxConcurrentGenerations = Math.max(
    1,
    Math.trunc(options.maxConcurrentGenerations ?? 1),
  );
  const maxPendingGenerations = Math.max(
    maxConcurrentGenerations,
    Math.trunc(
      options.maxPendingGenerations ?? DEFAULT_MAX_PENDING_GENERATIONS,
    ),
  );
  const ownerIds = new WeakMap<object, number>();
  const entries = new Map<string, CacheEntry>();
  const pending = new Map<string, PendingGeneration>();
  const generationWaiters: Array<() => void> = [];
  let nextOwnerId = 1;
  let cachedBytes = 0;
  let activeGenerations = 0;

  async function withGenerationSlot<T>(run: () => Promise<T>): Promise<T> {
    if (activeGenerations >= maxConcurrentGenerations) {
      await new Promise<void>((resolve) => generationWaiters.push(resolve));
    } else {
      activeGenerations += 1;
    }
    try {
      return await run();
    } finally {
      const next = generationWaiters.shift();
      if (next) next();
      else activeGenerations -= 1;
    }
  }

  function sourceKey(source: SanitizedLogSource) {
    let ownerId = ownerIds.get(source.owner);
    if (ownerId === undefined) {
      ownerId = nextOwnerId;
      nextOwnerId += 1;
      ownerIds.set(source.owner, ownerId);
    }
    return `${source.namespace}:${ownerId}:${source.logRef}`;
  }

  function removeEntry(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    cachedBytes -= entry.bytes;
  }

  function cacheEntry(key: string, entry: CacheEntry) {
    removeEntry(key);
    if (entry.bytes > maxCachedBytes) return;
    entries.set(key, entry);
    cachedBytes += entry.bytes;
    while (entries.size > maxEntries || cachedBytes > maxCachedBytes) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      removeEntry(oldestKey);
    }
  }

  async function generate(input: SanitizedLogReadInput) {
    const source = await input.readSource({
      offset: 0,
      limitBytes: maxSourceBytes + 1,
    });
    if (
      source.nextOffset !== undefined ||
      Buffer.byteLength(source.content, "utf8") > maxSourceBytes
    ) {
      return OVERSIZE_NOTICE;
    }

    const redacted = redactNdjsonLogRange(
      source.content,
      { offset: 0, limitBytes: Number.MAX_SAFE_INTEGER },
      input.redactionOptions,
      maxSourceBytes,
    );
    if (
      redacted.outputLimitExceeded ||
      Buffer.byteLength(redacted.content, "utf8") > maxSourceBytes
    ) {
      return OVERSIZE_NOTICE;
    }
    return Buffer.from(redacted.content, "utf8");
  }

  return {
    async read(input) {
      const resolvedRedactionOptions = materializeCurrentUserRedactionOptions(
        input.redactionOptions,
      );
      const resolvedInput = {
        ...input,
        redactionOptions: resolvedRedactionOptions,
      };
      const resolvedSourceKey = sourceKey(input.source);
      const key = `${resolvedSourceKey}:${redactionFingerprint(resolvedRedactionOptions)}`;

      let staleRetries = 0;
      while (true) {
        const cached = entries.get(key);
        if (cached) {
          entries.delete(key);
          entries.set(key, cached);
          return paginateSanitizedLog(cached.content, input.range);
        }

        let generation = pending.get(key);
        if (!generation) {
          if (pending.size >= maxPendingGenerations) {
            return paginateSanitizedLog(BUSY_NOTICE, input.range);
          }
          generation = {
            sourceKey: resolvedSourceKey,
            namespace: input.source.namespace,
            stale: false,
            promise: Promise.resolve(Buffer.alloc(0)),
          };
          const currentGeneration = generation;
          generation.promise = withGenerationSlot(async () => {
            if (currentGeneration.stale) return Buffer.alloc(0);
            return generate(resolvedInput);
          })
            .then((content) => {
              if (!currentGeneration.stale) {
                cacheEntry(key, {
                  sourceKey: resolvedSourceKey,
                  namespace: input.source.namespace,
                  content,
                  bytes: content.length,
                });
              }
              return content;
            })
            .finally(() => {
              if (pending.get(key) === currentGeneration) pending.delete(key);
            });
          pending.set(key, generation);
        }

        const content = await generation.promise;
        if (generation.stale) {
          if (staleRetries >= 1) {
            return paginateSanitizedLog(STALE_NOTICE, input.range);
          }
          staleRetries += 1;
          continue;
        }
        return paginateSanitizedLog(content, input.range);
      }
    },

    invalidate(source) {
      const resolvedSourceKey = sourceKey(source);
      for (const [key, entry] of entries) {
        if (entry.sourceKey === resolvedSourceKey) removeEntry(key);
      }
      for (const generation of pending.values()) {
        if (generation.sourceKey === resolvedSourceKey) generation.stale = true;
      }
    },

    invalidateNamespace(namespace) {
      for (const [key, entry] of entries) {
        if (entry.namespace === namespace) removeEntry(key);
      }
      for (const generation of pending.values()) {
        if (generation.namespace === namespace) generation.stale = true;
      }
    },
  };
}

const sharedSanitizedNdjsonLogCache = createSanitizedNdjsonLogCache();

export function getSanitizedNdjsonLogCache() {
  return sharedSanitizedNdjsonLogCache;
}
