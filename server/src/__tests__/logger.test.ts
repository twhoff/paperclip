import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  options: null as null | {
    customLogLevel: (req: unknown, res: { statusCode: number }, err?: Error) => string;
    customSuccessMessage: (
      req: { method: string; url: string; originalUrl?: string },
      res: { statusCode: number },
    ) => string;
    customErrorMessage: (
      req: { method: string; url: string; originalUrl?: string },
      res: { statusCode: number },
      err?: Error,
    ) => string;
  },
}));

vi.mock("node:fs", () => ({
  default: { mkdirSync: vi.fn() },
}));

vi.mock("pino", () => {
  const pino = Object.assign(vi.fn(() => ({})), {
    transport: vi.fn(() => ({})),
  });
  return { default: pino };
});

vi.mock("pino-http", () => ({
  pinoHttp: vi.fn((options: typeof captured.options) => {
    captured.options = options;
    return vi.fn();
  }),
}));

vi.mock("../config-file.js", () => ({ readConfigFile: vi.fn(() => null) }));
vi.mock("../home-paths.js", () => ({
  resolveDefaultLogsDir: vi.fn(() => "/test/logs"),
  resolveHomeAwarePath: vi.fn((value: string) => value),
}));

await import("../middleware/logger.js");

function options() {
  if (!captured.options) throw new Error("pino-http options were not captured");
  return captured.options;
}

describe("HTTP request logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses originalUrl in successful request messages after nested routing", () => {
    const message = options().customSuccessMessage(
      { method: "GET", url: "/shutdown", originalUrl: "/api/system/shutdown" },
      { statusCode: 304 },
    );

    expect(message).toBe("GET /api/system/shutdown 304");
  });

  it("uses originalUrl in error request messages after nested routing", () => {
    const message = options().customErrorMessage(
      { method: "POST", url: "/shutdown", originalUrl: "/api/system/shutdown" },
      { statusCode: 500 },
      new Error("boom"),
    );

    expect(message).toBe("POST /api/system/shutdown 500 — boom");
  });

  it("demotes expected shutdown polling 304 responses to debug", () => {
    const level = options().customLogLevel(
      { method: "GET", url: "/shutdown", originalUrl: "/api/system/shutdown" },
      { statusCode: 304 },
    );

    expect(level).toBe("debug");
  });

  it("keeps unrelated 304 responses at info", () => {
    const level = options().customLogLevel(
      { method: "GET", url: "/sidebar-badges", originalUrl: "/api/companies/co-1/sidebar-badges" },
      { statusCode: 304 },
    );

    expect(level).toBe("info");
  });

  it("keeps errors and other client failures at their existing levels", () => {
    expect(
      options().customLogLevel(
        { method: "GET", url: "/shutdown", originalUrl: "/api/system/shutdown" },
        { statusCode: 500 },
      ),
    ).toBe("error");
    expect(
      options().customLogLevel(
        { method: "GET", url: "/shutdown", originalUrl: "/api/system/shutdown" },
        { statusCode: 404 },
      ),
    ).toBe("warn");
  });
});
