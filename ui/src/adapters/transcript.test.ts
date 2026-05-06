import { describe, expect, it } from "vitest";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { buildTranscript, type RunLogChunk } from "./transcript";

describe("buildTranscript", () => {
  const ts = "2026-03-20T13:00:00.000Z";
  const chunks: RunLogChunk[] = [
    { ts, stream: "stdout", chunk: "opened /Users/dotta/project\n" },
    { ts, stream: "stderr", chunk: "stderr /Users/dotta/project" },
  ];

  it("defaults username censoring to off when options are omitted", () => {
    const entries = buildTranscript(chunks, (line, entryTs) => [{ kind: "stdout", ts: entryTs, text: line }]);

    expect(entries).toEqual([
      { kind: "stdout", ts, text: "opened /Users/dotta/project" },
      { kind: "stderr", ts, text: "stderr /Users/dotta/project" },
    ]);
  });

  it("still redacts usernames when explicitly enabled", () => {
    const entries = buildTranscript(chunks, (line, entryTs) => [{ kind: "stdout", ts: entryTs, text: line }], {
      censorUsernameInLogs: true,
    });

    expect(entries).toEqual([
      { kind: "stdout", ts, text: "opened /Users/d****/project" },
      { kind: "stderr", ts, text: "stderr /Users/d****/project" },
    ]);
  });

  it("formats claude housekeeping lines into transcript events instead of raw stdout blocks", () => {
    const claudeChunks: RunLogChunk[] = [
      {
        ts,
        stream: "stdout",
        chunk: "[paperclip] Loaded agent instructions file: /tmp/agent-instructions.md\n",
      },
      {
        ts,
        stream: "stdout",
        chunk: JSON.stringify({
          type: "system",
          subtype: "hook_started",
          hook_name: "SessionStart:resume",
          hook_event: "SessionStart",
          session_id: "session-1",
        }) + "\n",
      },
      {
        ts,
        stream: "stdout",
        chunk: JSON.stringify({
          type: "system",
          subtype: "hook_response",
          hook_name: "SessionStart:resume",
          hook_event: "SessionStart",
          exit_code: 0,
          stdout: "{}",
          stderr: "",
          session_id: "session-1",
        }) + "\n",
      },
      {
        ts,
        stream: "stdout",
        chunk: JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
          },
          session_id: "session-1",
        }) + "\n",
      },
      {
        ts,
        stream: "stdout",
        chunk: JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "hello" }] },
        }) + "\n",
      },
    ];

    const entries = buildTranscript(claudeChunks, parseClaudeStdoutLine);

    expect(entries).toEqual([
      { kind: "system", ts, text: "[paperclip] Loaded agent instructions file: /tmp/agent-instructions.md" },
      // hook_started is suppressed; SessionStart hook_response is also suppressed because
      // it's an auto-injected lifecycle hook that fires every prompt.
      { kind: "system", ts, text: "Claude rate limit: rejected (five_hour)" },
      { kind: "assistant", ts, text: "hello" },
    ]);
  });

  it("collapses non-auto-injected hook lifecycles to a single entry on response", () => {
    const ts2 = "2026-03-20T13:00:00.000Z";
    const claudeChunks: RunLogChunk[] = [
      {
        ts: ts2,
        stream: "stdout",
        chunk: JSON.stringify({
          type: "system",
          subtype: "hook_started",
          hook_name: "PreToolUse:Bash",
          hook_event: "PreToolUse",
        }) + "\n",
      },
      {
        ts: ts2,
        stream: "stdout",
        chunk: JSON.stringify({
          type: "system",
          subtype: "hook_response",
          hook_name: "PreToolUse:Bash",
          hook_event: "PreToolUse",
          exit_code: 0,
        }) + "\n",
      },
    ];

    expect(buildTranscript(claudeChunks, parseClaudeStdoutLine)).toEqual([
      { kind: "system", ts: ts2, text: "Hook: PreToolUse:Bash ✓" },
    ]);
  });

  it("emits a failure entry on hook_response with non-zero exit_code", () => {
    const ts2 = "2026-03-20T13:00:00.000Z";
    const claudeChunks: RunLogChunk[] = [
      {
        ts: ts2,
        stream: "stdout",
        chunk: JSON.stringify({
          type: "system",
          subtype: "hook_response",
          hook_name: "PostToolUse:Edit",
          exit_code: 2,
        }) + "\n",
      },
    ];

    expect(buildTranscript(claudeChunks, parseClaudeStdoutLine)).toEqual([
      { kind: "system", ts: ts2, text: "Hook failed: PostToolUse:Edit (exit 2)" },
    ]);
  });
});
