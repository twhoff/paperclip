import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import {
  buildPaperclipEnv,
  finalizeLocalAdapterEnv,
} from "./server-utils.js";

const agent = { id: "agent-1", companyId: "company-1" };
const agentWithAdapter = { id: "agent-1", companyId: "company-1", adapterType: "copilot_cli" };
const localAgent = {
  id: "ABCDEF12-3456-4789-ABCD-0123456789AB",
  companyId: "company-1",
  adapterType: "codex_local",
};

describe("buildPaperclipEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to localhost when no HOST is set", () => {
    delete process.env.HOST;
    delete process.env.PAPERCLIP_LISTEN_HOST;
    delete process.env.PAPERCLIP_API_URL;
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3100");
  });

  it("uses os.hostname() when HOST is 0.0.0.0 (wildcard bind)", () => {
    delete process.env.PAPERCLIP_LISTEN_HOST;
    delete process.env.PAPERCLIP_API_URL;
    process.env.HOST = "0.0.0.0";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe(`http://${os.hostname()}:3100`);
    expect(env.PAPERCLIP_API_URL).not.toContain("localhost");
  });

  it("uses os.hostname() when HOST is :: (IPv6 wildcard)", () => {
    delete process.env.PAPERCLIP_LISTEN_HOST;
    delete process.env.PAPERCLIP_API_URL;
    process.env.HOST = "::";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe(`http://${os.hostname()}:3100`);
  });

  it("respects explicit PAPERCLIP_API_URL over HOST", () => {
    process.env.HOST = "0.0.0.0";
    process.env.PAPERCLIP_API_URL = "http://100.64.1.2:3100";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe("http://100.64.1.2:3100");
  });

  it("respects PAPERCLIP_LISTEN_HOST over HOST", () => {
    delete process.env.PAPERCLIP_API_URL;
    process.env.HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_HOST = "192.168.1.50";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe("http://192.168.1.50:3100");
  });

  it("uses custom port from PAPERCLIP_LISTEN_PORT", () => {
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_LISTEN_HOST;
    process.env.HOST = "my-machine";
    process.env.PAPERCLIP_LISTEN_PORT = "4200";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe("http://my-machine:4200");
  });

  it("wraps bare IPv6 addresses in brackets", () => {
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_LISTEN_HOST;
    process.env.HOST = "fd12:3456:789a::1";
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_API_URL).toBe("http://[fd12:3456:789a::1]:3100");
  });

  it("always sets PAPERCLIP_AGENT_ID and PAPERCLIP_COMPANY_ID", () => {
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_AGENT_ID).toBe("agent-1");
    expect(env.PAPERCLIP_COMPANY_ID).toBe("company-1");
  });

  it("sets PAPERCLIP_ADAPTER_TYPE when adapterType is provided", () => {
    const env = buildPaperclipEnv(agentWithAdapter);
    expect(env.PAPERCLIP_ADAPTER_TYPE).toBe("copilot_cli");
  });

  it("omits PAPERCLIP_ADAPTER_TYPE when adapterType is absent", () => {
    const env = buildPaperclipEnv(agent);
    expect(env.PAPERCLIP_ADAPTER_TYPE).toBeUndefined();
  });

  it("omits PAPERCLIP_ADAPTER_TYPE when adapterType is null", () => {
    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1", adapterType: null });
    expect(env.PAPERCLIP_ADAPTER_TYPE).toBeUndefined();
  });

  it("derives a canonical Holly session only for local adapters without changing agent ID case", () => {
    process.env.HOLLY_SESSION_ID = "agent-00000000-0000-4000-8000-000000000000";

    const localEnv = buildPaperclipEnv(localAgent);
    const nonLocalEnv = buildPaperclipEnv(agentWithAdapter);

    expect(localEnv.HOLLY_SESSION_ID).toBe(
      "agent-ABCDEF12-3456-4789-ABCD-0123456789AB",
    );
    expect(nonLocalEnv.HOLLY_SESSION_ID).toBeUndefined();
  });

  it("rejects an empty agent ID for a local adapter", () => {
    expect(() =>
      buildPaperclipEnv({ id: "", companyId: "company-1", adapterType: "claude_local" }),
    ).toThrow(/agent ID.*empty/i);
    expect(() =>
      buildPaperclipEnv({ id: " \t ", companyId: "company-1", adapterType: "claude_local" }),
    ).toThrow(/agent ID.*empty/i);
  });
});

