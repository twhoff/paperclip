import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalFileWorkspaceOperationLogStore } from "../services/workspace-operation-log-store.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((cleanupPath) =>
      rm(cleanupPath, { recursive: true, force: true }),
    ),
  );
});

describe("workspace operation log store", () => {
  it("discards an orphaned log and remains idempotent", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-log-"));
    cleanupPaths.push(basePath);
    const store = createLocalFileWorkspaceOperationLogStore({ basePath });
    const handle = await store.begin({
      companyId: "company-1",
      operationId: "orphaned-operation",
    });

    await store.discard(handle);

    await expect(store.read(handle)).rejects.toThrow("Workspace operation log not found");
    await expect(store.discard(handle)).resolves.toBeUndefined();
  });

  it("returns exact zero-byte, EOF, and one-byte ranges", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-log-"));
    cleanupPaths.push(basePath);
    const store = createLocalFileWorkspaceOperationLogStore({ basePath });
    const handle = await store.begin({ companyId: "company-1", operationId: "operation-range" });
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

  it("caps future log writes and emits one truncation record", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-log-"));
    cleanupPaths.push(basePath);
    const store = createLocalFileWorkspaceOperationLogStore({
      basePath,
      maxOperationBytes: 1_024,
    });
    const handle = await store.begin({ companyId: "company-1", operationId: "operation-1" });

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
    await store.append(handle, {
      stream: "stderr",
      chunk: "c".repeat(850),
      ts: "2026-09-05T00:00:02.000Z",
    });

    const result = await store.read(handle, { offset: 0, limitBytes: 4_096 });
    const records = result.content.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      stream: "system",
      chunk: "[workspace-operation-log truncated: exceeded 1,024 bytes]",
    });
    expect(records.filter((record) => record.stream === "system")).toHaveLength(1);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("serializes concurrent appends so they cannot bypass the cap", async () => {
    const basePath = await mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-log-"));
    cleanupPaths.push(basePath);
    const store = createLocalFileWorkspaceOperationLogStore({
      basePath,
      maxOperationBytes: 1_024,
    });
    const handle = await store.begin({ companyId: "company-1", operationId: "operation-2" });

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
