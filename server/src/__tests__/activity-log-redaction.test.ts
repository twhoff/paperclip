import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  logActivity,
  sanitizeActivityRecordForPersistence,
  setPluginEventBus,
} from "../services/activity-log.js";

const mocks = vi.hoisted(() => ({
  publishLiveEvent: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: mocks.publishLiveEvent,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }),
  }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mocks.loggerWarn,
  },
}));

describe("activity log persistence redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strictly redacts detail fragments across separate activity writes", () => {
    const token = "eyJactivity.separate-writes.signature_";
    const first = sanitizeActivityRecordForPersistence({
      actorId: "system",
      action: "issue.created",
      entityType: "issue",
      entityId: "issue-1",
      details: { detail: token.slice(0, 1) },
    });
    const second = sanitizeActivityRecordForPersistence({
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: "issue-2",
      details: { detail: token.slice(1) },
    });

    expect(`${first.details?.detail}${second.details?.detail}`).not.toContain(token);
    expect(first.details?.detail).toBe("***REDACTED***");
    expect(first.entityType).toBe("issue");
  });

  it("sanitizes reverse-order split details before database, live, and plugin publication", async () => {
    const token = "eyJactivity.payload.signature_with-hyphen_";
    const splitAt = token.indexOf("payload");
    const values = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn(() => ({ values })),
    } as unknown as Db;
    const emit = vi.fn().mockResolvedValue({ errors: [] });
    setPluginEventBus({ emit } as any);

    await logActivity(db, {
      companyId: "company-1",
      actorType: "system",
      actorId: "system-1",
      action: "issue.created",
      entityType: "issue",
      entityId: "issue-1",
      details: {
        tail: token.slice(splitAt),
        prefix: token.slice(0, splitAt),
        source: "scheduler",
      },
    });

    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce());

    const inserted = values.mock.calls[0]?.[0] as {
      details: { prefix: string; tail: string; source: string };
    };
    const live = mocks.publishLiveEvent.mock.calls[0]?.[0] as {
      payload: { details: { prefix: string; tail: string; source: string } };
    };
    const plugin = emit.mock.calls[0]?.[0] as {
      payload: { prefix: string; tail: string; source: string };
    };

    for (const details of [inserted.details, live.payload.details, plugin.payload]) {
      expect(`${details.prefix}${details.tail}`).not.toContain(token);
      expect(details.prefix).toBe("***REDACTED***");
      expect(details.source).toBe("scheduler");
    }
  });

  it("sanitizes a plugin-host message split across scalar activity fields", async () => {
    const token = "plugin-host-activity-secret-value-42";
    const splitAt = 18;
    const previous = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = token;
    const values = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn(() => ({ values })),
    } as unknown as Db;
    const emit = vi.fn().mockResolvedValue({ errors: [] });
    setPluginEventBus({ emit } as any);

    try {
      await logActivity(db, {
        companyId: "company-1",
        actorType: "system",
        actorId: token.slice(splitAt),
        action: token.slice(0, splitAt),
        entityType: `plugin-${token}`,
        entityId: "plugin-1",
        agentId: "agent-1",
        runId: "run-1",
        details: { source: "plugin_host", benign: "preserved" },
      });

      const inserted = values.mock.calls[0]?.[0] as Record<string, unknown>;
      const live = mocks.publishLiveEvent.mock.calls[0]?.[0] as {
        payload: Record<string, unknown>;
      };
      for (const record of [inserted, live.payload]) {
        expect(`${record.action}${record.actorId}`).not.toContain(token);
        expect(JSON.stringify(record)).not.toContain(token);
        expect(JSON.stringify(record)).toContain("***REDACTED***");
        expect(record.agentId).toBe("agent-1");
        expect(record.runId).toBe("run-1");
      }
      expect((inserted.details as Record<string, unknown>).benign).toBe("preserved");
      expect(emit).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previous;
    }
  });

  it("sanitizes plugin rejection errors before logging without exposing hostile accessors", async () => {
    const secret = "plugin-rejection-secret-value-42";
    const splitAt = 17;
    const previous = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = secret;
    const values = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn(() => ({ values })),
    } as unknown as Db;
    const error = {
      name: secret.slice(0, splitAt),
      message: secret.slice(splitAt),
      get stack(): string {
        throw new Error("hostile stack getter");
      },
    };
    const emit = vi.fn().mockResolvedValue({
      errors: [{ pluginId: "plugin-1", error }],
    });
    setPluginEventBus({ emit } as any);

    try {
      await logActivity(db, {
        companyId: "company-1",
        actorType: "system",
        actorId: "system-1",
        action: "issue.created",
        entityType: "issue",
        entityId: "issue-1",
      });

      await vi.waitFor(() => {
        expect(
          mocks.loggerWarn.mock.calls.some(
            (call) => call[1] === "plugin event handler failed",
          ),
        ).toBe(true);
      });

      const logCall = mocks.loggerWarn.mock.calls.find(
        (call) => call[1] === "plugin event handler failed",
      );
      const loggedError = (logCall?.[0] as { err: Record<string, unknown> }).err;
      expect(loggedError === error).toBe(false);
      expect(`${loggedError.name}${loggedError.message}`).not.toContain(secret);
      expect(() => Reflect.get(loggedError, "stack")).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previous;
    }
  });
});
