import { describe, it, expect } from "vitest";
import {
  formatClaudeStreamLine,
  createClaudeLogFilter,
} from "@paperclipai/adapter-claude-local/server";

describe("formatClaudeStreamLine", () => {
  it("formats system/init events with session and model", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "abc-123",
      model: "claude-opus-4-7[1m]",
      tools: [{}, {}, {}],
    });
    expect(formatClaudeStreamLine(line)).toBe(
      "[claude] init session=abc-123 model=claude-opus-4-7[1m] tools=3",
    );
  });

  it("formats assistant text content", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello there!" }],
      },
    });
    expect(formatClaudeStreamLine(line)).toBe("[assistant] Hello there!");
  });

  it("formats assistant tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "ls -la" },
          },
        ],
      },
    });
    const out = formatClaudeStreamLine(line);
    expect(out).toContain("[assistant] Let me check.");
    expect(out).toContain('[tool_use Bash] {"command":"ls -la"}');
  });

  it("formats user tool_result content", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: "file1.txt\nfile2.txt",
            is_error: false,
          },
        ],
      },
    });
    expect(formatClaudeStreamLine(line)).toBe("[tool_result] file1.txt\nfile2.txt");
  });

  it("formats result events with cost and tokens", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.00345,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 },
      result: "Final answer.",
    });
    const out = formatClaudeStreamLine(line);
    expect(out).toContain("[result] success tokens in=100 out=50 cached=80 cost=$0.0034");
    expect(out).toContain("[final] Final answer.");
  });

  it("suppresses stream_event chunks (the partial-message flood)", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: 'cd "/tmp"' },
      },
      session_id: "abc-123",
      uuid: "deadbeef",
    });
    expect(formatClaudeStreamLine(line)).toBeNull();
  });

  it("suppresses stream_event text deltas (covered by full assistant event)", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hel" },
      },
    });
    expect(formatClaudeStreamLine(line)).toBeNull();
  });

  it("formats error events", () => {
    const line = JSON.stringify({
      type: "error",
      message: "Authentication failed",
    });
    expect(formatClaudeStreamLine(line)).toBe("[error] Authentication failed");
  });

  it("falls back to raw line for malformed JSON", () => {
    expect(formatClaudeStreamLine("not json at all")).toBe("not json at all");
  });

  it("returns null for empty lines", () => {
    expect(formatClaudeStreamLine("")).toBeNull();
    expect(formatClaudeStreamLine("   ")).toBeNull();
  });

  it("truncates very long assistant text to keep run logs readable", () => {
    const longText = "a".repeat(8000);
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: longText }] },
    });
    const out = formatClaudeStreamLine(line);
    expect(out).not.toBeNull();
    expect((out ?? "").length).toBeLessThan(longText.length);
    expect(out).toMatch(/…$/);
  });
});

describe("createClaudeLogFilter", () => {
  it("buffers stdout chunks and emits one formatted line per JSON object", async () => {
    const captured: { stream: string; chunk: string }[] = [];
    const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
      captured.push({ stream, chunk });
    };
    const filter = createClaudeLogFilter(onLog);

    const event1 = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-haiku-4-5-20251001",
    });
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
    expect(stdoutChunks).toHaveLength(2); // init + assistant; stream_event suppressed
    expect(stdoutChunks[0].chunk).toContain("[claude] init session=s1");
    expect(stdoutChunks[1].chunk).toContain("[assistant] Hi");
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

    const event = JSON.stringify({ type: "error", message: "boom" });
    await filter.onLog("stdout", event); // no newline
    expect(captured).toHaveLength(0);
    await filter.flush();
    expect(captured).toHaveLength(1);
    expect(captured[0].chunk).toContain("[error] boom");
  });
});
