import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isClaudeMaxTurnsResult } from "@paperclipai/adapter-claude-local/server";
import { execute } from "@paperclipai/adapter-claude-local/server";

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

fs.readFileSync(0, "utf8");
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-session-1",
  model: "claude-sonnet-4-6",
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
});

describe("claude_local skills environment", () => {
  it("exposes PAPERCLIP_SKILLS_DIR pointing at the materialized .claude/skills dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-skillsenv-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    let capturedEnv: Record<string, string> | undefined;

    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-claude-skillsenv",
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
          // skipSkills omitted → the skills directory is materialized.
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          capturedEnv = meta.env;
        },
      });

      expect(result.exitCode).toBe(0);
      const skillsDir = capturedEnv?.PAPERCLIP_SKILLS_DIR;
      expect(skillsDir).toBeDefined();
      expect(skillsDir!.endsWith(path.join(".claude", "skills"))).toBe(true);
      const stat = await fs.stat(skillsDir!);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("omits PAPERCLIP_SKILLS_DIR when skills are skipped", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-skillsenv-skip-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    let capturedEnv: Record<string, string> | undefined;

    await fs.mkdir(workspace, { recursive: true });
    await writeFakeClaudeCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-claude-skillsenv-skip",
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
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          capturedEnv = meta.env;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(capturedEnv?.PAPERCLIP_SKILLS_DIR).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
