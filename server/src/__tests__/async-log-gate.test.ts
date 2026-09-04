import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAsyncLogGate } from "../services/async-log-gate.ts";
import { createLocalFileRunLogStore } from "../services/run-log-store.ts";

describe("createAsyncLogGate", () => {
  it("drains accepted writes and rejects late writes before a run log is finalized", async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-gate-"));
    const store = createLocalFileRunLogStore({ basePath, compressOnFinalize: true });
    const handle = await store.begin({ companyId: "company", agentId: "agent", runId: "run" });
    const gate = createAsyncLogGate();

    const accepted = gate.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await store.append(handle, {
        stream: "stdout",
        chunk: "accepted\n",
        ts: new Date().toISOString(),
      });
    });
    const close = gate.closeAndDrain();

    await expect(accepted).resolves.toBe(true);
    await close;
    await expect(
      gate.run(() =>
        store.append(handle, {
          stream: "stdout",
          chunk: "too-late\n",
          ts: new Date().toISOString(),
        }),
      ),
    ).resolves.toBe(false);

    await store.finalize(handle);
    const plainPath = path.join(basePath, handle.logRef);
    await expect(fs.stat(plainPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${plainPath}.gz`)).resolves.toBeDefined();
    const result = await store.read(handle);
    expect(result.content).toContain("accepted");
    expect(result.content).not.toContain("too-late");
  });

  it("serializes accepted work and surfaces the first write failure when drained", async () => {
    const order: string[] = [];
    const gate = createAsyncLogGate();

    const first = gate.run(async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first:end");
    });
    const second = gate.run(async () => {
      order.push("second");
      throw new Error("write failed");
    });

    await expect(first).resolves.toBe(true);
    await expect(second).rejects.toThrow("write failed");
    await expect(gate.closeAndDrain()).rejects.toThrow("write failed");
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
