import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  collectSensitivePayloadValues,
  redactEventPayload,
  sanitizeRecord,
} from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("fails closed for revoked untrusted secret-value sources", () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();

    expect(() => collectSensitivePayloadValues(proxy)).not.toThrow();
    expect(collectSensitivePayloadValues(proxy)).toEqual({ values: [], overflow: true });
  });

  it("reports overflow rather than returning a silently incomplete secret set", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`apiKey${index}`, `secret-${index}`]),
    );
    let tooDeep: Record<string, unknown> = { apiKey: "deep-secret" };
    for (let depth = 0; depth < 33; depth += 1) tooDeep = { nested: tooDeep };
    const tooManyNodes = Array.from({ length: 4_097 }, (_, index) => ({ safe: index }));

    expect(collectSensitivePayloadValues(tooMany)).toMatchObject({ overflow: true });
    expect(collectSensitivePayloadValues(tooDeep)).toMatchObject({ overflow: true });
    expect(collectSensitivePayloadValues(tooManyNodes)).toMatchObject({ overflow: true });
    expect(collectSensitivePayloadValues({ apiKey: "s".repeat(1024 * 1024 + 1) }))
      .toMatchObject({ overflow: true });
  });

  it("does not charge duplicate secret values against the collection byte budget", () => {
    const repeated = "s".repeat(16 * 1024);
    const result = collectSensitivePayloadValues(
      Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`apiKey${index}`, repeated])),
    );

    expect(result).toEqual({ values: [repeated], overflow: false });
  });

  it("bounds deeply nested payload sanitization without throwing", () => {
    let payload: Record<string, unknown> = { safe: "value" };
    for (let depth = 0; depth < 10_000; depth += 1) payload = { nested: payload };

    expect(() => sanitizeRecord(payload)).not.toThrow();
    expect(sanitizeRecord(payload)).toEqual({ redacted: REDACTED_EVENT_VALUE });
  });

  it("fails closed when credentials are split across sibling values or keys", () => {
    const exactSecret = "approval-secret-abcdef";
    const jwt = "eyJheader.payload.signature_";
    const result = sanitizeRecord({
      apiKey: exactSecret,
      exactPrefix: exactSecret.slice(0, -6),
      exactSuffix: exactSecret.slice(-6),
      jwtPrefix: jwt.slice(0, 1),
      jwtSuffix: jwt.slice(1),
      e: "first",
      [jwt.slice(1)]: "second",
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(exactSecret);
    expect(serialized).not.toContain(exactSecret.slice(0, -6));
    expect(serialized).not.toContain(jwt);
    expect(serialized).toContain(REDACTED_EVENT_VALUE);
  });

  it("fails closed for hostile payload accessors", () => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "safe", {
      enumerable: true,
      get() {
        throw new Error("credential-from-getter");
      },
    });

    expect(() => sanitizeRecord(payload)).not.toThrow();
    expect(JSON.stringify(sanitizeRecord(payload))).not.toContain("credential-from-getter");
  });
});
