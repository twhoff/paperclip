import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  options: null as null | {
    serializers: {
      req: (req: {
        id?: string;
        method: string;
        url: string;
        originalUrl?: string;
      }) => Record<string, unknown>;
    };
    customLogLevel: (req: unknown, res: { statusCode: number }, err?: Error) => string;
    customSuccessMessage: (
      req: { method: string; url: string; originalUrl?: string },
      res: { statusCode: number },
    ) => string;
    customErrorMessage: (
      req: { method: string; url: string; originalUrl?: string; body?: unknown; params?: unknown; query?: unknown },
      res: { statusCode: number },
      err?: Error,
    ) => string;
    customProps: (
      req: { body?: unknown; params?: unknown; query?: unknown; route?: { path?: string } },
      res: { statusCode: number; __errorContext?: unknown },
    ) => Record<string, unknown>;
  },
  transportOptions: null as null | {
    targets: Array<{
      target: string;
      options: Record<string, unknown>;
    }>;
  },
}));

vi.mock("node:fs", () => ({
  default: { mkdirSync: vi.fn() },
}));

vi.mock("pino", () => {
  const pino = Object.assign(vi.fn(() => ({})), {
    transport: vi.fn((options: NonNullable<typeof captured.transportOptions>) => {
      captured.transportOptions = options;
      return {};
    }),
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

const { serverLogFile } = await import("../middleware/logger.js");

function options() {
  if (!captured.options) throw new Error("pino-http options were not captured");
  return captured.options;
}

function transportOptions() {
  if (!captured.transportOptions) {
    throw new Error("pino transport options were not captured");
  }
  return captured.transportOptions;
}

describe("server file logging", () => {
  it("publishes a stable current.log symlink for the active numbered file", () => {
    const fileTarget = transportOptions().targets.find(
      (target) => target.target === "pino-roll",
    );

    expect(serverLogFile).toBe("/test/logs/current.log");
    expect(fileTarget?.options).toMatchObject({
      file: "/test/logs/server.log",
      symlink: true,
    });
  });
});

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

  it("strips arbitrary query values from serialized request logs and messages", () => {
    const credential = "opaque-query-credential-canary-88d1";
    const req = {
      id: "request-1",
      method: "GET",
      url: `/shutdown?diagnostic=${credential}`,
      originalUrl: `/api/system/shutdown?diagnostic=${credential}`,
    };

    const serializedRequest = options().serializers.req(req);
    const message = options().customSuccessMessage(req, { statusCode: 200 });
    const errorProps = options().customProps(
      { ...req, query: { diagnostic: credential } },
      { statusCode: 400 },
    );

    expect(serializedRequest).toMatchObject({
      id: "request-1",
      method: "GET",
      url: "/api/system/shutdown",
    });
    expect(message).toBe("GET /api/system/shutdown 200");
    expect(errorProps.reqQuery).toBe("***REDACTED***");
    expect(JSON.stringify({ serializedRequest, message, errorProps })).not.toContain(credential);
  });

  it.each([
    ["board claim", "/api/board-claim/opaque-board-token-4219/claim?code=secret"],
    ["uppercase board claim", "/API/BOARD-CLAIM/opaque-upper-token-8642/CLAIM?code=secret"],
    ["invite", "/api/invites/opaque-invite-token-7531/onboarding.txt?format=text"],
  ])("redacts opaque %s credentials from request paths", (_kind, originalUrl) => {
    const req = {
      id: "request-token-path",
      method: "GET",
      url: originalUrl,
      originalUrl,
    };

    const serializedRequest = options().serializers.req(req);
    const message = options().customSuccessMessage(req, { statusCode: 200 });

    expect(serializedRequest.url).toContain("***REDACTED***");
    expect(message).toContain("***REDACTED***");
    expect(JSON.stringify({ serializedRequest, message })).not.toMatch(
      /opaque-(?:board|upper|invite)-token/,
    );
    expect(JSON.stringify({ serializedRequest, message })).not.toContain("secret");
  });

  it("redacts generic JWTs and current secrets from arbitrary request paths", () => {
    const previous = process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN;
    const exactSecret = "current-provider-path-secret-9471";
    const jwt = "eyJheader.payload.signature_with-hyphen_";
    process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN = exactSecret;

    try {
      for (const pathCredential of [jwt, exactSecret]) {
        const originalUrl = `/api/missing/${pathCredential}?ignored=value`;
        const req = { id: "request-path", method: "GET", url: originalUrl, originalUrl };
        const serializedRequest = options().serializers.req(req);
        const message = options().customSuccessMessage(req, { statusCode: 404 });

        expect(JSON.stringify({ serializedRequest, message })).not.toContain(pathCredential);
        expect(serializedRequest.url).toContain("***REDACTED***");
      }
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN;
      else process.env.PAPERCLIP_MODEL_PROVIDER_TOKEN = previous;
    }
  });

  it("redacts request credentials from direct error logs without error-handler context", () => {
    const credential = "provider-key-direct-error-canary-3b81";
    const req = {
      method: "POST",
      url: "/test-environment",
      originalUrl: "/api/companies/company-1/adapters/missing/test-environment",
      body: { adapterConfig: { apiKey: credential } },
      params: { type: "missing" },
      query: { diagnostic: credential },
    };
    const res = { statusCode: 404 };

    const props = options().customProps(req, res);
    const message = options().customErrorMessage(
      req,
      res,
      new Error(`provider probe failed: ${credential}`),
    );

    expect(JSON.stringify({ props, message })).not.toContain(credential);
    expect((props.reqBody as any).adapterConfig.apiKey).toBe("***REDACTED***");
    expect(message).toContain("***REDACTED***");
  });

  it("cannot reconstruct a JWT split across direct request log fields", () => {
    const credential = "eyJheader.payload.signature_";
    const req = {
      method: "POST",
      url: "/test-environment",
      originalUrl: "/api/companies/company-1/adapters/missing/test-environment",
      body: {
        first: "eyJheader.",
        second: "payload.signature_",
      },
      params: {},
      query: {},
    };

    const props = options().customProps(req, { statusCode: 400 });
    const body = props.reqBody as { first: string; second: string };
    const reconstruction = `${body.first}${body.second}`;

    expect(reconstruction).not.toContain(credential);
    expect(JSON.stringify(body)).toContain("***REDACTED***");
  });

  it("strictly isolates request diagnostics across separate log records", () => {
    const token = "eyJlogs.separate.signature_";
    const first = options().customProps({
      method: "POST",
      url: "/test",
      originalUrl: "/api/test",
      body: { piece: token.slice(0, 1) },
      params: {},
      query: {},
    }, { statusCode: 400 });
    const second = options().customProps({
      method: "POST",
      url: "/test",
      originalUrl: "/api/test",
      body: { piece: token.slice(1) },
      params: {},
      query: {},
    }, { statusCode: 400 });

    expect(`${(first.reqBody as any).piece}${(second.reqBody as any).piece}`)
      .not.toContain(token);
    expect(JSON.stringify(first)).toContain("***REDACTED***");
  });

  it("cross-redacts error messages with request fields in one emitted record", () => {
    const req = {
      method: "POST",
      url: "/test-environment",
      originalUrl: "/api/test-environment",
      body: { continuation: "yJheader.payload.signature_" },
      params: {},
      query: {},
    };
    const res = { statusCode: 500 };

    const message = options().customErrorMessage(req, res, new Error("e"));
    const props = options().customProps(req, res);

    expect(`${message}${(props.reqBody as any).continuation}`).not.toContain(
      "eyJheader.payload.signature_",
    );
    expect(JSON.stringify({ message, props })).toContain("***REDACTED***");
  });

  it("bounds cyclic request values before emitting error properties", () => {
    const body: Record<string, unknown> = { value: "safe" };
    body.self = body;
    const req = {
      method: "POST",
      url: "/test",
      originalUrl: "/api/test",
      body,
      params: {},
      query: {},
    };

    const props = options().customProps(req, { statusCode: 400 });

    expect(() => JSON.stringify(props)).not.toThrow();
    expect(JSON.stringify(props)).toContain("***REDACTED***");
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
