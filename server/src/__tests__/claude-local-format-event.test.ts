import { describe, it, expect } from "vitest";
import {
  filterClaudeStreamLine,
  createClaudeLogFilter,
} from "@paperclipai/adapter-claude-local/server";

describe("filterClaudeStreamLine", () => {
  it("passes system/init events through unchanged so the UI parser can structure them", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
      model: "claude-opus-4-7[1m]",
    });
    expect(filterClaudeStreamLine(line)).toBe(line);
  });

  it("passes hook_started / hook_response events through unchanged", () => {
    const started = JSON.stringify({
      type: "system",
      subtype: "hook_started",
      hook_name: "SessionStart:resume",
    });
    const response = JSON.stringify({
      type: "system",
      subtype: "hook_response",
      hook_name: "SessionStart:resume",
      exit_code: 0,
    });
    expect(filterClaudeStreamLine(started)).toBe(started);
    expect(filterClaudeStreamLine(response)).toBe(response);
  });

  it("passes assistant events through unchanged", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    });
    expect(filterClaudeStreamLine(line)).toBe(line);
  });

  it("passes user (tool_result replay) events through unchanged", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "ok", is_error: false }],
      },
    });
    expect(filterClaudeStreamLine(line)).toBe(line);
  });

  it("passes result events through unchanged", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.0034,
    });
    expect(filterClaudeStreamLine(line)).toBe(line);
  });

  it("suppresses stream_event chunks (the partial-message flood)", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: "cd \"" },
      },
    });
    expect(filterClaudeStreamLine(line)).toBeNull();
  });

  it("suppresses stream_event text deltas", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hel" },
      },
    });
    expect(filterClaudeStreamLine(line)).toBeNull();
  });

  it("strips a trailing newline from the input but keeps the JSON intact", () => {
    const json = JSON.stringify({ type: "system", subtype: "init" });
    expect(filterClaudeStreamLine(`${json}\n`)).toBe(json);
  });

  it("passes non-JSON paperclip log lines through unchanged", () => {
    expect(filterClaudeStreamLine("[paperclip] Loaded agent instructions file: /tmp/x.md")).toBe(
      "[paperclip] Loaded agent instructions file: /tmp/x.md",
    );
  });

  it("returns null for empty / whitespace-only lines", () => {
    expect(filterClaudeStreamLine("")).toBeNull();
    expect(filterClaudeStreamLine("   ")).toBeNull();
    expect(filterClaudeStreamLine("\n")).toBeNull();
  });
});

describe("createClaudeLogFilter", () => {
  it("buffers stdout chunks and emits one raw JSON line per object, dropping stream_event", async () => {
    const captured: { stream: string; chunk: string }[] = [];
    const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
      captured.push({ stream, chunk });
    };
    const filter = createClaudeLogFilter(onLog);

    const event1 = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });
    const event2 = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
    });
    const event3 = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    });

    // Simulate the chunked nature of stdout: split mid-line.
    await filter.onLog("stdout", `${event1}\n${event2}\n`);
    await filter.onLog("stdout", `${event3.slice(0, 20)}`);
    await filter.onLog("stdout", `${event3.slice(20)}\n`);
    await filter.flush();

    const stdoutChunks = captured.filter((c) => c.stream === "stdout");
    expect(stdoutChunks).toHaveLength(2);
    expect(stdoutChunks[0].chunk).toBe(`${event1}\n`);
    expect(stdoutChunks[1].chunk).toBe(`${event3}\n`);
  });

  it("forwards stderr unchanged", async () => {
    const captured: { stream: string; chunk: string }[] = [];
    const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
      captured.push({ stream, chunk });
    };
    const filter = createClaudeLogFilter(onLog);

    await filter.onLog("stderr", "raw stderr line\n");
    expect(captured).toEqual([{ stream: "stderr", chunk: "raw stderr line\n" }]);
  });

  it("flushes a trailing partial line that did not end with newline", async () => {
    const captured: { stream: string; chunk: string }[] = [];
    const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
      captured.push({ stream, chunk });
    };
    const filter = createClaudeLogFilter(onLog);

    const event = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });
    await filter.onLog("stdout", event); // no newline
    expect(captured).toHaveLength(0);
    await filter.flush();
    expect(captured).toHaveLength(1);
    expect(captured[0].chunk).toBe(`${event}\n`);
  });
});
