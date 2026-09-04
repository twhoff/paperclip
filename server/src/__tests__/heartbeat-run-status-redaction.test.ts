import { describe, expect, it } from "vitest";
import {
  buildAdapterInvocationEventPayload,
  buildLastRunSummaryPayload,
  buildHeartbeatRunStatusPayload,
  prepareAdapterResultViews,
  redactAdapterResultForPersistence,
  redactHeartbeatRunEventContent,
} from "../services/heartbeat.js";

describe("heartbeat run status response redaction", () => {
  it("prevents live clients from rebuilding a JWT across status fields", () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const splitAt = token.indexOf("payload");
    const payload = buildHeartbeatRunStatusPayload({
      id: "run-1",
      agentId: "agent-1",
      status: "failed",
      invocationSource: "manual",
      triggerDetail: token.slice(0, splitAt),
      error: token.slice(splitAt),
      errorCode: "adapter_failed",
      startedAt: new Date("2026-09-05T00:00:00.000Z"),
      finishedAt: new Date("2026-09-05T00:01:00.000Z"),
    });

    expect(`${payload.triggerDetail}${payload.error}`).not.toContain(token);
    expect(payload.triggerDetail).toBe("***REDACTED***");
    expect(payload.error).toBe("payload.signature_with-hyphen_");
    expect(payload.runId).toBe("run-1");
    expect(payload.errorCode).toBe("adapter_failed");
  });

  it("fails closed on trailing JWT prefixes while preserving status and event selectors", () => {
    const statusPayload = buildHeartbeatRunStatusPayload({
      id: "run-selector",
      agentId: "agent-selector",
      status: "failed",
      invocationSource: "manual",
      triggerDetail: "ey",
      error: null,
      errorCode: "adapter_failed",
      startedAt: new Date("2026-09-05T00:00:00.000Z"),
      finishedAt: new Date("2026-09-05T00:01:00.000Z"),
    });
    const summary = buildLastRunSummaryPayload(
      {
        runId: "run-previous",
        status: "failed",
        errorCode: "adapter_failed",
        error: "ey",
        durationMs: 1000,
        issueId: "issue-1",
        lastEvents: [
          { type: "adapter.invoke", message: "benign", level: "info" },
        ],
      },
      { enabled: false },
    );

    expect(statusPayload.triggerDetail).toBe("***REDACTED***");
    expect(statusPayload).toMatchObject({
      runId: "run-selector",
      agentId: "agent-selector",
      status: "failed",
      invocationSource: "manual",
    });
    expect(summary.error).toBe("***REDACTED***");
    expect(summary).toMatchObject({
      runId: "run-previous",
      status: "failed",
      lastEvents: [{ type: "adapter.invoke", message: "benign", level: "info" }],
    });
  });

  it("sanitizes split adapter result fields before deriving the persisted run row", () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const splitAt = token.indexOf("payload");
    const adapterResult = redactAdapterResultForPersistence(
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "adapter failed",
        resultJson: {
          stdout: token.slice(0, splitAt),
          stderr: token.slice(splitAt),
        },
      },
      { enabled: false },
    );
    const persistedRow = {
      error: adapterResult.errorMessage ?? null,
      resultJson: adapterResult.resultJson ?? null,
    };

    expect(
      `${(persistedRow.resultJson as { stdout: string }).stdout}${
        (persistedRow.resultJson as { stderr: string }).stderr
      }`,
    ).not.toContain(token);
    expect(persistedRow.resultJson).toEqual({
      stdout: "***REDACTED***",
      stderr: "payload.signature_with-hyphen_",
    });
    expect(persistedRow.error).toBe("adapter failed");
  });

  it("sanitizes a reverse-order exact secret across arbitrary adapter result fields", () => {
    const secret = "current-exact-secret-0123456789-abcdefghijklmnopqrstuvwxyz-ABCDEFGH";
    const fragmentSize = Math.ceil(secret.length / 8);
    const fragments = Array.from({ length: 8 }, (_, index) =>
      secret.slice(index * fragmentSize, (index + 1) * fragmentSize),
    );
    const adapterResult = redactAdapterResultForPersistence(
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "adapter failed",
        errorMeta: {
          fragment: fragments[7],
          classification: "retryable-result",
        },
        sessionParams: {
          fragment: fragments[6],
          workspaceId: "workspace-1",
        },
        runtimeServices: [
          {
            serviceName: "preview",
            stopPolicy: { fragment: fragments[5] },
          },
        ],
        question: {
          prompt: "Choose a target",
          choices: [{ key: "one", label: fragments[4] ?? "", description: "Safe option" }],
        },
        sessionId: fragments[3],
        sessionDisplayId: fragments[2],
        model: fragments[1],
        provider: fragments[0],
      },
      { enabled: false, secretValues: [secret] },
    );

    const rebuilt = [
      adapterResult.provider,
      adapterResult.model,
      adapterResult.sessionDisplayId,
      adapterResult.sessionId,
      adapterResult.question?.choices[0]?.label,
      (adapterResult.runtimeServices?.[0]?.stopPolicy as { fragment?: string } | null)?.fragment,
      adapterResult.sessionParams?.fragment,
      adapterResult.errorMeta?.fragment,
    ].join("");

    expect(rebuilt).not.toContain(secret);
    expect(adapterResult.provider).toBe("***REDACTED***");
    expect(adapterResult.errorMessage).toBe("adapter failed");
    expect(adapterResult.errorMeta?.classification).toBe("retryable-result");
    expect(adapterResult.sessionParams?.workspaceId).toBe("workspace-1");
    expect(adapterResult.runtimeServices?.[0]?.serviceName).toBe("preview");
    expect(adapterResult.question?.prompt).toBe("Choose a target");
    expect(adapterResult.question?.choices[0]?.description).toBe("Safe option");
  });

  it("keeps operational session and runtime identity while masking persisted diagnostics", () => {
    const secret = "current-adapter-secret-0123456789";
    const cwd = "/Users/fixture-user/Projects/paperclip-worktrees/PCL-505";
    const sessionId = "session-fixture-user-PCL-505";
    const rawResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId,
      sessionDisplayId: sessionId,
      sessionParams: { cwd, sessionId },
      runtimeServices: [
        {
          serviceName: "preview",
          cwd,
          providerRef: sessionId,
          status: "running" as const,
        },
      ],
      resultJson: {
        cwd,
        stderr: `provider echoed ${secret}`,
      },
    };

    const views = prepareAdapterResultViews(rawResult, {
      enabled: true,
      userNames: ["fixture-user"],
      homeDirs: ["/Users/fixture-user"],
      secretValues: [secret],
    });

    expect(views.operational).toBe(rawResult);
    expect(views.operational.sessionParams).toEqual({ cwd, sessionId });
    expect(views.operational.runtimeServices?.[0]).toMatchObject({
      cwd,
      providerRef: sessionId,
    });
    expect(views.credentialSafe.sessionParams).toEqual({ cwd, sessionId });
    expect(views.credentialSafe.runtimeServices?.[0]).toMatchObject({
      cwd,
      providerRef: sessionId,
    });
    expect(JSON.stringify(views.credentialSafe.resultJson)).not.toContain(secret);
    expect(JSON.stringify(views.persisted.resultJson)).not.toContain(secret);
    expect(JSON.stringify(views.persisted.resultJson)).not.toContain("fixture-user");
  });

  it("sanitizes a multi-field prior-run credential before outbound context injection", () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const summary = buildLastRunSummaryPayload(
      {
        runId: "run-previous",
        status: "failed",
        errorCode: "adapter_failed",
        error: "e",
        durationMs: 1000,
        issueId: "issue-1",
        lastEvents: [
          { type: "adapter.invoke", message: "y", level: "info" },
          { type: "adapter.error", message: "Jheader.payload.signature_with-hyphen_", level: "error" },
        ],
      },
      { enabled: false },
    );

    expect(
      `${summary.error}${summary.lastEvents[0]?.message}${summary.lastEvents[1]?.message}`,
    ).not.toContain(token);
    expect(summary.error).toBe("***REDACTED***");
    expect(summary.issueId).toBe("issue-1");
  });

  it("uses one sanitized event representation for database and live payloads", () => {
    const token = "eyJheader.payload.signature_with-hyphen_";
    const sanitized = redactHeartbeatRunEventContent(
      {
        message: "adapter invocation",
        payload: {
          command: "eyJheader.",
          metadata: { fragment: "payload.signature_with-hyphen_" },
        },
      },
      { enabled: false },
    );
    const persisted = { message: sanitized.message, payload: sanitized.payload };
    const published = { message: sanitized.message, payload: sanitized.payload };

    for (const representation of [persisted, published]) {
      const payload = representation.payload as {
        command: string;
        metadata: { fragment: string };
      };
      expect(`${payload.command}${payload.metadata.fragment}`).not.toContain(token);
      expect(payload.command).toBe("***REDACTED***");
    }
  });

  it("sanitizes a configured secret across adapter metadata before database and live events", () => {
    const secret = "configured-provider-secret-0123456789";
    const splitAt = Math.floor(secret.length / 2);
    const payload = buildAdapterInvocationEventPayload(
      {
        adapterType: "claude_local",
        command: secret.slice(0, splitAt),
        env: {
          SAFE_LABEL: secret.slice(splitAt),
          API_TOKEN: secret,
          MODEL: "claude-sonnet",
        },
      },
      new Set(["API_TOKEN"]),
      { enabled: false, secretValues: [secret] },
    );
    const event = redactHeartbeatRunEventContent(
      { message: "adapter invocation", payload },
      { enabled: false },
    );
    const persisted = { message: event.message, payload: event.payload };
    const published = { message: event.message, payload: event.payload };

    for (const representation of [persisted, published]) {
      const meta = representation.payload as {
        command: string;
        env: Record<string, string>;
      };
      expect(`${meta.command}${meta.env.SAFE_LABEL}`).not.toContain(secret);
      expect(meta.env.API_TOKEN).toBe("***REDACTED***");
      expect(meta.env.MODEL).toBe("claude-sonnet");
    }
  });

  it("fails closed without throwing when adapter metadata env is non-plain", () => {
    class HostileEnv {
      X = "eyJheader.payload.signature_";
      toJSON() {
        return this.X;
      }
    }

    expect(() =>
      buildAdapterInvocationEventPayload(
        { adapterType: "claude_local", env: new HostileEnv() } as any,
        new Set(["X"]),
        { enabled: false },
      ),
    ).not.toThrow();
    const payload = buildAdapterInvocationEventPayload(
      { adapterType: "claude_local", env: new HostileEnv() } as any,
      new Set(["X"]),
      { enabled: false },
    );
    expect(JSON.stringify(payload)).not.toContain("eyJheader.payload.signature_");
    expect(payload.env).toBe("***REDACTED***");
  });
});
