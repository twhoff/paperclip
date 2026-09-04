import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAbsoluteDirectoryMock,
  ensureCommandResolvableMock,
  readPaperclipSkillMarkdownMock,
  runLocalAdapterChildProcessMock,
} = vi.hoisted(() => ({
  ensureAbsoluteDirectoryMock: vi.fn(async () => {}),
  ensureCommandResolvableMock: vi.fn(async () => {}),
  readPaperclipSkillMarkdownMock: vi.fn(async () => null),
  runLocalAdapterChildProcessMock: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );

  return {
    ...actual,
    ensureAbsoluteDirectory: ensureAbsoluteDirectoryMock,
    ensureCommandResolvable: ensureCommandResolvableMock,
    readPaperclipSkillMarkdown: readPaperclipSkillMarkdownMock,
    runLocalAdapterChildProcess: runLocalAdapterChildProcessMock,
  };
});

import { execute } from "./execute.js";

describe("copilot execute", () => {
  beforeEach(() => {
    ensureAbsoluteDirectoryMock.mockClear();
    ensureCommandResolvableMock.mockClear();
    readPaperclipSkillMarkdownMock.mockClear();
    runLocalAdapterChildProcessMock.mockReset();
  });

  it("does not treat a successful final result as auth-required just because raw jsonl mentions copilot login", async () => {
    runLocalAdapterChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({
          type: "user.message",
          data: {
            content: "If auth breaks, run copilot login and retry.",
          },
        }),
        JSON.stringify({
          type: "assistant.message",
          data: {
            messageId: "m1",
            content: "Filed TIZA-592.",
            toolRequests: [],
            interactionId: "i1",
            outputTokens: 7,
          },
        }),
        JSON.stringify({
          type: "result",
          timestamp: "2026-04-01T00:38:34.804Z",
          sessionId: "session-123",
          exitCode: 0,
          usage: {
            premiumRequests: 1,
            totalApiDurationMs: 587000,
            sessionDurationMs: 51139726,
            codeChanges: {
              linesAdded: 0,
              linesRemoved: 0,
              filesModified: [],
            },
          },
        }),
      ].join("\n"),
      stderr: "",
    });

    const result = await execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        name: "Implementation Reviewer",
        companyId: "company-123",
      },
      runtime: {
        sessionId: null,
        sessionDisplayId: null,
        sessionParams: null,
      },
      config: {
        command: "copilot",
        cwd: "/tmp/paperclip-copilot-test",
        allowAll: false,
        skillsEnabled: false,
      },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
    } as never);

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.premiumRequests).toBe(1);
    expect(result.resultJson).toMatchObject({
      exitCode: 0,
      usage: { premiumRequests: 1 },
    });
  });

  it("keeps the Paperclip run JWT out of Copilot provider-auth variables", async () => {
    runLocalAdapterChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({
          type: "result",
          timestamp: "2026-09-05T00:00:00.000Z",
          sessionId: "session-auth-boundary",
          exitCode: 0,
          usage: { premiumRequests: 0 },
        }),
      ].join("\n"),
      stderr: "",
    });

    const authToken = "paperclip-run-jwt-not-a-github-token";
    await execute({
      runId: "run-auth-boundary",
      agent: {
        id: "agent-auth-boundary",
        name: "Copilot Auth Boundary",
        companyId: "company-123",
        adapterType: "copilot_cli",
      },
      runtime: {
        sessionId: null,
        sessionDisplayId: null,
        sessionParams: null,
      },
      config: {
        command: "copilot",
        cwd: "/tmp/paperclip-copilot-test",
        allowAll: false,
        skillsEnabled: false,
      },
      context: {},
      authToken,
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
    } as never);

    const options = runLocalAdapterChildProcessMock.mock.calls[0]?.[4];
    expect(options?.env.PAPERCLIP_API_KEY).toBe(authToken);
    expect(options?.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(options?.env.GH_TOKEN).toBeUndefined();
    expect(options?.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("does not pass --no-auto-update when launching Copilot", async () => {
    runLocalAdapterChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({
          type: "assistant.message",
          data: {
            messageId: "m1",
            content: "Done.",
            toolRequests: [],
            interactionId: "i1",
            outputTokens: 1,
          },
        }),
        JSON.stringify({
          type: "result",
          timestamp: "2026-05-26T00:00:00.000Z",
          sessionId: "session-456",
          exitCode: 0,
          usage: {
            premiumRequests: 0,
            totalApiDurationMs: 1000,
            sessionDurationMs: 1000,
            codeChanges: {
              linesAdded: 0,
              linesRemoved: 0,
              filesModified: [],
            },
          },
        }),
      ].join("\n"),
      stderr: "",
    });

    const onMeta = vi.fn(async () => {});

    await execute({
      runId: "run-789",
      agent: {
        id: "agent-123",
        name: "Lead Engineer",
        companyId: "company-123",
      },
      runtime: {
        sessionId: null,
        sessionDisplayId: null,
        sessionParams: null,
      },
      config: {
        command: "copilot",
        cwd: "/tmp/paperclip-copilot-test",
        allowAll: true,
        model: "gpt-5.5",
        skillsEnabled: false,
      },
      context: {},
      onLog: async () => {},
      onMeta,
      onSpawn: async () => {},
    } as never);

    expect(runLocalAdapterChildProcessMock).toHaveBeenCalledTimes(1);
    const args = runLocalAdapterChildProcessMock.mock.calls[0]?.[3] ?? [];
    expect(args).toContain("--model");
    expect(args).toContain("gpt-5.5");
    expect(args).not.toContain("--no-auto-update");

    expect(onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        commandArgs: expect.not.arrayContaining(["--no-auto-update"]),
      }),
    );
  });

  it("retries without session when resume fails before a result event is emitted", async () => {
    runLocalAdapterChildProcessMock
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "[paperclip] Loaded agent instructions file: /tmp/agent/AGENTS.md\n",
        stderr: "Error: thread/resume: thread/resume failed: no rollout found for thread id stale-thread\n",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({
            type: "assistant.message",
            data: {
              messageId: "m2",
              content: "Recovered with a fresh session.",
              toolRequests: [],
              interactionId: "i2",
              outputTokens: 5,
            },
          }),
          JSON.stringify({
            type: "result",
            timestamp: "2026-04-13T00:38:34.804Z",
            sessionId: "fresh-session-123",
            exitCode: 0,
            usage: {
              premiumRequests: 0,
              totalApiDurationMs: 1000,
              sessionDurationMs: 1000,
              codeChanges: {
                linesAdded: 0,
                linesRemoved: 0,
                filesModified: [],
              },
            },
          }),
        ].join("\n"),
        stderr: "",
      });

    const onLog = vi.fn(async () => {});

    const result = await execute({
      runId: "run-456",
      agent: {
        id: "agent-123",
        name: "Implementation Reviewer",
        companyId: "company-123",
      },
      runtime: {
        sessionId: "stale-thread",
        sessionDisplayId: "stale-thread",
        sessionParams: { sessionId: "stale-thread", cwd: "/tmp/paperclip-copilot-test" },
      },
      config: {
        command: "copilot",
        cwd: "/tmp/paperclip-copilot-test",
        allowAll: false,
        skillsEnabled: false,
      },
      context: {},
      onLog,
      onMeta: async () => {},
      onSpawn: async () => {},
    } as never);

    expect(runLocalAdapterChildProcessMock).toHaveBeenCalledTimes(2);
    expect(runLocalAdapterChildProcessMock.mock.calls[0]?.[3]).toContain("--resume=stale-thread");
    expect(runLocalAdapterChildProcessMock.mock.calls[1]?.[3]).not.toContain("--resume=stale-thread");
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("fresh-session-123");
    expect(result.clearSession).toBe(true);
    expect(onLog).toHaveBeenCalledWith(
      "stdout",
      '[paperclip] Copilot session "stale-thread" not found, retrying without session.\n',
    );
  });
});
