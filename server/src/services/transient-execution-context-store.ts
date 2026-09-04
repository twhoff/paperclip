import { types as nodeUtilTypes } from "node:util";

export const TRANSIENT_EXECUTION_CONTEXT_MAX_ENTRIES = 1_000;
export const TRANSIENT_EXECUTION_CONTEXT_MAX_ENTRY_BYTES = 256 * 1024;
export const TRANSIENT_EXECUTION_CONTEXT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const TRANSIENT_EXECUTION_CONTEXT_TTL_MS = 30 * 60 * 1_000;
export const TRANSIENT_EXECUTION_CONTEXT_MAX_DEPTH = 32;
export const TRANSIENT_EXECUTION_CONTEXT_MAX_NODES = 10_000;
export const TRANSIENT_EXECUTION_CONTEXT_MAX_PROPERTIES = 10_000;
export const TRANSIENT_EXECUTION_CONTEXT_MAX_ARRAY_LENGTH = 4_096;
export const TRANSIENT_EXECUTION_CONTEXT_MAX_RESERVATIONS = 1_000;
export const TRANSIENT_EXECUTION_CONTEXT_MAX_RESERVATIONS_PER_KEY = 64;

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

export interface TransientExecutionContextStoreOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  ttlMs?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxProperties?: number;
  maxArrayLength?: number;
  now?: () => number;
}

export interface TransientExecutionContextStore {
  readonly size: number;
  readonly bytes: number;
  set(runId: string, context: Record<string, unknown>): boolean;
  stage(
    runId: string,
    context: Record<string, unknown>,
  ): TransientExecutionContextReservation | null;
  get(runId: string): Record<string, unknown> | undefined;
  take(runId: string): Record<string, unknown> | undefined;
  delete(runId: string): boolean;
  clear(): void;
}

export interface TransientExecutionContextReservation {
  commit(): void;
  rollback(): void;
}

type StoredExecutionContext = {
  serialized: string;
  bytes: number;
  expiresAt: number;
  order: number;
};

type ReservationVersion = {
  entry: StoredExecutionContext;
  state: "pending" | "committed" | "rolled_back";
};

type ReservationChain = {
  epoch: number;
  base: StoredExecutionContext | null;
  versions: ReservationVersion[];
};

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type SerializationLimits = {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxProperties: number;
  maxArrayLength: number;
};

type SerializationState = {
  bytes: number;
  nodes: number;
  properties: number;
  activeObjects: WeakSet<object>;
  limits: SerializationLimits;
};

const SERIALIZATION_FAILED = Symbol("serializationFailed");
type CloneResult = JsonValue | typeof SERIALIZATION_FAILED;