describe("finalizeLocalAdapterEnv", () => {
  it("accepts an exactly matching configured Holly session and removes ambient PCLI identity", () => {
    const expected = "agent-ABCDEF12-3456-4789-ABCD-0123456789AB";
    const env = {
      ...buildPaperclipEnv(localAgent),
      HOLLY_SESSION_ID: "agent-00000000-0000-4000-8000-000000000000",
      PCLI_SESSION_ID: "ambient-parent",
      CUSTOM_VALUE: "preserved",
    };

    finalizeLocalAdapterEnv(localAgent, env, { HOLLY_SESSION_ID: expected });

    expect(env).toMatchObject({ HOLLY_SESSION_ID: expected, CUSTOM_VALUE: "preserved" });
    expect(env.PCLI_SESSION_ID).toBeUndefined();
  });

  it("isolates concurrent local environment construction and keeps retries stable", async () => {
    const claudeAgent = {
      id: "00000000-0000-4000-8000-000000000001",
      companyId: "company-1",
      adapterType: "claude_local",
    };
    const codexAgent = {
      id: "00000000-0000-4000-8000-000000000002",
      companyId: "company-1",
      adapterType: "codex_local",
    };
    const prepare = (agent: typeof claudeAgent) =>
      Promise.resolve().then(() => {
        const env: Record<string, string> = {
          ...buildPaperclipEnv(agent),
          PCLI_SESSION_ID: "ambient-parent",
        };
        finalizeLocalAdapterEnv(agent, env, {});
        return env;
      });

    const [claudeEnv, codexEnv] = await Promise.all([prepare(claudeAgent), prepare(codexAgent)]);
    const codexRetryEnv = await prepare(codexAgent);

    expect(claudeEnv.HOLLY_SESSION_ID).toBe(
      "agent-00000000-0000-4000-8000-000000000001",
    );
    expect(codexEnv.HOLLY_SESSION_ID).toBe(
      "agent-00000000-0000-4000-8000-000000000002",
    );
    expect(codexRetryEnv.HOLLY_SESSION_ID).toBe(codexEnv.HOLLY_SESSION_ID);
    expect(claudeEnv.HOLLY_SESSION_ID).not.toBe(codexEnv.HOLLY_SESSION_ID);
    expect(claudeEnv.PCLI_SESSION_ID).toBeUndefined();
    expect(codexEnv.PCLI_SESSION_ID).toBeUndefined();
  });

  it("rejects a conflicting configured Holly session", () => {
    const env = buildPaperclipEnv(localAgent);

    expect(() =>
      finalizeLocalAdapterEnv(localAgent, env, {
        HOLLY_SESSION_ID: "agent-00000000-0000-4000-8000-000000000000",
      }),
    ).toThrow(/HOLLY_SESSION_ID.*does not match/i);
  });

  it("rejects configured PCLI_SESSION_ID even when empty", () => {
    const env = buildPaperclipEnv(localAgent);

    expect(() =>
      finalizeLocalAdapterEnv(localAgent, env, { PCLI_SESSION_ID: "" }),
    ).toThrow(/PCLI_SESSION_ID.*must not be configured/i);
  });

  it("leaves non-local adapter environments unchanged", () => {
    const env = { CUSTOM_VALUE: "preserved", PCLI_SESSION_ID: "existing" };

    finalizeLocalAdapterEnv(agentWithAdapter, env, {
      HOLLY_SESSION_ID: "configured-non-local",
      PCLI_SESSION_ID: "existing",
    });

    expect(env).toEqual({ CUSTOM_VALUE: "preserved", PCLI_SESSION_ID: "existing" });
  });
});
