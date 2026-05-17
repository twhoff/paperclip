import { describe, expect, it } from "vitest";
import {
  createRunActivityRegistry,
  chunkHasMeaningfulActivity,
  isMeaningfulAdapterStreamLine,
} from "../services/run-activity-registry.ts";

describe("isMeaningfulAdapterStreamLine", () => {
  it("treats Claude assistant turns as meaningful", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    });
    expect(isMeaningfulAdapterStreamLine("stdout", line)).toEqual({
      meaningful: true,
      kind: "assistant",
    });
  });

  it("treats Claude tool_result user injections as meaningful", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
    });
    expect(isMeaningfulAdapterStreamLine("stdout", line).meaningful).toBe(true);
  });

  it("treats Claude system:init as meaningful but other system subtypes as noise", () => {
    expect(
      isMeaningfulAdapterStreamLine("stdout", JSON.stringify({ type: "system", subtype: "init" })),
    ).toEqual({ meaningful: true, kind: "system:init" });
    expect(
      isMeaningfulAdapterStreamLine("stdout", JSON.stringify({ type: "system", subtype: "requesting" })),
    ).toEqual({ meaningful: false });
    expect(
      isMeaningfulAdapterStreamLine("stdout", JSON.stringify({ type: "system" })),
    ).toEqual({ meaningful: false });
  });

  it("treats Codex item events as meaningful", () => {
    for (const type of ["thread.started", "turn.started", "item.started", "item.completed"]) {
      expect(
        isMeaningfulAdapterStreamLine("stdout", JSON.stringify({ type })).meaningful,
      ).toBe(true);
    }
  });

  it("rejects Claude stream_event (partial-message flood)", () => {
    expect(
      isMeaningfulAdapterStreamLine("stdout", JSON.stringify({ type: "stream_event", index: 3 })),
    ).toEqual({ meaningful: false });
  });

  it("rejects stderr lines unconditionally", () => {
    const line = JSON.stringify({ type: "assistant" });
    expect(isMeaningfulAdapterStreamLine("stderr", line)).toEqual({ meaningful: false });
  });

  it("rejects non-JSON or empty lines", () => {
    expect(isMeaningfulAdapterStreamLine("stdout", "")).toEqual({ meaningful: false });
    expect(isMeaningfulAdapterStreamLine("stdout", "  ")).toEqual({ meaningful: false });
    expect(isMeaningfulAdapterStreamLine("stdout", "not json")).toEqual({ meaningful: false });
    expect(isMeaningfulAdapterStreamLine("stdout", "[1,2,3]")).toEqual({ meaningful: false });
  });

  it("rejects codex_models_manager refresh errors on stdout (no JSON type)", () => {
    // Mimics a recurring noise line that could appear on either stream.
    const line = "codex_models_manager: refresh failed: ETIMEDOUT";
    expect(isMeaningfulAdapterStreamLine("stdout", line)).toEqual({ meaningful: false });
    expect(isMeaningfulAdapterStreamLine("stderr", line)).toEqual({ meaningful: false });
  });

  it("rejects unknown event types", () => {
    expect(
      isMeaningfulAdapterStreamLine("stdout", JSON.stringify({ type: "sys/requesting" })),
    ).toEqual({ meaningful: false });
    expect(
      isMeaningfulAdapterStreamLine("stdout", JSON.stringify({ type: "ping" })),
    ).toEqual({ meaningful: false });
  });
});

describe("chunkHasMeaningfulActivity", () => {
  it("returns true if any line in a multi-line chunk is meaningful", () => {
    const chunk = [
      "not json",
      JSON.stringify({ type: "stream_event" }),
      JSON.stringify({ type: "assistant", message: {} }),
      "",
    ].join("\n");
    expect(chunkHasMeaningfulActivity("stdout", chunk).meaningful).toBe(true);
  });

  it("returns false on a chunk that is only noise", () => {
    const chunk = [
      "codex_models_manager: refresh failed",
      JSON.stringify({ type: "stream_event" }),
      JSON.stringify({ type: "system", subtype: "requesting" }),
    ].join("\n");
    expect(chunkHasMeaningfulActivity("stdout", chunk).meaningful).toBe(false);
  });

  it("always returns false for stderr chunks", () => {
    const chunk = JSON.stringify({ type: "assistant" });
    expect(chunkHasMeaningfulActivity("stderr", chunk).meaningful).toBe(false);
  });
});

describe("createRunActivityRegistry", () => {
  it("returns null for unknown runs", () => {
    const reg = createRunActivityRegistry();
    expect(reg.get("missing")).toBeNull();
  });

  it("records stream activity and reports it as last source", () => {
    const reg = createRunActivityRegistry();
    const t = new Date("2026-05-17T10:00:00.000Z");
    reg.record("r1", "stream", t);
    const snap = reg.get("r1");
    expect(snap?.lastActivitySource).toBe("stream");
    expect(snap?.lastActivityAt.toISOString()).toBe(t.toISOString());
    expect(snap?.dbEventAt).toBeNull();
  });

  it("records db_event activity independently from stream", () => {
    const reg = createRunActivityRegistry();
    const tStream = new Date("2026-05-17T10:00:00.000Z");
    const tDb = new Date("2026-05-17T10:05:00.000Z");
    reg.record("r1", "stream", tStream);
    reg.record("r1", "db_event", tDb);
    const snap = reg.get("r1");
    expect(snap?.lastActivitySource).toBe("db_event");
    expect(snap?.lastActivityAt.toISOString()).toBe(tDb.toISOString());
    expect(snap?.streamAt?.toISOString()).toBe(tStream.toISOString());
  });

  it("never moves a per-source timestamp backwards", () => {
    const reg = createRunActivityRegistry();
    const newer = new Date("2026-05-17T10:05:00.000Z");
    const older = new Date("2026-05-17T10:00:00.000Z");
    reg.record("r1", "stream", newer);
    reg.record("r1", "stream", older);
    const snap = reg.get("r1");
    expect(snap?.streamAt?.toISOString()).toBe(newer.toISOString());
  });

  it("clears an entry on terminal status", () => {
    const reg = createRunActivityRegistry();
    reg.record("r1", "stream");
    expect(reg.size()).toBe(1);
    reg.clear("r1");
    expect(reg.size()).toBe(0);
    expect(reg.get("r1")).toBeNull();
  });

  it("ignores NaN timestamps", () => {
    const reg = createRunActivityRegistry();
    reg.record("r1", "stream", new Date("not-a-date"));
    expect(reg.get("r1")).toBeNull();
  });
});
