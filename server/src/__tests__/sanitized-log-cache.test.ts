import { describe, expect, it, vi } from "vitest";
import { CompiledSensitiveValueMatchers } from "@paperclipai/adapter-utils/server-utils";
import { SECRET_REDACTION_TOKEN } from "../log-redaction.js";
import {
  MAX_SANITIZED_LOG_PAGE_BYTES,
  SANITIZED_LOG_STALE_MESSAGE,
  SANITIZED_LOG_OVERSIZE_MESSAGE,
  createSanitizedNdjsonLogCache,
  type SanitizedLogSource,
} from "../services/sanitized-log-cache.js";

function source(logRef: string): SanitizedLogSource {
  return {
    namespace: "test",
    owner: {},
    logRef,
  };
}

describe("sanitized NDJSON log cache", () => {
  it("reads and redacts a split credential once across pagination pages", async () => {
    const cache = createSanitizedNdjsonLogCache({
      maxSourceBytes: 4_096,
      maxCachedBytes: 8_192,
    });
    const token =
      "eyJhbGciOiJIUzI1NiJ9.eyJydW5JZCI6InJ1bi1jYWNoZWQifQ.signature_value";
    const splitAt = token.indexOf("signature_value");
    const stored = [
      JSON.stringify({ ts: "1", stream: "stdout", chunk: `before:${token.slice(0, splitAt)}` }),
      JSON.stringify({ ts: "2", stream: "stderr", chunk: "unrelated" }),
      JSON.stringify({ ts: "3", stream: "stdout", chunk: `${token.slice(splitAt)}:after` }),
    ].join("\n") + "\n";
    const readSource = vi.fn(async () => ({ content: stored }));
    const logSource = source("split.ndjson");

    let offset = 0;
    let reconstructed = "";
    do {
      const page = await cache.read({
        source: logSource,
        readSource,
        range: { offset, limitBytes: 19 },
        redactionOptions: { enabled: false },
      });
      reconstructed += page.content;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    } while (true);

    expect(readSource).toHaveBeenCalledTimes(1);
    expect(reconstructed).toContain(SECRET_REDACTION_TOKEN);
    expect(reconstructed).not.toContain(token);
    expect(reconstructed).not.toContain("hbGci");
    expect(reconstructed).not.toContain("signature_value");
  });

  it("deduplicates concurrent sanitized-log generation", async () => {
    const cache = createSanitizedNdjsonLogCache({ maxSourceBytes: 1_024 });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readSource = vi.fn(async () => {
      await wait;
      return { content: `${JSON.stringify({ stream: "stdout", chunk: "safe" })}\n` };
    });
    const logSource = source("concurrent.ndjson");

    const first = cache.read({ source: logSource, readSource, range: { limitBytes: 8 } });
    const second = cache.read({
      source: logSource,
      readSource,
      range: { offset: 8, limitBytes: 8 },
    });
    await vi.waitFor(() => expect(readSource).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    expect(readSource).toHaveBeenCalledTimes(1);
  });

  it("serializes generation for distinct logs to bound aggregate memory", async () => {
    const cache = createSanitizedNdjsonLogCache({
      maxSourceBytes: 1_024,
      maxConcurrentGenerations: 1,
    });
    let releaseFirst!: () => void;
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstRead = vi.fn(async () => {
      await firstWait;
      return { content: `${JSON.stringify({ stream: "stdout", chunk: "first" })}\n` };
    });
    const secondRead = vi.fn(async () => ({
      content: `${JSON.stringify({ stream: "stdout", chunk: "second" })}\n`,
    }));

    const first = cache.read({ source: source("serialized-first.ndjson"), readSource: firstRead });
    const second = cache.read({ source: source("serialized-second.ndjson"), readSource: secondRead });
    await vi.waitFor(() => expect(firstRead).toHaveBeenCalledTimes(1));
    expect(secondRead).not.toHaveBeenCalled();
    releaseFirst();
    await Promise.all([first, second]);

    expect(secondRead).toHaveBeenCalledTimes(1);
  });

  it("retries generation invalidated while an active log changes", async () => {
    const cache = createSanitizedNdjsonLogCache({ maxSourceBytes: 1_024 });
    let releaseFirst!: () => void;
    const firstWait = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const readSource = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await firstWait;
      return {
        content: `${JSON.stringify({
          stream: "stdout",
          chunk: calls === 1 ? "stale" : "fresh",
        })}\n`,
      };
    });
    const logSource = source("active.ndjson");

    const read = cache.read({ source: logSource, readSource });
    await vi.waitFor(() => expect(readSource).toHaveBeenCalledTimes(1));
    cache.invalidate(logSource);
    releaseFirst();
    const result = await read;

    expect(readSource).toHaveBeenCalledTimes(2);
    expect(result.content).toContain("fresh");
    expect(result.content).not.toContain("stale");
  });

  it("bounds regeneration when an active log changes continuously", async () => {
    const cache = createSanitizedNdjsonLogCache({ maxSourceBytes: 1_024 });
    const logSource = source("continuously-changing.ndjson");
    const readSource = vi.fn(async () => {
      await Promise.resolve();
      cache.invalidate(logSource);
      return {
        content: `${JSON.stringify({ stream: "stdout", chunk: "sensitive snapshot" })}\n`,
      };
    });

    const result = await cache.read({ source: logSource, readSource });

    expect(readSource).toHaveBeenCalledTimes(2);
    expect(result.nextOffset).toBeUndefined();
    expect(result.content).toContain(SANITIZED_LOG_STALE_MESSAGE);
    expect(result.content).not.toContain("sensitive snapshot");
  });

  it("fails closed and caches only a safe notice for an oversized source", async () => {
    const cache = createSanitizedNdjsonLogCache({
      maxSourceBytes: 64,
      maxCachedBytes: 128,
    });
    const readSource = vi.fn(async (options: { offset: number; limitBytes: number }) => {
      expect(options).toEqual({ offset: 0, limitBytes: 65 });
      return {
        content: "sensitive".repeat(9),
        nextOffset: 65,
      };
    });
    const logSource = source("oversized.ndjson");

    const result = await cache.read({ source: logSource, readSource });
    const repeated = await cache.read({ source: logSource, readSource });

    expect(result.nextOffset).toBeUndefined();
    expect(result.content).toContain(SANITIZED_LOG_OVERSIZE_MESSAGE);
    expect(result.content).not.toContain("sensitive");
    expect(() => JSON.parse(result.content.trim())).not.toThrow();
    expect(repeated).toEqual(result);
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  it("bounds sanitized output expansion before caching a near-limit source", async () => {
    const maxSourceBytes = 4_096;
    const cache = createSanitizedNdjsonLogCache({
      maxSourceBytes,
      maxCachedBytes: maxSourceBytes * 2,
    });
    const prefix = `${JSON.stringify({ stream: "stdout", chunk: "" }).slice(0, -2)}`;
    const suffix = `"}\n`;
    const chunkLength = maxSourceBytes - prefix.length - suffix.length;
    const expandingChunk = "x,".repeat(Math.ceil(chunkLength / 2)).slice(0, chunkLength);
    const stored = `${prefix}${expandingChunk}${suffix}`;
    const readSource = vi.fn(async () => ({ content: stored }));

    expect(Buffer.byteLength(stored, "utf8")).toBe(maxSourceBytes);
    const result = await cache.read({
      source: source("expanding.ndjson"),
      readSource,
      redactionOptions: {
        enabled: false,
        secretValues: ["x"],
        compiledSecretMatchers: new CompiledSensitiveValueMatchers(["x"]),
      },
    });

    expect(result.nextOffset).toBeUndefined();
    expect(result.content).toContain(SANITIZED_LOG_OVERSIZE_MESSAGE);
      expect(result.content).not.toContain(expandingChunk.slice(0, 32));
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used sanitized entry at the entry bound", async () => {
    const cache = createSanitizedNdjsonLogCache({
      maxSourceBytes: 1_024,
      maxCachedBytes: 4_096,
      maxEntries: 2,
    });
    const sources = {
      first: source("first.ndjson"),
      second: source("second.ndjson"),
      third: source("third.ndjson"),
    };
    const reads = new Map<string, number>();
    const read = (name: keyof typeof sources) => cache.read({
      source: sources[name],
      readSource: async () => {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return {
          content: `${JSON.stringify({ stream: "stdout", chunk: name })}\n`,
        };
      },
    });

    await read("first");
    await read("second");
    await read("first");
    await read("third");
    await read("second");

    expect(Object.fromEntries(reads)).toEqual({ first: 1, second: 2, third: 1 });
  });

  it("caps every response page without rebuilding the sanitized entry", async () => {
    const cache = createSanitizedNdjsonLogCache({
      maxSourceBytes: MAX_SANITIZED_LOG_PAGE_BYTES * 2,
      maxCachedBytes: MAX_SANITIZED_LOG_PAGE_BYTES * 2,
    });
    const stored = `${JSON.stringify({
      stream: "stdout",
      chunk: "x".repeat(MAX_SANITIZED_LOG_PAGE_BYTES + 1_024),
    })}\n`;
    const readSource = vi.fn(async () => ({ content: stored }));
    const logSource = source("bounded-page.ndjson");

    const first = await cache.read({
      source: logSource,
      readSource,
      range: { limitBytes: Number.MAX_SAFE_INTEGER },
    });
    const second = await cache.read({
      source: logSource,
      readSource,
      range: { offset: first.nextOffset, limitBytes: Number.MAX_SAFE_INTEGER },
    });

    expect(Buffer.byteLength(first.content, "utf8")).toBe(MAX_SANITIZED_LOG_PAGE_BYTES);
    expect(first.nextOffset).toBe(MAX_SANITIZED_LOG_PAGE_BYTES);
    expect(second.nextOffset).toBeUndefined();
    expect(readSource).toHaveBeenCalledTimes(1);
  });

  it("regenerates when exact redaction values rotate", async () => {
    const cache = createSanitizedNdjsonLogCache({ maxSourceBytes: 1_024 });
    const stored = `${JSON.stringify({
      stream: "stdout",
      chunk: "first-control-secret second-control-secret",
    })}\n`;
    const readSource = vi.fn(async () => ({ content: stored }));
    const logSource = source("rotated-secret.ndjson");

    const first = await cache.read({
      source: logSource,
      readSource,
      redactionOptions: {
        enabled: false,
        secretValues: ["first-control-secret"],
      },
    });
    const second = await cache.read({
      source: logSource,
      readSource,
      redactionOptions: {
        enabled: false,
        secretValues: ["second-control-secret"],
      },
    });

    expect(first.content).not.toContain("first-control-secret");
    expect(second.content).not.toContain("second-control-secret");
    expect(readSource).toHaveBeenCalledTimes(2);
  });

  it("separates fail-closed overflow entries from ordinary redaction in both cache orders", async () => {
    for (const overflowFirst of [false, true]) {
      const cache = createSanitizedNdjsonLogCache({ maxSourceBytes: 1_024 });
      const stored = `${JSON.stringify({ stream: "stdout", chunk: "ordinary text" })}\n`;
      const readSource = vi.fn(async () => ({ content: stored }));
      const logSource = source(`overflow-${overflowFirst ? "first" : "last"}.ndjson`);
      const read = (secretValuesOverflow: boolean) => cache.read({
        source: logSource,
        readSource,
        redactionOptions: {
          enabled: false,
          secretValues: ["unused-secret"],
          secretValuesOverflow,
          compiledSecretMatchers: new CompiledSensitiveValueMatchers(["unused-secret"]),
        },
      });

      const first = await read(overflowFirst);
      const second = await read(!overflowFirst);
      const overflow = overflowFirst ? first : second;
      const ordinary = overflowFirst ? second : first;

      expect(overflow.content).toContain(SECRET_REDACTION_TOKEN);
      expect(overflow.content).not.toContain("ordinary text");
      expect(ordinary.content).toContain("ordinary text");
      expect(readSource).toHaveBeenCalledTimes(2);
    }
  });

  it("regenerates when a current process control-plane secret rotates", async () => {
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const cache = createSanitizedNdjsonLogCache({ maxSourceBytes: 1_024 });
    const stored = `${JSON.stringify({
      stream: "stdout",
      chunk: "first-process-secret second-process-secret",
    })}\n`;
    const readSource = vi.fn(async () => ({ content: stored }));
    const logSource = source("rotated-process-secret.ndjson");

    try {
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "first-process-secret";
      const first = await cache.read({ source: logSource, readSource });

      process.env.PAPERCLIP_AGENT_JWT_SECRET = "second-process-secret";
      const second = await cache.read({ source: logSource, readSource });

      expect(first.content).not.toContain("first-process-secret");
      expect(second.content).not.toContain("second-process-secret");
      expect(readSource).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  });

  it("drops cached entries when retention invalidates their namespace", async () => {
    const cache = createSanitizedNdjsonLogCache({ maxSourceBytes: 1_024 });
    const stored = `${JSON.stringify({ stream: "stdout", chunk: "safe" })}\n`;
    const readSource = vi.fn(async () => ({ content: stored }));
    const logSource = source("pruned.ndjson");

    await cache.read({ source: logSource, readSource });
    await cache.read({ source: logSource, readSource });
    expect(readSource).toHaveBeenCalledTimes(1);

    cache.invalidateNamespace("test");
    readSource.mockRejectedValueOnce(new Error("source pruned"));

    await expect(cache.read({ source: logSource, readSource })).rejects.toThrow(
      "source pruned",
    );
    expect(readSource).toHaveBeenCalledTimes(2);
  });
});
