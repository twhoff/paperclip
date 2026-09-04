import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalFileRunLogStore } from "../services/run-log-store.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((cleanupPath) =>
      rm(cleanupPath, { recursive: true, force: true }),
    ),
  );
});

describe("run log store bounds", () => {
  it("returns exact zero-byte, EOF, and one-byte plain ranges", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-"));
    cleanupPaths.push(basePath);
    const store = createLocalFileRunLogStore({ basePath, compressOnFinalize: false });
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-range",
    });
    await store.append(handle, {
      stream: "stdout",
      chunk: "hello",
      ts: "2026-09-05T00:00:00.000Z",
    });
    const full = await store.read(handle, { offset: 0, limitBytes: 4_096 });
    const size = Buffer.byteLength(full.content, "utf8");

    await expect(store.read(handle, { offset: 0, limitBytes: 0 })).resolves.toEqual({
      content: "",
      nextOffset: 0,
    });
    await expect(store.read(handle, { offset: size, limitBytes: 1 })).resolves.toEqual({
      content: "",
      nextOffset: undefined,
    });
    await expect(store.read(handle, { offset: 0, limitBytes: 1 })).resolves.toEqual({
      content: "{",
      nextOffset: 1,
    });
  });

  it("reserves room for the truncation record inside the run cap", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-"));
    cleanupPaths.push(basePath);
    const store = createLocalFileRunLogStore({
      basePath,
      maxRunBytes: 1_024,
      compressOnFinalize: false,
    });
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    await store.append(handle, {
      stream: "stdout",
      chunk: "a".repeat(850),
      ts: "2026-09-05T00:00:00.000Z",
    });
    await store.append(handle, {
      stream: "stderr",
      chunk: "b".repeat(850),
      ts: "2026-09-05T00:00:01.000Z",
    });

    const result = await store.read(handle, { offset: 0, limitBytes: 4_096 });
    const records = result.content.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      stream: "system",
      chunk: "[run-log truncated: exceeded 1,024 bytes]",
    });
    expect(records.filter((record) => record.stream === "system")).toHaveLength(1);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("stops gzip decompression after the requested bounded range", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-gzip-"));
    cleanupPaths.push(basePath);
    const store = createLocalFileRunLogStore({ basePath });
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-gzip",
    });
    const plainPath = path.join(basePath, handle.logRef);
    const source = `${JSON.stringify({
      stream: "stdout",
      chunk: "a".repeat(100_000),
    })}\n`;
    await rm(plainPath);
    await writeFile(
      `${plainPath}.gz`,
      Buffer.concat([
        gzipSync(Buffer.from(source, "utf8")),
        Buffer.from("invalid trailing gzip member", "utf8"),
      ]),
    );

    const result = await store.read(handle, { offset: 0, limitBytes: 64 });

    expect(Buffer.byteLength(result.content, "utf8")).toBe(64);
    expect(result.nextOffset).toBe(64);
  });

  it("serializes concurrent appends so they cannot bypass the run cap", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-"));
    cleanupPaths.push(basePath);
    const store = createLocalFileRunLogStore({
      basePath,
      maxRunBytes: 1_024,
      compressOnFinalize: false,
    });
    const handle = await store.begin({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-concurrent",
    });

    await Promise.all([
      store.append(handle, {
        stream: "stdout",
        chunk: "a".repeat(600),
        ts: "2026-09-05T00:00:00.000Z",
      }),
      store.append(handle, {
        stream: "stderr",
        chunk: "b".repeat(600),
        ts: "2026-09-05T00:00:01.000Z",
      }),
    ]);

    const result = await store.read(handle, { offset: 0, limitBytes: 4_096 });
    const records = result.content.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.stream === "system")).toHaveLength(1);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(1_024);
  });
});
