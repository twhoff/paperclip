import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isClaudeMaxTurnsResult } from "@paperclipai/adapter-claude-local/server";
import { execute } from "@paperclipai/adapter-claude-local/server";
import { estimateCostUsd } from "../../../packages/adapters/claude-local/src/server/batch.js";
import { detectClaudeLoginRequired } from "../../../packages/adapters/claude-local/src/server/parse.js";
import {
  didClaudeProcessFail,
  didClaudeProcessTerminateBySignal,
} from "../../../packages/adapters/claude-local/src/server/execute.js";

async function writeFakeClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");

fs.readFileSync(0, "utf8");
if (process.env.TEST_CAPTURE_ARGS_PATH) {
  fs.writeFileSync(process.env.TEST_CAPTURE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
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

async function writeSignalExitClaudeCommand(
  commandPath: string,
  exitCode: number,
): Promise<void> {
  const script = `#!/usr/bin/env node
process.stderr.write("Please log in to continue.\\n");
process.exit(${exitCode});
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeLoginRequiredClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
process.stderr.write("Please log in to continue.\\n");
process.exit(1);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeStructuredResultClaudeCommand(
  commandPath: string,
  result: Record<string, unknown>,
): Promise<void> {
  const script = `#!/usr/bin/env node
require("node:fs").readFileSync(0, "utf8");
console.log(JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "claude-structured-result-session",
  model: "claude-sonnet-5",
}));
console.log(JSON.stringify(${JSON.stringify(result)}));
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeParsedSignalClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
fs.writeSync(1, JSON.stringify({
  type: "result",
  subtype: "success",
  session_id: "claude-signalled-session",
  result: "ok",
}) + "\\n");
process.kill(process.pid, "SIGTERM");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeUnknownSessionSignalClaudeCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.TEST_CAPTURE_COUNT_PATH, "1");
fs.writeSync(1, JSON.stringify({
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  result: "No conversation found with session ID",
}) + "\\n");
process.kill(process.pid, "SIGTERM");
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("claude_local max-turn detection", () => {
  it("requires an exact zero exit code and no signal for process success", () => {
    expect(didClaudeProcessFail({ exitCode: 0, signal: null })).toBe(false);
    expect(didClaudeProcessFail({ exitCode: null, signal: null })).toBe(true);
    expect(didClaudeProcessFail({ exitCode: null, signal: "SIGTERM" })).toBe(true);
    expect(didClaudeProcessFail({ exitCode: 1, signal: null })).toBe(true);
    expect(didClaudeProcessTerminateBySignal({ exitCode: 143, signal: null })).toBe(true);
    expect(didClaudeProcessTerminateBySignal({ exitCode: 1, signal: null })).toBe(false);
  });

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
      expect(result.errorMessage).toBeNull();
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
          env: { TEST_CAPTURE_ARGS_PATH: argsPath },
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

  it.each([129, 139, 143, 192])(
    "does not classify signal-style exit %i as an authentication failure",
    async (exitCode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-signal-exit-"));
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "claude");

      await fs.mkdir(workspace, { recursive: true });
      await writeSignalExitClaudeCommand(commandPath, exitCode);

      try {
        const result = await execute({
          runId: "run-claude-signal-exit",
          agent: {
            id: "agent-signal-exit",
            companyId: "company-1",
            name: "Claude Signal Exit",
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
            promptTemplate: "Continue the Paperclip task.",
          },
          context: {},
          authToken: "run-jwt-token",
          onLog: async () => {},
        });

        expect(result.exitCode).toBe(exitCode);
        expect(result.errorCode).toBeNull();
        expect(result.errorMessage).toBe(`Claude exited with code ${exitCode}`);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("fails a parsed result when the Claude child terminates by signal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-parsed-signal-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");

    await fs.mkdir(workspace, { recursive: true });
    await writeParsedSignalClaudeCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-claude-parsed-signal",
        agent: {
          id: "agent-parsed-signal",
          companyId: "company-1",
          name: "Claude Parsed Signal",
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
          promptTemplate: "Continue the Paperclip task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe("SIGTERM");
      expect(result.errorCode).toBeNull();
      expect(result.errorMessage).toBe("Claude exited with code -1");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not retry an unknown resumed session after signal cancellation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-resume-signal-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");
    const countPath = path.join(root, "count");

    await fs.mkdir(workspace, { recursive: true });
    await writeUnknownSessionSignalClaudeCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-claude-resume-signal",
        agent: {
          id: "agent-resume-signal",
          companyId: "company-1",
          name: "Claude Resume Signal",
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "missing-session",
          sessionParams: null,
          sessionDisplayId: "missing-session",
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          skipSkills: true,
          promptTemplate: "Continue the Paperclip task.",
          env: { TEST_CAPTURE_COUNT_PATH: countPath },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.signal).toBe("SIGTERM");
      expect(await fs.readFile(countPath, "utf8")).toBe("1");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a genuine non-signal Claude login failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-login-exit-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");

    await fs.mkdir(workspace, { recursive: true });
    await writeLoginRequiredClaudeCommand(commandPath);

    try {
      const result = await execute({
        runId: "run-claude-login-exit",
        agent: {
          id: "agent-login-exit",
          companyId: "company-1",
          name: "Claude Login Exit",
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
          promptTemplate: "Continue the Paperclip task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("claude_auth_required");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails an exit-zero structured authentication error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-structured-auth-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");

    await fs.mkdir(workspace, { recursive: true });
    await writeStructuredResultClaudeCommand(commandPath, {
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "claude-structured-auth-session",
      result: "Please log in to Claude before continuing.",
    });

    try {
      const result = await execute({
        runId: "run-claude-structured-auth",
        agent: {
          id: "agent-structured-auth",
          companyId: "company-1",
          name: "Claude Structured Auth",
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
          promptTemplate: "Continue the Paperclip task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBe("claude_auth_required");
      expect(result.errorMessage).toBe(
        "Claude run failed: subtype=success: Please log in to Claude before continuing.",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails an exit-zero structured non-authentication error subtype", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-structured-error-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "claude");

    await fs.mkdir(workspace, { recursive: true });
    await writeStructuredResultClaudeCommand(commandPath, {
      type: "result",
      subtype: "error_during_execution",
      session_id: "claude-structured-error-session",
      result: "Provider rejected the request.",
    });

    try {
      const result = await execute({
        runId: "run-claude-structured-error",
        agent: {
          id: "agent-structured-error",
          companyId: "company-1",
          name: "Claude Structured Error",
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
          promptTemplate: "Continue the Paperclip task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBeNull();
      expect(result.errorMessage).toBe(
        "Claude run failed: subtype=error_during_execution: Provider rejected the request.",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("claude_local authentication detection", () => {
  it("does not treat ordinary successful assistant prose as a CLI login failure", () => {
    const parsed = {
      type: "result",
      subtype: "success",
      result: "The reviewed application says authentication required for administrators.",
    };

    expect(
      detectClaudeLoginRequired({
        parsed,
        stdout: JSON.stringify(parsed),
        stderr: "",
      }),
    ).toEqual({ requiresLogin: false, loginUrl: null });
  });

  it("does not attach an auth failure to a successful result because of stderr prose", () => {
    const parsed = {
      type: "result",
      subtype: "success",
      result: "ok",
    };

    expect(
      detectClaudeLoginRequired({
        parsed,
        stdout: JSON.stringify(parsed),
        stderr: "The documentation says authentication required for administrators.",
      }),
    ).toEqual({ requiresLogin: false, loginUrl: null });
  });

  it("does not reclassify successful assistant prose when an outer process fails", () => {
    const parsed = {
      type: "result",
      subtype: "success",
      result: "The reviewed application says authentication required for administrators.",
    };

    expect(
      detectClaudeLoginRequired({
        parsed,
        stdout: JSON.stringify(parsed),
        stderr: "wrapper exited unexpectedly",
        processFailed: true,
      }),
    ).toEqual({ requiresLogin: false, loginUrl: null });
  });

  it("uses stderr auth evidence when a process fails after a parsed success", () => {
    const parsed = {
      type: "result",
      subtype: "success",
      result: "ok",
    };

    expect(
      detectClaudeLoginRequired({
        parsed,
        stdout: JSON.stringify(parsed),
        stderr: "Please log in to Claude before continuing.",
        processFailed: true,
      }).requiresLogin,
    ).toBe(true);
  });

  it("still detects a structured Claude login failure", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Please log in to Claude before continuing.",
        },
        stdout: "",
        stderr: "",
      }).requiresLogin,
    ).toBe(true);
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
