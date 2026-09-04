import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransientExecutionContextStore } from "../services/transient-execution-context-store.js";

const serializedBytes = (value: Record<string, unknown>) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

describe("transient execution context store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores a detached JSON-safe clone and returns detached reads", () => {
    const store = createTransientExecutionContextStore();
    const source = { command: "first", nested: { value: "original" } };

    expect(store.set("run-1", source)).toBe(true);
    source.command = "mutated";
    source.nested.value = "mutated";

    const firstRead = store.get("run-1");
    expect(firstRead).toEqual({ command: "first", nested: { value: "original" } });
    firstRead!.nested = { value: "changed through read" };

    expect(store.get("run-1")).toEqual({
      command: "first",
      nested: { value: "original" },
    });
    store.clear();
  });

  it("evicts the oldest entry deterministically at the count limit without renewing on get", () => {
    const store = createTransientExecutionContextStore({ maxEntries: 2 });

    expect(store.set("run-1", { order: 1 })).toBe(true);
    expect(store.set("run-2", { order: 2 })).toBe(true);
    expect(store.get("run-1")).toEqual({ order: 1 });
    expect(store.set("run-3", { order: 3 })).toBe(true);

    expect(store.get("run-1")).toBeUndefined();
    expect(store.get("run-2")).toEqual({ order: 2 });
    expect(store.get("run-3")).toEqual({ order: 3 });
    expect(store.size).toBe(2);
    store.clear();
  });

  it("evicts oldest entries until the total serialized-byte limit holds", () => {
    const first = { value: "a".repeat(12) };
    const second = { value: "b".repeat(12) };
    const third = { value: "c".repeat(12) };
    const entryBytes = serializedBytes(first);
    const store = createTransientExecutionContextStore({
      maxEntries: 10,
      maxEntryBytes: entryBytes,
      maxTotalBytes: entryBytes * 2,
    });

    expect(store.set("run-1", first)).toBe(true);
    expect(store.set("run-2", second)).toBe(true);
    expect(store.set("run-3", third)).toBe(true);

    expect(store.get("run-1")).toBeUndefined();
    expect(store.get("run-2")).toEqual(second);
    expect(store.get("run-3")).toEqual(third);
    expect(store.bytes).toBe(entryBytes * 2);
    store.clear();
  });

  it("rejects an oversized replacement and removes the previous value first", () => {
    const initial = { value: "small" };
    const store = createTransientExecutionContextStore({
      maxEntryBytes: serializedBytes(initial),
    });

    expect(store.set("run-1", initial)).toBe(true);
    expect(store.set("run-1", { value: "too large" })).toBe(false);

    expect(store.get("run-1")).toBeUndefined();
    expect(store.size).toBe(0);
    expect(store.bytes).toBe(0);
    store.clear();
  });

  it.each([
    ["cyclic", () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    }],
    ["throwing accessor", () => {
      const value: Record<string, unknown> = {};
      Object.defineProperty(value, "secret", {
        enumerable: true,
        get() {
          throw new Error("hostile getter");
        },
      });
      return value;
    }],
    ["non-JSON bigint", () => ({ value: 1n })],
  ])("fails closed for a %s context", (_label, buildContext) => {
    const store = createTransientExecutionContextStore();

    expect(() => store.set("run-1", buildContext())).not.toThrow();
    expect(store.set("run-1", buildContext())).toBe(false);
    expect(store.get("run-1")).toBeUndefined();
    expect(store.size).toBe(0);
    expect(store.bytes).toBe(0);
    store.clear();
  });

  it("rejects a huge string before final serialization", () => {
    const store = createTransientExecutionContextStore({ maxEntryBytes: 64 });

    expect(store.set("run-1", { value: "x".repeat(1_000_000) })).toBe(false);
    expect(store.size).toBe(0);
    expect(store.bytes).toBe(0);
    store.clear();
  });

  it("rejects a huge sparse array even when its serialized form fits the byte limit", () => {
    const sparse: unknown[] = [];
    sparse.length = 10_000;
    const store = createTransientExecutionContextStore({ maxEntryBytes: 100_000 });

    expect(store.set("run-1", { sparse })).toBe(false);
    expect(store.size).toBe(0);
    store.clear();
  });

  it("rejects accessors without invoking them", () => {
    let getterCalls = 0;
    const context: Record<string, unknown> = {};
    Object.defineProperty(context, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-be-read";
      },
    });
    const store = createTransientExecutionContextStore();

    expect(store.set("run-1", context)).toBe(false);
    expect(getterCalls).toBe(0);
    expect(store.size).toBe(0);
    store.clear();
  });

  it("rejects a revoked root proxy without throwing", () => {
    const proxy = Proxy.revocable<Record<string, unknown>>({}, {});
    proxy.revoke();
    const store = createTransientExecutionContextStore();

    expect(() => store.set("run-1", proxy.proxy)).not.toThrow();
    expect(store.set("run-1", proxy.proxy)).toBe(false);
    expect(store.size).toBe(0);
    store.clear();
  });

  it("rejects custom toJSON hooks without invoking them", () => {
    const toJSON = vi.fn(() => ({ substituted: true }));
    const store = createTransientExecutionContextStore();

    expect(store.set("run-1", { benign: true, toJSON })).toBe(false);
    expect(toJSON).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    store.clear();
  });

  it.each([
    ["depth", { maxDepth: 1 }, { nested: { value: true } }],
    ["node count", { maxNodes: 2 }, { first: 1, second: 2 }],
    ["property count", { maxProperties: 1 }, { first: 1, second: 2 }],
    ["array length", { maxArrayLength: 1 }, { values: [1, 2] }],
  ])("fails closed when the %s structural limit is exceeded", (_label, options, value) => {
    const store = createTransientExecutionContextStore(options);

    expect(store.set("run-1", value)).toBe(false);
    expect(store.size).toBe(0);
    store.clear();
  });

  it("rejects an object as soon as its property limit is exceeded", () => {
    const store = createTransientExecutionContextStore({ maxProperties: 2 });
    const context = Object.fromEntries(
      Array.from({ length: 1_000 }, (_value, index) => [`property-${index}`, index]),
    );

    expect(store.set("run-1", context)).toBe(false);
    expect(store.size).toBe(0);
    store.clear();
  });

  it("does not materialize an unbounded own-key list from raw input", () => {
    const ownKeys = vi.spyOn(Reflect, "ownKeys").mockImplementation(() => {
      throw new Error("raw own-key lists are forbidden");
    });
    const store = createTransientExecutionContextStore();

    try {
      expect(store.set("run-1", { safe: true })).toBe(true);
      expect(store.get("run-1")).toEqual({ safe: true });
      expect(ownKeys).not.toHaveBeenCalled();
    } finally {
      ownKeys.mockRestore();
      store.clear();
    }
  });

  it("preserves bounded dense arrays", () => {
    const store = createTransientExecutionContextStore();
    const context = { values: ["one", { nested: "two" }, null] };

    expect(store.set("run-1", context)).toBe(true);
    expect(store.take("run-1")).toEqual(context);
    store.clear();
  });

  it("expires entries at their absolute TTL with one managed timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = createTransientExecutionContextStore({ ttlMs: 100 });

    expect(store.set("run-1", { order: 1 })).toBe(true);
    vi.advanceTimersByTime(25);
    expect(store.set("run-2", { order: 2 })).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(74);
    expect(store.get("run-1")).toEqual({ order: 1 });
    vi.advanceTimersByTime(1);
    expect(store.get("run-1")).toBeUndefined();
    expect(store.get("run-2")).toEqual({ order: 2 });
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(25);
    expect(store.size).toBe(0);
    expect(store.bytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes an entry atomically", () => {
    const store = createTransientExecutionContextStore();
    expect(store.set("run-1", { command: "execute" })).toBe(true);

    expect(store.take("run-1")).toEqual({ command: "execute" });
    expect(store.take("run-1")).toBeUndefined();
    expect(store.size).toBe(0);
    expect(store.bytes).toBe(0);
    store.clear();
  });

  it("does not evict committed entries when a reservation cannot fit", () => {
    const baseContext = { command: "base" };
    const pendingContext = { command: "pending" };
    const committedContext = { command: "committed" };
    const rejectedContext = { command: "candidate-too-large" };
    const store = createTransientExecutionContextStore({
      maxTotalBytes:
        serializedBytes(baseContext) +
        serializedBytes(pendingContext) +
        serializedBytes(committedContext),
    });

    expect(store.set("reserved-run", baseContext)).toBe(true);
    expect(store.set("committed-run", committedContext)).toBe(true);
    const pending = store.stage("reserved-run", pendingContext);
    expect(pending).not.toBeNull();
    const bytesBeforeRejectedStage = store.bytes;

    expect(store.stage("rejected-run", rejectedContext)).toBeNull();

    expect(store.get("reserved-run")).toEqual(pendingContext);
    expect(store.get("committed-run")).toEqual(committedContext);
    expect(store.get("rejected-run")).toBeUndefined();
    expect(store.bytes).toBe(bytesBeforeRejectedStage);
    store.clear();
  });

  it("does not let an older rollback clobber a newer committed reservation", () => {
    const store = createTransientExecutionContextStore();
    expect(store.set("run-1", { command: "previous" })).toBe(true);

    const older = store.stage("run-1", { command: "older" });
    const newer = store.stage("run-1", { command: "newer" });
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();

    newer!.commit();
    older!.rollback();

    expect(store.get("run-1")).toEqual({ command: "newer" });
    store.clear();
  });

  it("does not resurrect a staged or prior context after a consumer takes it", () => {
    const store = createTransientExecutionContextStore();
    expect(store.set("run-1", { command: "previous" })).toBe(true);
    const reservation = store.stage("run-1", { command: "staged" });
    expect(reservation).not.toBeNull();

    expect(store.take("run-1")).toEqual({ command: "staged" });
    reservation!.rollback();

    expect(store.get("run-1")).toBeUndefined();
    store.clear();
  });

  it("restores a prior context with its original absolute expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = createTransientExecutionContextStore({ ttlMs: 100 });
    expect(store.set("run-1", { command: "previous" })).toBe(true);

    vi.advanceTimersByTime(50);
    const reservation = store.stage("run-1", { command: "staged" });
    expect(reservation).not.toBeNull();
    reservation!.rollback();

    vi.advanceTimersByTime(49);
    expect(store.get("run-1")).toEqual({ command: "previous" });
    vi.advanceTimersByTime(1);
    expect(store.get("run-1")).toBeUndefined();
  });

  it("skips rolled-back predecessors when overlapping reservations unwind", () => {
    const store = createTransientExecutionContextStore();
    expect(store.set("run-1", { command: "previous" })).toBe(true);
    const older = store.stage("run-1", { command: "older" });
    const newer = store.stage("run-1", { command: "newer" });
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();

    older!.rollback();
    newer!.rollback();

    expect(store.get("run-1")).toEqual({ command: "previous" });
    store.clear();
  });

  it("expires hidden reservation history at its own deadline without resurrection", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const store = createTransientExecutionContextStore({ ttlMs: 100 });
    const previous = { command: "previous-secret" };
    const olderContext = { command: "older-secret" };
    const newerContext = { command: "newer" };

    expect(store.set("run-1", previous)).toBe(true);
    vi.advanceTimersByTime(50);
    const older = store.stage("run-1", olderContext);
    vi.advanceTimersByTime(40);
    const newer = store.stage("run-1", newerContext);
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();

    vi.advanceTimersByTime(61);
    expect(store.get("run-1")).toEqual(newerContext);
    expect(store.bytes).toBe(serializedBytes(newerContext));

    older!.rollback();
    newer!.rollback();
    expect(store.get("run-1")).toBeUndefined();
    expect(store.bytes).toBe(0);
    store.clear();
  });
});
