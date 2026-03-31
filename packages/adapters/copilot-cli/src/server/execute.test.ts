import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAbsoluteDirectoryMock,
  ensureCommandResolvableMock,
  readPaperclipSkillMarkdownMock,
  runChildProcessMock,
} = vi.hoisted(() => ({
  ensureAbsoluteDirectoryMock: vi.fn(async () => {}),
  ensureCommandResolvableMock: vi.fn(async () => {}),
  readPaperclipSkillMarkdownMock: vi.fn(async () => null),
  runChildProcessMock: vi.fn(),
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
    runChildProcess: runChildProcessMock,
  };
});

import { execute } from "./execute.js";

describe("copilot execute", () => {
  beforeEach(() => {
    ensureAbsoluteDirectoryMock.mockClear();
    ensureCommandResolvableMock.mockClear();
    readPaperclipSkillMarkdownMock.mockClear();
    runChildProcessMock.mockReset();
  });

  it("does not treat a successful final result as auth-required just because raw jsonl mentions copilot login", async () => {
    runChildProcessMock.mockResolvedValue({
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
});