function normalizeLimit(value: number | undefined, fallback: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    if (Array.isArray(value)) return false;
    if (nodeUtilTypes.isProxy(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isPlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    if (nodeUtilTypes.isProxy(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Array.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExecutableToJson(value: object) {
  const ownDescriptor = Object.getOwnPropertyDescriptor(value, "toJSON");
  if (
    ownDescriptor &&
    (!("value" in ownDescriptor) || typeof ownDescriptor.value === "function")
  ) {
    return true;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  if (!prototype) return false;
  const inheritedDescriptor = Object.getOwnPropertyDescriptor(prototype, "toJSON");
  return Boolean(
    inheritedDescriptor &&
      (!("value" in inheritedDescriptor) || typeof inheritedDescriptor.value === "function"),
  );
}

function addBytes(state: SerializationState, bytes: number) {
  if (state.bytes > state.limits.maxBytes - bytes) return false;
  state.bytes += bytes;
  return true;
}

function addJsonStringBytes(state: SerializationState, value: string) {
  if (!addBytes(state, 2)) return false;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let bytes: number;

    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes = 2;
    } else if (codeUnit <= 0x1f) {
      bytes =
        codeUnit === 0x08 ||
        codeUnit === 0x09 ||
        codeUnit === 0x0a ||
        codeUnit === 0x0c ||
        codeUnit === 0x0d
          ? 2
          : 6;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes = 4;
        index += 1;
      } else {
        bytes = 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes = 6;
    } else if (codeUnit <= 0x7f) {
      bytes = 1;
    } else if (codeUnit <= 0x7ff) {
      bytes = 2;
    } else {
      bytes = 3;
    }

    if (!addBytes(state, bytes)) return false;
  }

  return true;
}

function cloneJsonArray(value: unknown[], state: SerializationState, depth: number): CloneResult {
  if (!isPlainArray(value) || hasExecutableToJson(value)) return SERIALIZATION_FAILED;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > state.limits.maxArrayLength
  ) {
    return SERIALIZATION_FAILED;
  }

  const length = lengthDescriptor.value as number;
  if (
    length > state.limits.maxProperties - state.properties ||
    !addBytes(state, 1)
  ) {
    return SERIALIZATION_FAILED;
  }

  let enumerableProperties = 0;
  for (const key in value) {
    if (!hasOwn(value, key)) return SERIALIZATION_FAILED;
    const index = Number(key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= length ||
      String(index) !== key ||
      enumerableProperties >= length
    ) {
      return SERIALIZATION_FAILED;
    }
    enumerableProperties += 1;
  }
  if (enumerableProperties !== length) return SERIALIZATION_FAILED;

  state.properties += length;
  const clone: JsonValue[] = [];
  // Prevent a poisoned Array.prototype.toJSON from running during final serialization.
  Object.defineProperty(clone, "toJSON", { value: null });
  state.activeObjects.add(value);
  try {
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return SERIALIZATION_FAILED;
      }
      if (index > 0 && !addBytes(state, 1)) return SERIALIZATION_FAILED;

      const clonedValue = cloneJsonValue(descriptor.value, state, depth + 1);
      if (clonedValue === SERIALIZATION_FAILED) return SERIALIZATION_FAILED;
      Object.defineProperty(clone, String(index), {
        configurable: true,
        enumerable: true,
        value: clonedValue,
        writable: true,
      });
    }

    return addBytes(state, 1) ? clone : SERIALIZATION_FAILED;
  } finally {
    state.activeObjects.delete(value);
  }
}

function cloneJsonObject(
  value: Record<string, unknown>,
  state: SerializationState,
  depth: number,
): CloneResult {
  if (hasExecutableToJson(value) || !addBytes(state, 1)) return SERIALIZATION_FAILED;
  const clone = Object.create(null) as JsonObject;
  state.activeObjects.add(value);
  try {
    let propertyIndex = 0;
    for (const key in value) {
      if (!hasOwn(value, key)) return SERIALIZATION_FAILED;
      if (state.properties >= state.limits.maxProperties) {
        return SERIALIZATION_FAILED;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        return SERIALIZATION_FAILED;
      }
      state.properties += 1;
      if (propertyIndex > 0 && !addBytes(state, 1)) return SERIALIZATION_FAILED;
      if (!addJsonStringBytes(state, key) || !addBytes(state, 1)) {
        return SERIALIZATION_FAILED;
      }

      const clonedValue = cloneJsonValue(descriptor.value, state, depth + 1);
      if (clonedValue === SERIALIZATION_FAILED) return SERIALIZATION_FAILED;
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: clonedValue,
        writable: true,
      });
      propertyIndex += 1;
    }

    return addBytes(state, 1) ? clone : SERIALIZATION_FAILED;
  } finally {
    state.activeObjects.delete(value);
  }
}

function cloneJsonValue(value: unknown, state: SerializationState, depth: number): CloneResult {
  if (depth > state.limits.maxDepth) return SERIALIZATION_FAILED;
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) return SERIALIZATION_FAILED;

  if (value === null) {
    return addBytes(state, 4) ? null : SERIALIZATION_FAILED;
  }
  if (typeof value === "boolean") {
    return addBytes(state, value ? 4 : 5) ? value : SERIALIZATION_FAILED;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return SERIALIZATION_FAILED;
    const serialized = Object.is(value, -0) ? "0" : String(value);
    return addBytes(state, serialized.length) ? value : SERIALIZATION_FAILED;
  }
  if (typeof value === "string") {
    return addJsonStringBytes(state, value) ? value : SERIALIZATION_FAILED;
  }
  if (typeof value !== "object") return SERIALIZATION_FAILED;
  if (state.activeObjects.has(value)) return SERIALIZATION_FAILED;
  if (Array.isArray(value)) return cloneJsonArray(value, state, depth);
  if (!isPlainRecord(value)) return SERIALIZATION_FAILED;
  return cloneJsonObject(value, state, depth);
}

