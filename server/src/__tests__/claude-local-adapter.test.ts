import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isClaudeMaxTurnsResult } from "@paperclipai/adapter-claude-local/server";
import { execute } from "@paperclipai/adapter-claude-local/server";
import { estimateCostUsd } from "../../../packages/adapters/claude-local/src/server/batch.js";

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

fs.readFileSync(0, "utf8");
if (process.env.PAPERCLIP_CAPTURE_ARGS_PATH) {
  fs.writeFileSync(process.env.PAPERCLIP_CAPTURE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
}
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-session-1",
  model: "claude-sonnet-5",
}));
console.log(JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "text", text: "hello from claude" }] },
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-session-1",
  result: "ok",
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("claude_local max-turn detection", () => {
  it("detects max-turn exhaustion by subtype", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "error_max_turns",
        result: "Reached max turns",
      }),
    ).toBe(true);
  });

  it("detects max-turn exhaustion by stop_reason", () => {
    expect(
      isClaudeMaxTurnsResult({
        stop_reason: "max_turns",
      }),
    ).toBe(true);
  });

  it("returns false for non-max-turn results", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "success",
        stop_reason: "end_turn",
      }),
    ).toBe(false);
  });

  it("logs loaded instructions as stdout so transcripts do not classify it as stderr", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const instructionsPath = path.join(root, "instructions.md");
    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];

    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);
    await fs.writeFile(instructionsPath, "Follow the instructions.\n", "utf8");

    try {
      const result = await execute({
        runId: "run-claude-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Claude Coder",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          skipSkills: true,
          instructionsFilePath: instructionsPath,
          promptTemplate: "Continue the Paperclip task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (stream, chunk) => {
          logs.push({ stream, chunk });
        },
      });

      expect(result.exitCode).toBe(0);
      expect(logs).toContainEqual({
        stream: "stdout",
        chunk: `[paperclip] Loaded agent instructions file: ${instructionsPath}\n`,
      });
      expect(
        logs.some(
          (entry) => entry.stream === "stderr" && entry.chunk.includes("Loaded agent instructions file"),
        ),
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not pass an effort flag to Haiku", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-haiku-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const argsPath = path.join(root, "args.json");

    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-claude-haiku",
        agent: {
          id: "agent-haiku",
          companyId: "company-1",
          name: "Claude Haiku",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          skipSkills: true,
          model: "claude-haiku-4-5",
          effort: "ultracode",
          promptTemplate: "Continue the Paperclip task.",
          env: { PAPERCLIP_CAPTURE_ARGS_PATH: argsPath },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const args = JSON.parse(await fs.readFile(argsPath, "utf8")) as string[];
      expect(result.exitCode).toBe(0);
      expect(args).toContain("claude-haiku-4-5");
      expect(args).not.toContain("--effort");
      expect(args).not.toContain("ultracode");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("claude_local batch pricing", () => {
  it("uses Haiku 4.5 pricing for the current CLI model ID", () => {
    expect(
      estimateCostUsd("claude-haiku-4-5", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(2.4);
  });
});