function serializeJsonRecord(
  value: Record<string, unknown>,
  limits: SerializationLimits,
): { serialized: string; bytes: number } | null {
  if (!isPlainRecord(value)) return null;
  try {
    const state: SerializationState = {
      bytes: 0,
      nodes: 0,
      properties: 0,
      activeObjects: new WeakSet(),
      limits,
    };
    const detached = cloneJsonValue(value, state, 0);
    if (detached === SERIALIZATION_FAILED || !isPlainRecord(detached)) return null;

    // Only the already-bounded, accessor-free, detached clone reaches JSON.stringify.
    const serialized = JSON.stringify(detached);
    if (typeof serialized !== "string") return null;
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes !== state.bytes || bytes > limits.maxBytes) return null;
    return { serialized, bytes };
  } catch {
    return null;
  }
}

function deserializeJsonRecord(serialized: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(serialized) as unknown;
    return isPlainRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createTransientExecutionContextStore(
  options: TransientExecutionContextStoreOptions = {},
): TransientExecutionContextStore {
  const maxEntries = normalizeLimit(
    options.maxEntries,
    TRANSIENT_EXECUTION_CONTEXT_MAX_ENTRIES,
  );
  const maxEntryBytes = normalizeLimit(
    options.maxEntryBytes,
    TRANSIENT_EXECUTION_CONTEXT_MAX_ENTRY_BYTES,
  );
  const maxTotalBytes = normalizeLimit(
    options.maxTotalBytes,
    TRANSIENT_EXECUTION_CONTEXT_MAX_TOTAL_BYTES,
  );
  const ttlMs = normalizeLimit(options.ttlMs, TRANSIENT_EXECUTION_CONTEXT_TTL_MS);
  const maxDepth = normalizeLimit(options.maxDepth, TRANSIENT_EXECUTION_CONTEXT_MAX_DEPTH);
  const maxNodes = normalizeLimit(options.maxNodes, TRANSIENT_EXECUTION_CONTEXT_MAX_NODES);
  const maxProperties = normalizeLimit(
    options.maxProperties,
    TRANSIENT_EXECUTION_CONTEXT_MAX_PROPERTIES,
  );
  const maxArrayLength = normalizeLimit(
    options.maxArrayLength,
    TRANSIENT_EXECUTION_CONTEXT_MAX_ARRAY_LENGTH,
  );
  const now = options.now ?? Date.now;
  const entries = new Map<string, StoredExecutionContext>();
  const reservationChains = new Map<string, ReservationChain>();
  let currentBytes = 0;
  let nextOrder = 0;
  let nextReservationEpoch = 0;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  const serializationLimits: SerializationLimits = {
    maxBytes: maxEntryBytes,
    maxDepth,
    maxNodes,
    maxProperties,
    maxArrayLength,
  };

  const replaceCurrentEntry = (
    runId: string,
    entry: StoredExecutionContext | null,
  ) => {
    const current = entries.get(runId);
    if (current) currentBytes -= current.bytes;
    entries.delete(runId);
    if (entry) {
      entries.set(runId, entry);
      currentBytes += entry.bytes;
    }
  };

  const removeEntry = (runId: string) => {
    const entry = entries.get(runId);
    const hadReservation = reservationChains.delete(runId);
    if (entry) replaceCurrentEntry(runId, null);
    return Boolean(entry || hadReservation);
  };

  const allocatedBytes = () => {
    let bytes = 0;
    for (const [runId, entry] of entries) {
      if (!reservationChains.has(runId)) bytes += entry.bytes;
    }
    for (const chain of reservationChains.values()) {
      if (chain.base) bytes += chain.base.bytes;
      for (const version of chain.versions) bytes += version.entry.bytes;
    }
    return bytes;
  };

  const reservationVersionCount = () => {
    let count = 0;
    for (const chain of reservationChains.values()) count += chain.versions.length;
    return count;
  };

  const enforceStorageLimits = (excludedRunId?: string) => {
    let remainingEntries = entries.size;
    let remainingBytes = allocatedBytes();
    const evictions = Array.from(entries)
      .filter(([runId]) => runId !== excludedRunId && !reservationChains.has(runId))
      .sort(([, left], [, right]) => left.order - right.order);
    const plannedRunIds: string[] = [];

    while (remainingEntries > maxEntries || remainingBytes > maxTotalBytes) {
      const next = evictions.shift();
      if (!next) return false;
      const [runId, entry] = next;
      plannedRunIds.push(runId);
      remainingEntries -= 1;
      remainingBytes -= entry.bytes;
    }

    for (const runId of plannedRunIds) {
      removeEntry(runId);
    }
    return true;
  };

  const reconcileReservationChainState = (
    runId: string,
    chain: ReservationChain,
    currentTime: number,
  ) => {
    if (reservationChains.get(runId)?.epoch !== chain.epoch) return false;

    let changed = false;
    if (chain.base && chain.base.expiresAt <= currentTime) {
      chain.base = null;
      changed = true;
    }

    const remainingVersions = chain.versions.filter((version) => {
      const retain =
        version.state !== "rolled_back" && version.entry.expiresAt > currentTime;
      if (!retain) changed = true;
      return retain;
    });
    if (remainingVersions.length !== chain.versions.length) {
      chain.versions = remainingVersions;
    }

    const latestVersion = chain.versions.at(-1);
    const candidate = latestVersion?.entry ?? chain.base;
    if ((entries.get(runId) ?? null) !== candidate) {
      replaceCurrentEntry(runId, candidate);
      changed = true;
    }

    if (!chain.versions.some((version) => version.state === "pending")) {
      reservationChains.delete(runId);
      changed = true;
    }
    return changed;
  };

  const pruneExpired = (currentTime: number) => {
    let removed = false;
    for (const [runId, chain] of reservationChains) {
      if (reconcileReservationChainState(runId, chain, currentTime)) {
        removed = true;
      }
    }
    for (const [runId, entry] of entries) {
      if (!reservationChains.has(runId) && entry.expiresAt <= currentTime) {
        removeEntry(runId);
        removed = true;
      }
    }
    return removed;
  };

  const clearExpiryTimer = () => {
    if (!expiryTimer) return;
    clearTimeout(expiryTimer);
    expiryTimer = null;
  };

  const scheduleExpiryTimer = () => {
    clearExpiryTimer();
    let earliestExpiry = Number.POSITIVE_INFINITY;
    for (const entry of entries.values()) {
      earliestExpiry = Math.min(earliestExpiry, entry.expiresAt);
    }
    for (const chain of reservationChains.values()) {
      if (chain.base) earliestExpiry = Math.min(earliestExpiry, chain.base.expiresAt);
      for (const version of chain.versions) {
        earliestExpiry = Math.min(earliestExpiry, version.entry.expiresAt);
      }
    }
    if (!Number.isFinite(earliestExpiry)) return;

    const delay = Math.min(
      MAX_TIMEOUT_DELAY_MS,
      Math.max(0, earliestExpiry - now()),
    );
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      pruneExpired(now());
      scheduleExpiryTimer();
    }, delay);
    expiryTimer.unref?.();
  };

  const pruneExpiredAndReschedule = () => {
    if (pruneExpired(now())) scheduleExpiryTimer();
  };

  const readEntry = (runId: string, remove: boolean) => {
    pruneExpiredAndReschedule();
    const entry = entries.get(runId);
    if (!entry) return undefined;
    if (remove) {
      removeEntry(runId);
      scheduleExpiryTimer();
    }
    const value = deserializeJsonRecord(entry.serialized);
    if (value) return value;
    if (!remove) {
      removeEntry(runId);
      scheduleExpiryTimer();
    }
    return undefined;
  };

  const reconcileReservationChain = (runId: string, chain: ReservationChain) => {
    reconcileReservationChainState(runId, chain, now());
    scheduleExpiryTimer();
  };

  const createReservationHandle = (
    runId: string,
    epoch: number,
    versionOrder: number,
  ): TransientExecutionContextReservation => {
    let settled = false;
    const settle = (state: "committed" | "rolled_back") => {
      if (settled) return;
      settled = true;
      const chain = reservationChains.get(runId);
      if (!chain || chain.epoch !== epoch) return;
      const version = chain.versions.find(
        (candidate) => candidate.entry.order === versionOrder,
      );
      if (!version || version.state !== "pending") return;
      version.state = state;
      reconcileReservationChain(runId, chain);
    };
    return {
      commit() {
        settle("committed");
      },
      rollback() {
        settle("rolled_back");
      },
    };
  };

  return {
    get size() {
      pruneExpiredAndReschedule();
      return entries.size;
    },

    get bytes() {
      pruneExpiredAndReschedule();
      return allocatedBytes();
    },

    set(runId, context) {
      const currentTime = now();
      pruneExpired(currentTime);
      // A rejected replacement must never leave stale raw context available.
      removeEntry(runId);

      const serialized = serializeJsonRecord(context, serializationLimits);
      if (!serialized || maxEntries === 0 || ttlMs === 0) {
        scheduleExpiryTimer();
        return false;
      }

      replaceCurrentEntry(runId, {
        ...serialized,
        expiresAt: Math.min(Number.MAX_SAFE_INTEGER, currentTime + ttlMs),
        order: nextOrder++,
      });
      enforceStorageLimits();

      scheduleExpiryTimer();
      return entries.has(runId);
    },

    stage(runId, context) {
      const currentTime = now();
      pruneExpired(currentTime);
      const serialized = serializeJsonRecord(context, serializationLimits);
      if (!serialized || maxEntries === 0 || ttlMs === 0) {
        scheduleExpiryTimer();
        return null;
      }

      let chain = reservationChains.get(runId);
      const createsChain = !chain;
      if (!chain) {
        chain = {
          epoch: nextReservationEpoch++,
          base: entries.get(runId) ?? null,
          versions: [],
        };
      }
      if (
        chain.versions.length >= TRANSIENT_EXECUTION_CONTEXT_MAX_RESERVATIONS_PER_KEY ||
        reservationVersionCount() >= TRANSIENT_EXECUTION_CONTEXT_MAX_RESERVATIONS
      ) {
        scheduleExpiryTimer();
        return null;
      }

      const priorCurrent = entries.get(runId) ?? null;
      const version: ReservationVersion = {
        entry: {
          ...serialized,
          expiresAt: Math.min(Number.MAX_SAFE_INTEGER, currentTime + ttlMs),
          order: nextOrder++,
        },
        state: "pending",
      };
      if (createsChain) reservationChains.set(runId, chain);
      chain.versions.push(version);
      replaceCurrentEntry(runId, version.entry);

      if (!enforceStorageLimits(runId)) {
        chain.versions.pop();
        if (createsChain) reservationChains.delete(runId);
        replaceCurrentEntry(runId, priorCurrent);
        scheduleExpiryTimer();
        return null;
      }

      scheduleExpiryTimer();
      return createReservationHandle(runId, chain.epoch, version.entry.order);
    },

    get(runId) {
      return readEntry(runId, false);
    },

    take(runId) {
      return readEntry(runId, true);
    },

    delete(runId) {
      pruneExpired(now());
      const removed = removeEntry(runId);
      scheduleExpiryTimer();
      return removed;
    },

    clear() {
      clearExpiryTimer();
      entries.clear();
      reservationChains.clear();
      currentBytes = 0;
    },
  };
}

export const sharedTransientExecutionContextStore =
  createTransientExecutionContextStore();
